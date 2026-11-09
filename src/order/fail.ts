// The `report-failure` job of order.yml: a safety net for when a job crashed
// before it could report. It only acts when the order is still marked as
// running (or still has a bare arise), so it never overwrites a real outcome.

import type { IssueLabeledEvent } from "../event.ts";
import type { GitHubClient } from "../github.ts";
import { readState } from "../labels.ts";
import { RealmIssue } from "../realmIssue.ts";
import type { StateBlock } from "../statusComment.ts";
import { newState, reportFailure, type RunInfo } from "./context.ts";

export interface FailInput {
  event: IssueLabeledEvent;
  client: GitHubClient;
  run: RunInfo;
  /** needs.<job>.result for each job, in order. */
  jobs: Readonly<Record<string, string>>;
  log: (line: string) => void;
}

export async function runFail(input: FailInput): Promise<void> {
  const issue = new RealmIssue(input.client, input.event.repository.fullName, input.event.issue.number);
  const labels = readState(await issue.listLabels());
  const running = labels.ok && (labels.state === "in-progress" || (labels.state === null && labels.trigger));
  if (!running) {
    input.log(`Nothing to do: the order already shows its outcome (${labels.ok ? String(labels.state) : labels.reason}).`);
    return;
  }
  const failed = Object.entries(input.jobs).find(([, result]) => result === "failure")?.[0] ?? "unknown";
  let state: StateBlock = newState(null, null);
  try {
    state = (await issue.readState()) ?? state;
  } catch {
    // Replace an unreadable status comment.
  }
  await reportFailure(issue, input.run, state, failed, `The ${failed} job failed unexpectedly before it could report. See the workflow run for details.`);
}
