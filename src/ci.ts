// Target repository CI (behavior contract section 10): read the checks of a
// commit, wait for them, and collect failure excerpts for a fix round.
// Both check runs (GitHub Actions and other apps) and legacy commit statuses
// count. Every completed check that did not pass counts as failing; the engine
// cannot read which checks branch protection requires without admin access.

import { GitHubError, repoPath, type GitHubClient } from "./github.ts";

export interface CheckResult {
  name: string;
  state: "pending" | "passed" | "failed";
  /** GitHub's conclusion or status state, for messages. */
  conclusion: string;
  url: string | null;
  /** For GitHub Actions check runs: the job id, whose log can be downloaded. */
  jobId: number | null;
  /** Text the check reported itself (check run output), if any. */
  output: string;
}

export type CiStatus =
  | { kind: "none" }
  | { kind: "pending"; checks: CheckResult[] }
  | { kind: "failing"; checks: CheckResult[] }
  | { kind: "passing"; checks: CheckResult[] };

interface CheckRunJson {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  details_url?: string | null;
  app?: { slug?: string } | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null } | null;
}

interface StatusJson {
  context: string;
  state: string;
  description?: string | null;
  target_url?: string | null;
}

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export function classifyCheckRun(run: CheckRunJson): CheckResult {
  const completed = run.status === "completed";
  const conclusion = run.conclusion ?? run.status;
  const output = [run.output?.title, run.output?.summary, run.output?.text].filter((part): part is string => typeof part === "string" && part !== "").join("\n");
  return {
    name: run.name,
    state: !completed ? "pending" : PASSING_CONCLUSIONS.has(conclusion) ? "passed" : "failed",
    conclusion,
    url: run.html_url ?? run.details_url ?? null,
    jobId: run.app?.slug === "github-actions" ? run.id : null,
    output,
  };
}

export function classifyStatus(status: StatusJson): CheckResult {
  return {
    name: status.context,
    state: status.state === "pending" ? "pending" : status.state === "success" ? "passed" : "failed",
    conclusion: status.state,
    url: status.target_url ?? null,
    jobId: null,
    output: status.description ?? "",
  };
}

export function summarize(checks: CheckResult[]): CiStatus {
  if (checks.length === 0) return { kind: "none" };
  if (checks.some((check) => check.state === "pending")) return { kind: "pending", checks };
  if (checks.some((check) => check.state === "failed")) return { kind: "failing", checks };
  return { kind: "passing", checks };
}

interface WorkflowRunJson {
  id: number;
}

interface JobJson {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
}

/**
 * GitHub Actions jobs for `sha`, as checks. Used when the token cannot list
 * check runs: GitHub documents no check-runs permission for fine-grained
 * personal access tokens, while Actions: read covers workflow runs and jobs.
 */
async function readActionsJobs(client: GitHubClient, target: string, sha: string): Promise<CheckResult[]> {
  const runs = await client.paginate<WorkflowRunJson>(`/repos/${repoPath(target)}/actions/runs?head_sha=${sha}`, 3);
  const checks: CheckResult[] = [];
  for (const run of runs) {
    const jobs = await client.paginate<JobJson>(`/repos/${repoPath(target)}/actions/runs/${String(run.id)}/jobs?filter=latest`, 3);
    for (const job of jobs) {
      checks.push(classifyCheckRun({ ...job, app: { slug: "github-actions" } }));
    }
  }
  return checks;
}

/** All checks reported for `sha`: check runs (or, without access to them, GitHub Actions jobs) and commit statuses. */
export async function readChecks(client: GitHubClient, target: string, sha: string): Promise<CheckResult[]> {
  let runs: CheckResult[];
  try {
    runs = (await client.paginate<CheckRunJson>(`/repos/${repoPath(target)}/commits/${sha}/check-runs?filter=latest`, 5)).map(classifyCheckRun);
  } catch (error) {
    if (!(error instanceof GitHubError) || (error.status !== 403 && error.status !== 404)) throw error;
    runs = await readActionsJobs(client, target, sha);
  }
  const combined = await client.request<{ statuses?: StatusJson[] }>("GET", `/repos/${repoPath(target)}/commits/${sha}/status`);
  return [...runs, ...(combined.statuses ?? []).map(classifyStatus)];
}

export interface WaitOptions {
  /** Stop waiting at this time and report what is still pending. */
  deadline: Date;
  /** How long to wait for a first check to appear before concluding there is no CI. */
  graceMs: number;
  pollMs: number;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

/** Poll the checks of `sha` until none is pending, the grace period passes without any check, or the deadline. */
export async function waitForChecks(client: GitHubClient, target: string, sha: string, options: WaitOptions): Promise<CiStatus> {
  const started = options.now().getTime();
  for (;;) {
    const status = summarize(await readChecks(client, target, sha));
    const now = options.now().getTime();
    if (status.kind === "failing" || status.kind === "passing") return status;
    if (status.kind === "none" && now - started >= options.graceMs) return status;
    if (now >= options.deadline.getTime()) return status;
    await options.sleep(Math.min(options.pollMs, Math.max(0, options.deadline.getTime() - now)));
  }
}

/** Remove timestamps and ANSI colour codes from GitHub Actions log lines. */
export function cleanLogLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;]*m/g, "").replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/, "");
}

/** The last `lines` lines of a failed check: its job log for GitHub Actions, otherwise what the check reported. */
export async function failureExcerpt(client: GitHubClient, target: string, check: CheckResult, lines: number): Promise<string> {
  let text = check.output;
  if (check.jobId !== null) {
    try {
      text = await client.requestText(`/repos/${repoPath(target)}/actions/jobs/${String(check.jobId)}/logs`);
    } catch {
      // Logs can be unavailable (expired, or no Actions read access); fall back to the check's own output.
    }
  }
  const all = text.replace(/\r\n?/g, "\n").split("\n").map(cleanLogLine);
  while (all.length > 0 && all.at(-1)?.trim() === "") all.pop();
  return all.slice(-lines).join("\n");
}
