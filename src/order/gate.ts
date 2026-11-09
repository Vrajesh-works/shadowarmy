// The `gate` job of order.yml: decides whether an `arise` event starts work.
// Order of checks (functional-diagrams/actions/single-task-order.md):
// sender is the Monarch -> config valid -> order form valid -> target allowed
// -> credentials present -> daily cap -> fetch the target. Anything from a
// non-Monarch account changes nothing. The gate fetches the target with
// SHADOWARMY_GH_TOKEN and packs it for the soldier job, so that token never
// reaches the job that runs the agent.

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { checkTarget } from "../config.ts";
import type { IssueLabeledEvent } from "../event.ts";
import { git, GitError } from "../git.ts";
import type { GitHubClient } from "../github.ts";
import { writeSoldierInputs } from "../inputs.ts";
import { canTransition, readState, TRIGGER_LABEL } from "../labels.ts";
import { countAgentRuns, startOfDay } from "../limits.ts";
import { isSafeBranchName, taskBranchName } from "../names.ts";
import { parseOrderForm } from "../issueForm.ts";
import { RealmIssue } from "../realmIssue.ts";
import { formatIssues } from "../schema.ts";
import type { StateBlock } from "../statusComment.ts";
import { configProblem, loadRealmConfig, newState, report, reportFailure, runLink, type RunInfo } from "./context.ts";

export const FAKE_AGENT_SCENARIOS = ["add-file", "edit-claude-md", "no-changes", "blocked", "invalid-result"] as const;

export interface GateInput {
  event: IssueLabeledEvent;
  client: GitHubClient;
  realmDir: string;
  engineDir: string;
  inputsDir: string;
  /** An empty folder for the target checkout. */
  workDir: string;
  run: RunInfo;
  hasClaudeCredential: boolean;
  /** SHADOWARMY_GH_TOKEN; empty when the secret is unset. */
  githubToken: string;
  /** The Realm variable SHADOWARMY_FAKE_AGENT; empty when unset. */
  fakeAgent: string;
  now: Date;
  log: (line: string) => void;
  /** Called as soon as the sender is known to be the Monarch, before any change is made. */
  onAuthorized: () => void;
}

export interface GateOutput {
  proceed: boolean;
  target?: string;
  baseRef?: string;
  baseSha?: string;
  model?: string;
  maxTurns?: number;
  timeoutMinutes?: number;
  fakeAgent?: string;
}

const STOP: GateOutput = { proceed: false };

