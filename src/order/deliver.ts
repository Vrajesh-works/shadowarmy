// The `deliver` job of order.yml. Everything the soldier job produced is
// untrusted (the agent could have changed any file on that runner), so this
// job re-checks it all: it validates result.json, applies the patch to a fresh
// checkout of the base commit, runs the diff guard, then commits, pushes the
// task branch and opens or updates the pull request.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { checkDiff, MARKER, parseRawDiff, type ChangedFile } from "../diffGuard.ts";
import type { IssueLabeledEvent } from "../event.ts";
import { git, GitError } from "../git.ts";
import { GitHubError, repoPath, type GitHubClient } from "../github.ts";
import { parseOrderForm } from "../issueForm.ts";
import { isTaskBranch, taskBranchName, isSafeBranchName } from "../names.ts";
import { renderCommitMessage, renderPullRequestBody } from "../prBody.ts";
import { RealmIssue } from "../realmIssue.ts";
import { checkSoldierResult, type SoldierResult } from "../soldierResult.ts";
import type { RunConclusion, StateBlock } from "../statusComment.ts";
import { configProblem, errorText, loadRealmConfig, newState, report, reportFailure, runLink, type RunInfo } from "./context.ts";

/** A patch larger than this is rejected before it is applied. */
export const MAX_PATCH_BYTES = 200 * 1024 * 1024;

