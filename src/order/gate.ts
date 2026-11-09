// The `gate` job of order.yml: decides whether a run does work, and prepares it.
//
// Two triggers (src/event.ts):
// - `arise` added by the Monarch starts the order from its first round.
// - a workflow_dispatch from the engine (or the Monarch) runs the next fix
//   round of an order that a judge job left in-progress.
//
// Order of checks (functional-diagrams/actions/single-task-order.md):
// sender -> config valid -> state allows it -> order form valid -> target
// allowed -> credentials present -> target visibility -> daily cap (first
// round only) -> fetch the target. Anything from another account changes
// nothing. The gate fetches the target with SHADOWARMY_GH_TOKEN and packs it
// for the soldier job, so that token never reaches the job that runs the agent.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { checkTarget, type Config } from "../config.ts";
import type { OrderEvent } from "../event.ts";
import { gatherFeedback } from "../feedback.ts";
import { GitHubError, repoPath, type GitHubClient } from "../github.ts";
import { writeSoldierInputs } from "../inputs.ts";
import { parseOrderForm, type OrderForm } from "../issueForm.ts";
import { canTransition, readState, TRIGGER_LABEL } from "../labels.ts";
import { countAgentRuns, startOfDay } from "../limits.ts";
import { isTaskBranch, taskBranchName } from "../names.ts";
import { ACTIONS_BOT, RealmIssue } from "../realmIssue.ts";
import { formatIssues } from "../schema.ts";
import type { StateBlock } from "../statusComment.ts";
import { checkOutTarget, packDirectory, TARGET_ARCHIVE } from "../targetRepo.ts";
import { configProblem, loadRealmConfig, newState, report, reportFailure, runLink, type RunInfo } from "./context.ts";

export { TARGET_ARCHIVE } from "../targetRepo.ts";

export const FAKE_AGENT_SCENARIOS = [
  "add-file",
  "edit-claude-md",
  "no-changes",
  "blocked",
  "invalid-result",
  "seed-bug",
  "stubborn-bug",
] as const;

/** Longest in-job CI wait; GitHub-hosted jobs stop after 6 hours. The Sentinel takes over longer waits (milestone 3). */
export const MAX_IN_JOB_CI_WAIT_MINUTES = 300;

export interface GateInput {
  event: OrderEvent;
  client: GitHubClient;
  /** A client authenticated with SHADOWARMY_GH_TOKEN, for reading the target repository. */
  targetClient: GitHubClient;
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
  /** Called as soon as the sender is known to be allowed, before any change is made. */
  onAuthorized: () => void;
}

export interface GateOutput {
  proceed: boolean;
  target?: string;
  /** The branch the pull request targets. */
  baseRef?: string;
  /** The commit the first round started from; the Knight reviews the diff from here. */
  baseSha?: string;
  /** The commit this round's Soldier starts from: baseSha in round 0, the task branch head in fix rounds. */
  startSha?: string;
  round?: number;
  model?: string;
  knightModel?: string;
  maxTurns?: number;
  timeoutMinutes?: number;
  judgeTimeoutMinutes?: number;
  fakeAgent?: string;
}

const STOP: GateOutput = { proceed: false };

interface Prepared {
  issue: RealmIssue;
  cfg: Config;
  order: OrderForm;
  previous: StateBlock | null;
  fake: string;
}

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function runGate(input: GateInput): Promise<GateOutput> {
  const { event, log } = input;
  if (event.trigger === "label" && event.label !== TRIGGER_LABEL) {
    log(`Ignored: label "${event.label}" is not ${TRIGGER_LABEL}.`);
    return STOP;
  }
  const [owner = "", repo = ""] = event.repository.fullName.split("/");
  const realm = { owner, repo };
  const issue = new RealmIssue(input.client, event.repository.fullName, event.issue.number);

  const config = loadRealmConfig(input.realmDir, realm);
  // Without a valid config the Monarch is the Realm owner (the documented default).
  const monarch = config.ok ? config.config.monarch : event.repository.owner;
  // Fix rounds are dispatched by the engine itself with the Realm's GITHUB_TOKEN.
  const allowed = sameLogin(event.sender, monarch) || (event.trigger === "dispatch" && event.sender === ACTIONS_BOT);
  if (!allowed) {
    const why = config.ok ? `(${monarch}). Nothing was changed.` : "(shadowarmy.yml is invalid; the Realm owner is the Monarch).";
    log(`Ignored: ${event.sender} is not the Monarch ${why}`);
    return STOP;
  }

  let previous: StateBlock | null = null;
  try {
    previous = await issue.readState();
  } catch (error) {
    log(`The previous status comment is unreadable and will be replaced: ${(error as Error).message}`);
  }
  const labels = readState(await issue.listLabels());

  if (event.trigger === "dispatch") {
    // A dispatch only continues an order a judge job handed to a fix round.
    if (!labels.ok || labels.state !== "in-progress" || previous?.pr == null || previous.round < 1) {
      log(`Ignored: issue #${String(event.issue.number)} is not waiting for a fix round. Nothing was changed.`);
      return STOP;
    }
    input.onAuthorized();
  } else {
    input.onAuthorized();
    // Only a fresh order, a queued order or a failed order (retry) can start.
    if (!labels.ok) {
      await reportFailure(issue, input.run, previous ?? newState(null, null), "read labels", `The issue has ${labels.reason}. Its state cannot be trusted.`);
      return STOP;
    }
    const from = labels.state;
    if (from !== null && from !== "in-progress" && !canTransition(from, "in-progress")) {
      await issue.setState(from);
      log(`Ignored: the order is ${from}, which arise cannot restart. Removed the arise label.`);
      return STOP;
    }
  }

  const prepared = await prepare(input, issue, config, previous);
  if (prepared === null) return STOP;
  return event.trigger === "dispatch" ? fixRound(input, prepared) : firstRound(input, prepared);
}

