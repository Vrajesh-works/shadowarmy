// Labels are the state of an order or task (behavior contract section 4).
// This module owns the label set, the transition table and the single-state
// label writer: every write replaces the whole label set in one API call, so
// an issue never shows two state labels or a stale `arise`.

export const TRIGGER_LABEL = "arise";

export const STATE_LABELS = [
  "queued",
  "planning",
  "in-progress",
  "in-review",
  "waiting-ci",
  "needs-decision",
  "ready-to-merge",
  "done",
  "failed",
  "dismissed",
] as const;
export type StateLabel = (typeof STATE_LABELS)[number];

export const KIND_LABELS = ["order", "task", "new-project"] as const;
export type KindLabel = (typeof KIND_LABELS)[number];

/** States nothing leaves. */
export const FINAL_STATES: ReadonlySet<StateLabel> = new Set<StateLabel>(["done", "dismissed"]);

export interface LabelDefinition {
  name: string;
  color: string;
  description: string;
}

/** Every label the engine uses, as created by `init` and `doctor --fix` (docs/configuration.md#labels). */
export const LABEL_DEFINITIONS: readonly LabelDefinition[] = [
  { name: "arise", color: "5319e7", description: "Start this order" },
  { name: "queued", color: "c5def5", description: "Waiting for capacity" },
  { name: "planning", color: "bfd4f2", description: "Marshal is planning" },
  { name: "in-progress", color: "1d76db", description: "A Soldier is working" },
  { name: "in-review", color: "0e8a16", description: "Knight review or fix round" },
  { name: "waiting-ci", color: "fbca04", description: "Waiting for target CI" },
  { name: "needs-decision", color: "d93f0b", description: "Needs the Monarch" },
  { name: "ready-to-merge", color: "0e8a16", description: "Pull request ready for the Monarch" },
  { name: "done", color: "cccccc", description: "Merged" },
  { name: "failed", color: "b60205", description: "Stopped; use /retry" },
  { name: "dismissed", color: "cccccc", description: "Stopped by the Monarch" },
  { name: "order", color: "ededed", description: "Order issue" },
  { name: "task", color: "ededed", description: "Task issue" },
  { name: "new-project", color: "ededed", description: "New project order" },
];

/** Where a transition starts: a state label, or a fresh order that only carries `arise`. */
export type TransitionSource = StateLabel | typeof TRIGGER_LABEL;

/**
 * The transitions listed explicitly in the behavior contract. Two general rules
 * are added by `allowedTargets`: any non-final source may move to `failed`
 * (a step failed) and to `dismissed` (the Monarch said /dismiss).
 */
const LISTED: Readonly<Record<TransitionSource, readonly StateLabel[]>> = {
  arise: ["queued", "planning", "in-progress"],
  queued: ["planning", "in-progress"],
  planning: ["needs-decision", "in-progress", "queued"],
  "needs-decision": ["planning", "in-progress", "queued"],
  "in-progress": ["in-review", "needs-decision"],
  "in-review": ["in-progress", "waiting-ci", "ready-to-merge", "needs-decision"],
  "waiting-ci": ["in-review", "ready-to-merge", "needs-decision"],
  "ready-to-merge": ["done", "in-review"],
  failed: ["planning", "queued", "in-progress"],
  done: [],
  dismissed: [],
};

function isFinal(source: TransitionSource): boolean {
  return source !== TRIGGER_LABEL && FINAL_STATES.has(source);
}

/** Every state `from` may move to, in table order. Staying in the same state is not a transition. */
export function allowedTargets(from: TransitionSource): StateLabel[] {
  const targets = new Set<StateLabel>(LISTED[from]);
  if (!isFinal(from)) {
    targets.add("failed");
    targets.add("dismissed");
  }
  if (from !== TRIGGER_LABEL) targets.delete(from);
  return [...targets];
}

export function canTransition(from: TransitionSource, to: StateLabel): boolean {
  return allowedTargets(from).includes(to);
}

export function isStateLabel(name: string): name is StateLabel {
  return (STATE_LABELS as readonly string[]).includes(name);
}

export type LabelState =
  | { ok: true; state: StateLabel | null; trigger: boolean }
  | { ok: false; reason: string; states: StateLabel[]; trigger: boolean };

/**
 * Read the state from an issue's labels. Label names on GitHub are
 * case-insensitive. More than one state label is reported, never resolved by guessing.
 */
export function readState(labels: readonly string[]): LabelState {
  const lower = labels.map((label) => label.toLowerCase());
  const trigger = lower.includes(TRIGGER_LABEL);
  const states = STATE_LABELS.filter((state) => lower.includes(state));
  if (states.length > 1) {
    return { ok: false, reason: `more than one state label: ${states.join(", ")}`, states, trigger };
  }
  return { ok: true, state: states[0] ?? null, trigger };
}

/** The label set after moving to `to`: every other label kept in order, state labels and `arise` replaced. */
export function nextLabels(current: readonly string[], to: StateLabel): string[] {
  const kept = current.filter((label) => {
    const lower = label.toLowerCase();
    return lower !== TRIGGER_LABEL && !isStateLabel(lower);
  });
  return [...kept, to];
}

/** The two GitHub calls the writer needs, so tests can use a fake and workflows an Octokit adapter. */
export interface IssueLabelsApi {
  /** GET /repos/{owner}/{repo}/issues/{issue}/labels (names only). */
  listLabels(issue: number): Promise<string[]>;
  /** PUT /repos/{owner}/{repo}/issues/{issue}/labels: replaces the whole set in one call. */
  replaceLabels(issue: number, labels: string[]): Promise<void>;
}

export class TransitionError extends Error {
  override name = "TransitionError";
}

export interface SetStateOptions {
  /**
   * The state is derived from other issues (a multi-task order's state follows
   * its tasks), so the transition table does not apply. The write is still one
   * call with exactly one state label, and a final state is never left.
   */
  derived?: boolean;
}

export interface TransitionResult {
  /** The state before the write; `arise` for a fresh order, null when the label set was unreadable. */
  from: TransitionSource | null;
  to: StateLabel;
  /** False when the labels were already exactly right and no write was made. */
  changed: boolean;
}

/**
 * Move an issue to `to`, enforcing the transition table unless the state is
 * derived (see SetStateOptions). Staying in the same state is allowed and only
 * cleans up a leftover `arise`. An issue with more than one state label can
 * only be moved to `failed` or `dismissed`, which repairs it; anything else throws.
 */
export async function setState(
  api: IssueLabelsApi,
  issue: number,
  to: StateLabel,
  options: SetStateOptions = {},
): Promise<TransitionResult> {
  const current = await api.listLabels(issue);
  const read = readState(current);
  let from: TransitionSource | null;

  if (!read.ok) {
    if (to !== "failed" && to !== "dismissed") {
      throw new TransitionError(`issue #${String(issue)} has ${read.reason}; only failed or dismissed can repair it`);
    }
    from = null;
  } else {
    from = read.state ?? (read.trigger ? TRIGGER_LABEL : null);
    if (from === null) {
      throw new TransitionError(`issue #${String(issue)} has no state label and no ${TRIGGER_LABEL} label`);
    }
    const allowed = options.derived === true ? !isFinal(from) : canTransition(from, to);
    if (from !== to && !allowed) {
      throw new TransitionError(`issue #${String(issue)} cannot move from ${from} to ${to}`);
    }
  }

  const next = nextLabels(current, to);
  const before = new Set(current);
  const unchanged = next.length === before.size && next.every((label) => before.has(label));
  if (!unchanged) await api.replaceLabels(issue, next);
  return { from, to, changed: !unchanged };
}