export async function runGate(input: GateInput): Promise<GateOutput> {
  const { event, log, run } = input;
  if (event.label !== TRIGGER_LABEL) {
    log(`Ignored: label "${event.label}" is not ${TRIGGER_LABEL}.`);
    return STOP;
  }
  const [owner = "", repo = ""] = event.repository.fullName.split("/");
  const realm = { owner, repo };
  const issue = new RealmIssue(input.client, event.repository.fullName, event.issue.number);
  const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  const config = loadRealmConfig(input.realmDir, realm);
  // Without a valid config the Monarch is the Realm owner (the documented default).
  const monarch = config.ok ? config.config.monarch : event.repository.owner;
  if (!sameLogin(event.sender, monarch)) {
    const why = config.ok ? `(${monarch}). Nothing was changed.` : "(shadowarmy.yml is invalid; the Realm owner is the Monarch).";
    log(`Ignored: ${event.sender} is not the Monarch ${why}`);
    return STOP;
  }
  input.onAuthorized();

  let previous: StateBlock | null = null;
  try {
    previous = await issue.readState();
  } catch (error) {
    log(`The previous status comment is unreadable and will be replaced: ${(error as Error).message}`);
  }
  const keepRuns = (state: StateBlock): StateBlock => ({ ...state, runs: previous?.runs ?? [] });

  // Only a fresh order, a queued order or a failed order (retry) can start.
  const labels = readState(await issue.listLabels());
  if (!labels.ok) {
    await reportFailure(issue, run, previous ?? newState(null, null), "read labels", `The issue has ${labels.reason}. Its state cannot be trusted.`);
    return STOP;
  }
  const from = labels.state;
  if (from !== null && from !== "in-progress" && !canTransition(from, "in-progress")) {
    await issue.setState(from);
    log(`Ignored: the order is ${from}, which arise cannot restart. Removed the arise label.`);
    return STOP;
  }
  if (!config.ok) {
    await reportFailure(issue, run, previous ?? newState(null, null), "load configuration", configProblem(config));
    return STOP;
  }
  const cfg = config.config;

  if (event.issue.labels.some((label) => label.toLowerCase() === "new-project")) {
    await reportFailure(issue, run, keepRuns(newState(null, null)), "read order", "New project orders are not supported yet (planned for milestone 5).");
    return STOP;
  }
  const form = parseOrderForm(event.issue.body);
  if (!form.ok) {
    await reportFailure(issue, run, keepRuns(newState(null, null)), "read order", `The issue does not match the Order form:\n${formatIssues(form.issues)}`);
    return STOP;
  }
  const order = form.value;
  const state = keepRuns(newState(order.target, order.base));

  const allowed = checkTarget(cfg, order.target, realm);
  if (!allowed.ok) {
    await reportFailure(issue, run, state, "check target", allowed.reason);
    return STOP;
  }

  const fake = input.fakeAgent.trim();
  if (fake !== "" && !(FAKE_AGENT_SCENARIOS as readonly string[]).includes(fake)) {
    await reportFailure(issue, run, state, "check credentials", `The Realm variable SHADOWARMY_FAKE_AGENT is "${fake}", which is not a known scenario.`);
    return STOP;
  }
  const missing: string[] = [];
  if (input.githubToken === "") missing.push("SHADOWARMY_GH_TOKEN");
  if (!input.hasClaudeCredential && fake === "") missing.push("CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY");
  if (missing.length > 0) {
    await reportFailure(issue, run, state, "check credentials", `Missing Realm secrets: ${missing.join("; ")}.`);
    return STOP;
  }

  const used = await countAgentRuns(input.client, event.repository.fullName, startOfDay(input.now, cfg.timezone));
  if (used >= cfg.limits.max_runs_per_day) {
    await report(
      issue,
      "queued",
      {
        summary: "Waiting: the daily run cap is reached.",
        details: [
          `Agent runs today: ${String(used)} of ${String(cfg.limits.max_runs_per_day)} (limits.max_runs_per_day, resets at 00:00 ${cfg.timezone}).`,
          "Add the arise label again after the reset to start this order.",
        ],
        links: [runLink(run)],
      },
      state,
    );
    return STOP;
  }

  const checkout = await checkOutTarget(input.workDir, order.target, order.base, input.githubToken, run.serverUrl);
  if (!checkout.ok) {
    await reportFailure(
      issue,
      run,
      state,
      "check out target",
      `${checkout.reason}\nCheck that SHADOWARMY_GH_TOKEN can read ${order.target} and that the base branch exists.`,
    );
    return STOP;
  }
  mkdirSync(input.inputsDir, { recursive: true });
  await packDirectory(input.workDir, join(input.inputsDir, TARGET_ARCHIVE));

  const branch = taskBranchName(event.issue.number, event.issue.title);
  await report(
    issue,
    "in-progress",
    {
      summary: `A Soldier is working on this order in ${order.target}.`,
      details: [
        `Branch: ${branch}`,
        `Limits: ${String(cfg.limits.max_turns)} turns, ${String(cfg.limits.run_timeout_minutes)} minutes.`,
        ...(fake === "" ? [] : [`Test mode: fake agent scenario "${fake}" instead of Claude.`]),
      ],
      links: [runLink(run)],
    },
    { ...state, branch },
  );

  writeSoldierInputs({
    engineDir: input.engineDir,
    realmDir: input.realmDir,
    outDir: input.inputsDir,
    issue: { number: event.issue.number, title: event.issue.title },
    target: order.target,
    base: order.base,
    task: order.task,
    answers: [],
    fakeAgent: fake === "" ? null : fake,
  });

  return {
    proceed: true,
    target: order.target,
    baseRef: checkout.ref,
    baseSha: checkout.sha,
    model: cfg.roles.soldier.model,
    maxTurns: cfg.limits.max_turns,
    timeoutMinutes: cfg.limits.run_timeout_minutes,
    fakeAgent: fake,
  };
}

/** The packed target checkout in the Soldier inputs; the soldier job extracts it. */
export const TARGET_ARCHIVE = "target.tar.gz";

type Checkout = { ok: true; ref: string; sha: string } | { ok: false; reason: string };

/** Fetch the head of the base branch (the default branch when none is given) into `dir`, on a local branch of the same name. */
async function checkOutTarget(dir: string, target: string, base: string | null, token: string, serverUrl: string): Promise<Checkout> {
  const run = (args: string[], auth = false) => git(args, { cwd: dir, serverUrl, ...(auth ? { token } : {}) });
  try {
    await run(["init", "--quiet"]);
    await run(["remote", "add", "origin", `${serverUrl}/${target}.git`]);
    let ref = base;
    if (ref === null) {
      const head = await run(["ls-remote", "--symref", "origin", "HEAD"], true);
      ref = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head)?.[1] ?? "";
      if (!isSafeBranchName(ref)) return { ok: false, reason: `${target} has no default branch that can be checked out.` };
    }
    await run(["fetch", "--quiet", "--depth=1", "origin", `refs/heads/${ref}`], true);
    await run(["checkout", "--quiet", "-b", ref, "FETCH_HEAD"]);
    return { ok: true, ref, sha: (await run(["rev-parse", "HEAD"])).trim() };
  } catch (error) {
    if (error instanceof GitError) return { ok: false, reason: error.message };
    throw error;
  }
}

/** Pack `dir` (including .git) with tar, which keeps file modes. Paths stay relative, so no path reaches tar's arguments. */
function packDirectory(dir: string, file: string): Promise<void> {
  const fd = openSync(file, "w");
  return new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-czf", "-", "."], { cwd: dir, stdio: ["ignore", fd, "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed (exit ${String(code)}): ${stderr.trim().slice(0, 1000)}`));
    });
  }).finally(() => {
    closeSync(fd);
  });
}