/** Checks shared by both triggers; reports and returns null when the order cannot run. */
async function prepare(
  input: GateInput,
  issue: RealmIssue,
  config: ReturnType<typeof loadRealmConfig>,
  previous: StateBlock | null,
): Promise<Prepared | null> {
  const { event, run } = input;
  const keepRuns = (state: StateBlock): StateBlock => ({ ...state, runs: previous?.runs ?? [] });
  if (!config.ok) {
    await reportFailure(issue, run, previous ?? newState(null, null), "load configuration", configProblem(config));
    return null;
  }
  const cfg = config.config;
  const [owner = "", repo = ""] = event.repository.fullName.split("/");

  if (event.issue.labels.some((label) => label.toLowerCase() === "new-project")) {
    await reportFailure(issue, run, keepRuns(newState(null, null)), "read order", "New project orders are not supported yet (planned for milestone 5).");
    return null;
  }
  const form = parseOrderForm(event.issue.body);
  if (!form.ok) {
    await reportFailure(issue, run, keepRuns(newState(null, null)), "read order", `The issue does not match the Order form:\n${formatIssues(form.issues)}`);
    return null;
  }
  const order = form.value;
  const state = previous ?? keepRuns(newState(order.target, order.base));

  const targetAllowed = checkTarget(cfg, order.target, { owner, repo });
  if (!targetAllowed.ok) {
    await reportFailure(issue, run, state, "check target", targetAllowed.reason);
    return null;
  }

  const fake = input.fakeAgent.trim();
  if (fake !== "" && !(FAKE_AGENT_SCENARIOS as readonly string[]).includes(fake)) {
    await reportFailure(issue, run, state, "check credentials", `The Realm variable SHADOWARMY_FAKE_AGENT is "${fake}", which is not a known scenario.`);
    return null;
  }
  const missing: string[] = [];
  if (input.githubToken === "") missing.push("SHADOWARMY_GH_TOKEN");
  // The Knight always needs Claude, and fake Soldier scenarios hand fix rounds to the real Soldier.
  if (!input.hasClaudeCredential) missing.push("CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY");
  if (missing.length > 0) {
    await reportFailure(issue, run, state, "check credentials", `Missing Realm secrets: ${missing.join("; ")}.`);
    return null;
  }

  if (!event.repository.private) {
    const visibility = await readVisibility(input.targetClient, order.target);
    if (visibility === "unreadable") {
      await reportFailure(issue, run, state, "check out target", `Check that SHADOWARMY_GH_TOKEN can read ${order.target}.`);
      return null;
    }
    if (visibility === "private") {
      await reportFailure(
        issue,
        run,
        state,
        "check target",
        `${order.target} is private, but this Realm is public. Anyone can download the workflow artifacts of a public Realm, which would expose the private target's source code. Make the Realm private to order changes to private repositories.`,
      );
      return null;
    }
  }
  return { issue, cfg, order, previous, fake };
}

function commonOutputs(cfg: Config, fake: string): GateOutput {
  return {
    proceed: true,
    model: cfg.roles.soldier.model,
    knightModel: cfg.roles.knight.model,
    maxTurns: cfg.limits.max_turns,
    timeoutMinutes: cfg.limits.run_timeout_minutes,
    judgeTimeoutMinutes: Math.min(cfg.ci.max_wait_minutes, MAX_IN_JOB_CI_WAIT_MINUTES) + 15,
    fakeAgent: fake,
  };
}

