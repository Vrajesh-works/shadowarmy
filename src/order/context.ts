// What every step of an order run shares: the Realm issue, the loaded
// configuration, the run link and how to report an outcome on the issue.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, type Config, type ConfigResult } from "../config.ts";
import type { StateLabel } from "../labels.ts";
import type { RealmIssue } from "../realmIssue.ts";
import { formatIssues } from "../schema.ts";
import type { StateBlock, StatusLink, StatusView } from "../statusComment.ts";

export interface RunInfo {
  runId: number;
  runUrl: string;
  serverUrl: string;
}

export function loadRealmConfig(realmDir: string, realm: { owner: string; repo: string }): ConfigResult {
  const path = join(realmDir, "shadowarmy.yml");
  if (!existsSync(path)) return { ok: false, issues: [{ path: "", message: "shadowarmy.yml is missing from the Realm" }] };
  return parseConfig(readFileSync(path, "utf8"), realm);
}

export function configProblem(result: Exclude<ConfigResult, { ok: true }>): string {
  return `shadowarmy.yml is invalid:\n${formatIssues(result.issues)}`;
}

export function newState(target: string | null, base: string | null): StateBlock {
  return {
    version: 1,
    kind: "order",
    target,
    base,
    baseSha: null,
    branch: null,
    pr: null,
    round: 0,
    runs: [],
    ciWaitStartedAt: null,
    lastError: null,
    parent: null,
    dependsOn: [],
  };
}

/** lastError keeps the first line-ish of a reason within the schema limit. */
export function errorText(reason: string): string {
  return reason.length > 4000 ? `${reason.slice(0, 3980)}... (truncated)` : reason;
}

export function runLink(run: RunInfo): StatusLink {
  return { label: "Workflow run", url: run.runUrl };
}

/** Move the issue to `failed` and explain why, with the run link. */
export async function reportFailure(
  issue: RealmIssue,
  run: RunInfo,
  state: StateBlock,
  step: string,
  reason: string,
): Promise<void> {
  await issue.setState("failed");
  const view: StatusView = {
    state: "failed",
    summary: `The order stopped at step "${step}".`,
    details: [...reason.split("\n").filter((line) => line.trim() !== ""), "To retry, fix the cause and add the arise label again."],
    links: [runLink(run)],
  };
  await issue.writeStatus(view, { ...state, lastError: errorText(`${step}: ${reason}`) });
}

export async function report(
  issue: RealmIssue,
  to: StateLabel,
  view: Omit<StatusView, "state">,
  state: StateBlock,
): Promise<void> {
  await issue.setState(to);
  await issue.writeStatus({ ...view, state: to }, state);
}

export type { Config };
