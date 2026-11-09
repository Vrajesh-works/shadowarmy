// The `gate` job of order.yml: decides whether an `arise` event starts work.
// Order of checks (functional-diagrams/actions/single-task-order.md):
// sender is the Monarch -> config valid -> order form valid -> target allowed
// -> credentials present -> daily cap. Anything from a non-Monarch account
// changes nothing.

import { checkTarget } from "../config.ts";
import type { IssueLabeledEvent } from "../event.ts";
import type { GitHubClient } from "../github.ts";
import { writeSoldierInputs } from "../inputs.ts";
import { canTransition, readState, TRIGGER_LABEL } from "../labels.ts";
import { countAgentRuns, startOfDay } from "../limits.ts";
import { taskBranchName } from "../names.ts";
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
  run: RunInfo;
  hasClaudeCredential: boolean;
  hasGitHubToken: boolean;
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
  base?: string;
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
  if (!config.ok) {
    // Without a valid config the Monarch is the Realm owner (the documented default).
    if (!sameLogin(event.sender, event.repository.owner)) {
      log(`Ignored: ${event.sender} is not the Monarch (shadowarmy.yml is invalid; the Realm owner is the Monarch).`);
      return STOP;
    }
    input.onAuthorized();
    await reportFailure(issue, run, newState(null, null), "load configuration", configProblem(config));
    return STOP;
  }
  const cfg = config.config;
  if (!sameLogin(event.sender, cfg.monarch)) {
    log(`Ignored: ${event.sender} is not the Monarch (${cfg.monarch}). Nothing was changed.`);
    return STOP;
  }
  input.onAuthorized();

  // Only a fresh order, a queued order or a failed order (retry) can start.
  const labels = readState(await issue.listLabels());
  if (!labels.ok) {
    await reportFailure(issue, run, newState(null, null), "read labels", `The issue has ${labels.reason}. Its state cannot be trusted.`);
    return STOP;
  }
  const from = labels.state;
  if (from !== null && from !== "in-progress" && !canTransition(from, "in-progress")) {
    await issue.setState(from);
    log(`Ignored: the order is ${from}, which arise cannot restart. Removed the arise label.`);
    return STOP;
  }

  let previous: StateBlock | null = null;
  try {
    previous = await issue.readState();
  } catch (error) {
    log(`The previous status comment is unreadable and will be replaced: ${(error as Error).message}`);
  }
  const keepRuns = (state: StateBlock): StateBlock => ({ ...state, runs: previous?.runs ?? [] });

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
  if (!input.hasGitHubToken) missing.push("SHADOWARMY_GH_TOKEN");
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
    base: order.base ?? "",
    model: cfg.roles.soldier.model,
    maxTurns: cfg.limits.max_turns,
    timeoutMinutes: cfg.limits.run_timeout_minutes,
    fakeAgent: fake,
  };
}