async function firstRound(input: GateInput, p: Prepared): Promise<GateOutput> {
  const { event, run } = input;
  const { issue, cfg, order, fake } = p;
  const state: StateBlock = { ...newState(order.target, order.base), runs: p.previous?.runs ?? [] };

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
        `Limits: ${String(cfg.limits.max_turns)} turns, ${String(cfg.limits.run_timeout_minutes)} minutes, ${String(cfg.limits.max_fix_rounds)} fix rounds.`,
        ...(fake === "" ? [] : [`Test mode: fake agent scenario "${fake}" instead of the Soldier in round 0.`]),
      ],
      links: [runLink(run)],
    },
    { ...state, base: checkout.ref, baseSha: checkout.sha, branch, pr: p.previous?.pr ?? null },
  );

  writeSoldierInputs({
    engineDir: input.engineDir,
    realmDir: input.realmDir,
    outDir: input.inputsDir,
    issue: { number: event.issue.number, title: event.issue.title },
    target: order.target,
    base: checkout.ref,
    task: order.task,
    answers: [],
    round: 0,
    feedback: null,
    fakeAgent: fake === "" ? null : fake,
  });

  return { ...commonOutputs(cfg, fake), target: order.target, baseRef: checkout.ref, baseSha: checkout.sha, startSha: checkout.sha, round: 0 };
}

async function fixRound(input: GateInput, p: Prepared): Promise<GateOutput> {
  const { event, run } = input;
  const { issue, cfg, order, fake } = p;
  const state = p.previous;
  if (state?.pr == null || state.branch === null || !isTaskBranch(state.branch) || state.baseSha === null || state.base === null) {
    await reportFailure(issue, run, state ?? newState(order.target, order.base), "fix round", "The status comment does not record the branch, pull request and base commit a fix round needs.");
    return STOP;
  }
  const round = state.round;

  const pull = await input.targetClient.request<{ state: string; head: { sha: string; ref: string } }>(
    "GET",
    `/repos/${repoPath(order.target)}/pulls/${String(state.pr)}`,
  );
  if (pull.state !== "open" || pull.head.ref !== state.branch) {
    await reportFailure(issue, run, state, "fix round", `Pull request #${String(state.pr)} is no longer open on ${state.branch}.`);
    return STOP;
  }

  const engineLogin = (await input.targetClient.request<{ login: string }>("GET", "/user")).login;
  const feedback = await gatherFeedback({
    client: input.targetClient,
    target: order.target,
    pr: state.pr,
    headSha: pull.head.sha,
    engineLogin,
    logLines: cfg.ci.log_excerpt_lines,
  });
  if (feedback === null) {
    await reportFailure(issue, run, state, "fix round", `Nothing to fix on ${pull.head.sha.slice(0, 7)}: no Knight review requesting changes and no failing checks.`);
    return STOP;
  }

  const checkout = await checkOutTarget(input.workDir, order.target, state.branch, input.githubToken, run.serverUrl);
  if (!checkout.ok || checkout.sha !== pull.head.sha) {
    const reason = checkout.ok ? `${state.branch} moved to ${checkout.sha.slice(0, 7)} while the fix round started.` : checkout.reason;
    await reportFailure(issue, run, state, "check out target", reason);
    return STOP;
  }
  mkdirSync(input.inputsDir, { recursive: true });
  await packDirectory(input.workDir, join(input.inputsDir, TARGET_ARCHIVE));

  await issue.writeStatus(
    {
      state: "in-progress",
      summary: `Fix round ${String(round)} of ${String(cfg.limits.max_fix_rounds)}: a Soldier is addressing the feedback on pull request #${String(state.pr)}.`,
      details: feedback.sources,
      links: [runLink(run)],
    },
    state,
  );

  writeSoldierInputs({
    engineDir: input.engineDir,
    realmDir: input.realmDir,
    outDir: input.inputsDir,
    issue: { number: event.issue.number, title: event.issue.title },
    target: order.target,
    base: state.base,
    task: order.task,
    answers: [],
    round,
    feedback: feedback.text,
    fakeAgent: fake === "" ? null : fake,
  });

  return { ...commonOutputs(cfg, fake), target: order.target, baseRef: state.base, baseSha: state.baseSha, startSha: checkout.sha, round };
}

async function readVisibility(client: GitHubClient, target: string): Promise<"public" | "private" | "unreadable"> {
  try {
    const repo = await client.request<{ private?: unknown }>("GET", `/repos/${repoPath(target)}`);
    return repo.private === false ? "public" : "private";
  } catch (error) {
    if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) return "unreadable";
    throw error;
  }
}
