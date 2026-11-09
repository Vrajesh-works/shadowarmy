// The `judge` job of order.yml runs after the Knight. Everything the knight
// job produced is untrusted, so it validates review.json here, posts the
// review on the pull request, and decides what happens next
// (behavior contract sections 9 and 10):
//
//   changes  -> fix round (a new run, dispatched) or needs-decision when the
//               rounds are used up
//   approve  -> wait for the target's CI in this job:
//               green or no CI -> ready-to-merge (minor findings in the PR body)
//               failing        -> fix round, or needs-decision when rounds are used up
//               still pending  -> needs-decision at ci.max_wait_minutes (the Sentinel
//                                 takes over long waits from milestone 3)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { waitForChecks, type CheckResult } from "../ci.ts";
import type { Config } from "../config.ts";
import type { OrderEvent } from "../event.ts";
import { repoPath, type GitHubClient } from "../github.ts";
import { parseOrderForm } from "../issueForm.ts";
import { blocking, checkKnightReview, minor, renderReviewBody, type Finding } from "../knightReview.ts";
import { renderPullRequestBody } from "../prBody.ts";
import { RealmIssue } from "../realmIssue.ts";
import { checkSoldierResult } from "../soldierResult.ts";
import type { RunConclusion, StateBlock, StatusLink } from "../statusComment.ts";
import { configProblem, errorText, loadRealmConfig, newState, report, reportFailure, runLink, type RunInfo } from "./context.ts";
import { MAX_IN_JOB_CI_WAIT_MINUTES } from "./gate.ts";

export interface JudgeInput {
  event: OrderEvent;
  realmClient: GitHubClient;
  targetClient: GitHubClient;
  realmDir: string;
  /** The downloaded knight artifact: review.json, claude.json. */
  knightDir: string;
  /** The downloaded soldier artifact, for the pull request body. */
  soldierDir: string;
  /** needs.knight.result. */
  knightJob: string;
  /** github.workflow_ref of the Realm's caller workflow, for dispatching fix rounds. */
  workflowRef: string;
  run: RunInfo;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** How long to wait for a first check before concluding the target has no CI. */
  ciGraceMs?: number;
  ciPollMs?: number;
  log: (line: string) => void;
}

class StepFailure extends Error {
  readonly step: string;
  constructor(step: string, reason: string) {
    super(reason);
    this.step = step;
  }
}

function readOptional(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function conclusionOf(job: string): RunConclusion | null {
  return job === "success" || job === "failure" || job === "cancelled" || job === "skipped" ? job : null;
}

function missingReview(knightDir: string, knightJob: string, cfg: Config): string {
  let subtype = "";
  try {
    const claude = JSON.parse(readOptional(join(knightDir, "claude.json")) ?? "{}") as { subtype?: unknown };
    if (typeof claude.subtype === "string") subtype = claude.subtype;
  } catch {
    // Unreadable; ignore.
  }
  if (subtype === "error_max_turns") return `The Knight used all ${String(cfg.limits.max_turns)} turns (limits.max_turns) before writing its review.`;
  if (knightJob === "cancelled" || knightJob === "failure") {
    return `The knight job ended with "${knightJob}" before the Knight wrote its review (it may have hit limits.run_timeout_minutes = ${String(cfg.limits.run_timeout_minutes)}).`;
  }
  return "The Knight did not write review.json.";
}

/** `owner/realm/.github/workflows/order.yml@refs/heads/main` -> workflow file and ref to dispatch. */
export function parseWorkflowRef(workflowRef: string): { file: string; ref: string } | null {
  const match = /^[^/]+\/[^/]+\/\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)@(refs\/heads\/[A-Za-z0-9._/+-]+)$/.exec(workflowRef);
  return match?.[1] !== undefined && match[2] !== undefined ? { file: match[1], ref: match[2] } : null;
}