export interface DeliverInput {
  event: IssueLabeledEvent;
  realmClient: GitHubClient;
  targetClient: GitHubClient;
  githubToken: string;
  realmDir: string;
  /** The downloaded soldier artifact: result.json, changes.patch, claude.json. */
  soldierDir: string;
  /** needs.soldier.result: success, failure, cancelled or skipped. */
  soldierJob: string;
  /** The base commit and branch the gate job fetched (trusted: no agent ran there). */
  baseSha: string;
  baseRef: string;
  workDir: string;
  run: RunInfo;
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

/** Why the soldier job produced no usable result, from what it recorded (untrusted, so only used to pick a message). */
export function explainMissingResult(soldierDir: string, soldierJob: string, config: Config): string {
  let subtype = "";
  try {
    const claude = JSON.parse(readOptional(join(soldierDir, "claude.json")) ?? "{}") as { subtype?: unknown };
    if (typeof claude.subtype === "string") subtype = claude.subtype;
  } catch {
    // Unreadable; ignore.
  }
  if (subtype === "error_max_turns") {
    return `The Soldier used all ${String(config.limits.max_turns)} turns (limits.max_turns) before writing its result.`;
  }
  if (soldierJob === "cancelled" || soldierJob === "failure") {
    return `The soldier job ended with "${soldierJob}" before the Soldier wrote its result (it may have hit limits.run_timeout_minutes = ${String(config.limits.run_timeout_minutes)}).`;
  }
  return "The Soldier did not write result.json.";
}

export async function runDeliver(input: DeliverInput): Promise<void> {
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
  state = { ...state, runs: [...state.runs, { role: "soldier" as const, runId: run.runId, conclusion: conclusionOf(input.soldierJob) }].slice(-200) };

  try {
    const config = loadRealmConfig(input.realmDir, { owner, repo });
    if (!config.ok) throw new StepFailure("load configuration", configProblem(config));
    const form = parseOrderForm(event.issue.body);
    if (!form.ok) throw new StepFailure("read order", "The issue no longer matches the Order form.");
    const order = form.value;
    const cfg = config.config;

    const checked = checkSoldierResult(readOptional(join(input.soldierDir, "result.json")));
    if (!checked.ok) {
      const missing = !existsSync(join(input.soldierDir, "result.json"));
      throw new StepFailure(
        "validate result",
        missing ? explainMissingResult(input.soldierDir, input.soldierJob, cfg) : checked.reason,
      );
    }
    const result = checked.result;
    const injection = result.injectionNoticed ? ["The Soldier noticed instructions in its inputs and ignored them."] : [];

    if (result.status === "failed") {
      throw new StepFailure("soldier", `The Soldier could not complete the task: ${result.summary}`);
    }
    if (result.status === "blocked") {
      await report(
        issue,
        "needs-decision",
        {
          summary: "The Soldier needs your decision before it can continue.",
          details: [result.summary, ...injection],
          question: `${result.question ?? ""}\n\nAnswering with /answer arrives in milestone 3. For now, edit the task in the issue body and add the arise label again.`,
          links: [runLink(run)],
        },
        state,
      );
      return;
    }

    if (!isSafeBranchName(input.baseRef) || !/^[0-9a-f]{40}$/.test(input.baseSha)) {
      throw new StepFailure("check out target", "The gate job did not record the base commit.");
    }
    const branch = state.branch ?? taskBranchName(event.issue.number, event.issue.title);
    if (!isTaskBranch(branch)) throw new StepFailure("push", `Refusing to push to "${branch}": not a shadowarmy/* task branch.`);

    const delivered = await deliverChange(input, cfg, order.target, order.task, result, branch);
    state = { ...state, branch, pr: delivered.number, lastError: null };
    await report(
      issue,
      "ready-to-merge",
      {
        summary: `Pull request #${String(delivered.number)} in ${order.target} is ready for your review.`,
        details: [
          result.title,
          "Not reviewed by a Knight yet (milestone 2). Review the change yourself before merging.",
          ...delivered.notes,
          ...injection,
        ],
        links: [{ label: `Pull request #${String(delivered.number)}`, url: delivered.url }, runLink(run)],
      },
      state,
    );
  } catch (error) {
    if (error instanceof StepFailure) {
      await reportFailure(issue, run, state, error.step, error.message);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await reportFailure(issue, run, { ...state, lastError: errorText(message) }, "deliver", message);
    throw error;
  }
}

interface Delivered {
  number: number;
  url: string;
  notes: string[];
}

async function deliverChange(
  input: DeliverInput,
  cfg: Config,
  target: string,
  orderText: string,
  result: SoldierResult,
  branch: string,
): Promise<Delivered> {
  const patchPath = join(input.soldierDir, "changes.patch");
  const patchSize = existsSync(patchPath) ? statSync(patchPath).size : 0;
  if (patchSize === 0) throw new StepFailure("apply change", "The Soldier reported done but produced no changes.");
  if (patchSize > MAX_PATCH_BYTES) throw new StepFailure("apply change", "The change is larger than 200 MB.");

  const dir = join(input.workDir, "target");
  mkdirSync(dir, { recursive: true });
  const token = input.githubToken;
  const serverUrl = input.run.serverUrl;
  const run = (args: string[], options: { auth?: boolean; env?: Record<string, string> } = {}) =>
    git(args, { cwd: dir, serverUrl, ...(options.auth === true ? { token } : {}), env: { GIT_LITERAL_PATHSPECS: "1", ...options.env } });

  try {
    await run(["init", "--quiet"]);
    await run(["remote", "add", "origin", `${serverUrl}/${target}.git`]);
    await run(["fetch", "--quiet", "--depth=1", "origin", input.baseSha], { auth: true });
    await run(["checkout", "--quiet", "-b", branch, input.baseSha]);
    await run(["apply", "--index", "--binary", "--whitespace=nowarn", patchPath]);
  } catch (error) {
    throw new StepFailure("apply change", error instanceof GitError ? error.message : String(error));
  }

  const files: ChangedFile[] = parseRawDiff(await run(["diff", "--cached", "--raw", "-z", "-M", "--no-abbrev", input.baseSha]));
  if (files.length === 0) throw new StepFailure("apply change", "The Soldier reported done but produced no changes.");
  const present = files.filter((file) => file.status !== "D").map((file) => file.path);
  const marked = new Set<string>();
  if (present.length > 0) {
    const grep = await run(["grep", "--cached", "-z", "-l", "-F", "-I", "-e", MARKER, "--", ...present]).catch((error: unknown) => {
      // git grep exits 1 when nothing matches.
      if (error instanceof GitError && error.code === 1) return "";
      throw error;
    });
    for (const path of grep.split("\0")) if (path !== "") marked.add(path);
  }
  for (const file of files) {
    if (file.status === "D" || file.mode === "160000") continue;
    file.size = Number((await run(["cat-file", "-s", file.blob ?? ""])).trim());
    file.hasMarker = marked.has(file.path);
  }

  const guard = checkDiff({ files, orderText, maxFileSizeMb: cfg.limits.max_file_size_mb });
  if (!guard.ok) {
    throw new StepFailure(
      "diff guard",
      `The change touches paths the engine never pushes without an explicit request in the order:\n${guard.violations
        .map((violation) => `${violation.path}: ${violation.reason}`)
        .join("\n")}`,
    );
  }

  const author = /^(.+) <([^<>]+)>$/.exec(cfg.git.author);
  const [, name = "shadowarmy", email = "shadowarmy@users.noreply.github.com"] = author ?? [];
  const messagePath = join(input.workDir, "commit-message.txt");
  writeFileSync(messagePath, renderCommitMessage(result));
  await run(["commit", "--quiet", "--no-verify", "-F", messagePath], {
    env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
  });

  // Push only the task branch. A leftover branch from an earlier attempt of this
  // same order is replaced, but only if it still points where we last saw it.
  const remote = (await run(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], { auth: true })).trim();
  const expected = remote === "" ? "" : (remote.split(/\s+/)[0] ?? "");
  try {
    await run(["push", "--quiet", `--force-with-lease=refs/heads/${branch}:${expected}`, "origin", `HEAD:refs/heads/${branch}`], { auth: true });
  } catch (error) {
    throw new StepFailure(
      "push",
      `${error instanceof Error ? error.message : String(error)}\nCheck that SHADOWARMY_GH_TOKEN has Contents: read and write on ${target}.`,
    );
  }

  const repoInfo = await input.targetClient.request<{ private: boolean }>("GET", `/repos/${repoPath(target)}`);
  const body = renderPullRequestBody(result, {
    issue: input.event.issue.number,
    realm: input.event.repository.fullName,
    linkRealm: repoInfo.private || cfg.pr.link_realm,
    serverUrl,
  });
  const notes = guard.exceptions.length > 0 ? [`Allowed because the order names them: ${guard.exceptions.join(", ")}.`] : [];
  return { ...(await openOrUpdatePullRequest(input.targetClient, target, branch, input.baseRef, result.title, body, cfg.pr.draft)), notes };
}

async function openOrUpdatePullRequest(
  client: GitHubClient,
  target: string,
  branch: string,
  base: string,
  title: string,
  body: string,
  draft: boolean,
): Promise<{ number: number; url: string }> {
  const [owner = ""] = target.split("/");
  const path = `/repos/${repoPath(target)}/pulls`;
  try {
    const open = await client.request<{ number: number; html_url: string }[]>(
      "GET",
      `${path}?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    );
    const existing = open[0];
    if (existing !== undefined) {
      await client.request("PATCH", `${path}/${String(existing.number)}`, { title, body });
      return { number: existing.number, url: existing.html_url };
    }
    const created = await client.request<{ number: number; html_url: string }>("POST", path, { title, body, head: branch, base, draft });
    return { number: created.number, url: created.html_url };
  } catch (error) {
    const hint = error instanceof GitHubError && (error.status === 403 || error.status === 404)
      ? `\nCheck that SHADOWARMY_GH_TOKEN has Pull requests: read and write on ${target}.`
      : "";
    throw new StepFailure("open pull request", `${error instanceof Error ? error.message : String(error)}${hint}`);
  }
}