export async function runJudge(input: JudgeInput): Promise<void> {
  const { event, run } = input;
  const [owner = "", repo = ""] = event.repository.fullName.split("/");
  const issue = new RealmIssue(input.realmClient, event.repository.fullName, event.issue.number);

  let state: StateBlock = newState(null, null);
  try {
    state = (await issue.readState()) ?? state;
  } catch (error) {
    await reportFailure(issue, run, state, "read status", (error as Error).message);
    return;
  }
  state = { ...state, runs: [...state.runs, { role: "knight" as const, runId: run.runId, conclusion: conclusionOf(input.knightJob) }].slice(-200) };

  try {
    const config = loadRealmConfig(input.realmDir, { owner, repo });
    if (!config.ok) throw new StepFailure("load configuration", configProblem(config));
    const cfg = config.config;
    const form = parseOrderForm(event.issue.body);
    if (!form.ok) throw new StepFailure("read order", "The issue no longer matches the Order form.");
    const target = form.value.target;
    if (state.pr === null || state.branch === null) throw new StepFailure("review", "The status comment does not record the pull request.");
    const pr = state.pr;

    const checked = checkKnightReview(readOptional(join(input.knightDir, "review.json")));
    if (!checked.ok) {
      const missing = !existsSync(join(input.knightDir, "review.json"));
      throw new StepFailure("validate review", missing ? missingReview(input.knightDir, input.knightJob, cfg) : checked.reason);
    }
    const review = checked.review;

    const pull = await input.targetClient.request<{ html_url: string; head: { sha: string; ref: string } }>(
      "GET",
      `/repos/${repoPath(target)}/pulls/${String(pr)}`,
    );
    if (pull.head.ref !== state.branch) throw new StepFailure("review", `Pull request #${String(pr)} no longer uses ${state.branch}.`);
    const head = pull.head.sha;
    const prLink: StatusLink = { label: `Pull request #${String(pr)}`, url: pull.html_url };
    const injection = review.injectionNoticed ? ["The Knight noticed instructions in its inputs and ignored them."] : [];

    // A comment-type review never approves in GitHub's sense, so it never satisfies branch protection.
    await input.targetClient.request("POST", `/repos/${repoPath(target)}/pulls/${String(pr)}/reviews`, {
      commit_id: head,
      event: "COMMENT",
      body: renderReviewBody(review, state.round),
    });

    if (review.verdict === "changes") {
      await nextRound(input, cfg, issue, state, prLink, `the Knight requested changes: ${review.summary}`, blocking(review), [], injection);
      return;
    }

    state = { ...state, ciWaitStartedAt: input.now().toISOString() };
    const waitMinutes = Math.min(cfg.ci.max_wait_minutes, MAX_IN_JOB_CI_WAIT_MINUTES);
    await issue.writeStatus(
      {
        state: "in-review",
        summary: `The Knight approved pull request #${String(pr)}. Waiting up to ${String(waitMinutes)} minutes for the target repository's CI.`,
        details: [review.summary, ...injection],
        links: [prLink, runLink(run)],
      },
      state,
    );
    const ci = await waitForChecks(input.targetClient, target, head, {
      deadline: new Date(input.now().getTime() + waitMinutes * 60_000),
      graceMs: input.ciGraceMs ?? 120_000,
      pollMs: input.ciPollMs ?? 30_000,
      now: input.now,
      sleep: input.sleep,
    });
    state = { ...state, ciWaitStartedAt: null };

    if (ci.kind === "failing") {
      const failed = ci.checks.filter((check) => check.state === "failed");
      await nextRound(input, cfg, issue, state, prLink, `the target repository's CI fails: ${failed.map((check) => check.name).join(", ")}`, [], failed, injection);
      return;
    }
    if (ci.kind === "pending") {
      const pending = ci.checks.filter((check) => check.state === "pending").map((check) => check.name);
      await report(
        issue,
        "needs-decision",
        {
          summary: `The Knight approved pull request #${String(pr)}, but the target repository's CI did not finish within ${String(waitMinutes)} minutes.`,
          details: [`Still running: ${pending.join(", ")}`],
          question: "Check the pull request's CI. If it passes, review and merge the pull request yourself; if it fails, add the arise label to start the order again.",
          links: [prLink, runLink(run)],
        },
        state,
      );
      return;
    }

    await updatePullRequestBody(input, cfg, target, pr, minor(review));
    const noCi = ci.kind === "none";
    await report(
      issue,
      "ready-to-merge",
      {
        summary: `Pull request #${String(pr)} in ${target} is ready for your review: the Knight approved it${noCi ? "" : " and CI passes"}.`,
        details: [
          review.summary,
          ...(noCi ? ["No CI in target repository; verification is the Soldier's reported checks only."] : []),
          ...(minor(review).length > 0 ? [`${String(minor(review).length)} minor finding(s) are listed in the pull request.`] : []),
          ...injection,
        ],
        links: [prLink, runLink(run)],
      },
      state,
    );
  } catch (error) {
    if (error instanceof StepFailure) {
      await reportFailure(issue, run, state, error.step, error.message);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await reportFailure(issue, run, { ...state, lastError: errorText(message) }, "judge", message);
    throw error;
  }
}

/** Start the next fix round, or hand the order to the Monarch when the rounds are used up. */
async function nextRound(
  input: JudgeInput,
  cfg: Config,
  issue: RealmIssue,
  state: StateBlock,
  prLink: StatusLink,
  why: string,
  findings: Finding[],
  failedChecks: CheckResult[],
  extra: string[],
): Promise<void> {
  const remaining = [
    ...findings.map((finding) => `${finding.severity} ${finding.file}${finding.line === null ? "" : `:${String(finding.line)}`}: ${finding.problem}`),
    ...failedChecks.map((check) => `failing check: ${check.name} (${check.conclusion})`),
  ];
  if (state.round >= cfg.limits.max_fix_rounds) {
    await report(
      issue,
      "needs-decision",
      {
        summary: `The fix rounds are used up (limits.max_fix_rounds = ${String(cfg.limits.max_fix_rounds)}), and ${why}`,
        details: remaining,
        question:
          "Decide how to continue: fix the remaining points on the pull request branch yourself and merge, close the pull request, or edit the task and add the arise label to start the order again.",
        links: [prLink, runLink(input.run)],
      },
      state,
    );
    return;
  }

  const target = parseWorkflowRef(input.workflowRef);
  if (target === null) throw new StepFailure("start fix round", `Cannot dispatch a fix round from workflow ${input.workflowRef}.`);
  const next: StateBlock = { ...state, round: state.round + 1 };
  await report(
    issue,
    "in-progress",
    {
      summary: `Fix round ${String(next.round)} of ${String(cfg.limits.max_fix_rounds)} is starting because ${why}`,
      details: [...remaining, ...extra],
      links: [prLink, runLink(input.run)],
    },
    next,
  );
  // workflow_dispatch from the Realm's GITHUB_TOKEN starts a new run; the run is
  // queued behind this one by the per-issue concurrency group.
  await input.realmClient.request("POST", `/repos/${repoPath(input.event.repository.fullName)}/actions/workflows/${target.file}/dispatches`, {
    ref: target.ref,
    inputs: { issue: String(input.event.issue.number) },
  });
}

async function updatePullRequestBody(input: JudgeInput, cfg: Config, target: string, pr: number, minorFindings: Finding[]): Promise<void> {
  const result = checkSoldierResult(readOptional(join(input.soldierDir, "result.json")));
  if (!result.ok) {
    input.log(`Kept the pull request body: ${result.reason}`);
    return;
  }
  const repoInfo = await input.targetClient.request<{ private: boolean }>("GET", `/repos/${repoPath(target)}`);
  const body = renderPullRequestBody(
    result.result,
    {
      issue: input.event.issue.number,
      realm: input.event.repository.fullName,
      linkRealm: repoInfo.private || cfg.pr.link_realm,
      serverUrl: input.run.serverUrl,
    },
    minorFindings,
  );
  await input.targetClient.request("PATCH", `/repos/${repoPath(target)}/pulls/${String(pr)}`, { body });
}
