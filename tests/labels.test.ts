import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  allowedTargets,
  canTransition,
  FINAL_STATES,
  KIND_LABELS,
  LABEL_DEFINITIONS,
  nextLabels,
  readState,
  setState,
  STATE_LABELS,
  TransitionError,
  TRIGGER_LABEL,
  type IssueLabelsApi,
  type StateLabel,
  type TransitionSource,
} from "../src/labels.ts";

/** The transition table in docs/behavior-contract.md section 4, read from the doc itself. */
function documentedTransitions(): Map<TransitionSource, Set<StateLabel>> {
  const doc = readFileSync(new URL("../docs/behavior-contract.md", import.meta.url), "utf8");
  const block = /Transitions:\n\n```text\n([\s\S]*?)```/.exec(doc)?.[1];
  assert.ok(block, "behavior contract must contain the transitions block");

  const sources: TransitionSource[] = [TRIGGER_LABEL, ...STATE_LABELS];
  const table = new Map<TransitionSource, Set<StateLabel>>(sources.map((source) => [source, new Set()]));
  for (const line of block.trim().split("\n")) {
    const [left = "", right = ""] = line.split("->").map((part) => part.trim());
    const targets = right
      .split("|")
      .map((target) => target.replace(/\(.*?\)/g, "").trim()) as StateLabel[];
    for (const target of targets) assert.ok(STATE_LABELS.includes(target), `unknown target "${target}" in: ${line}`);

    const from: TransitionSource[] =
      left === "any non-final state"
        ? sources.filter((source) => source === TRIGGER_LABEL || !FINAL_STATES.has(source))
        : [left as TransitionSource];
    for (const source of from) {
      const set = table.get(source);
      assert.ok(set, `unknown source "${source}" in: ${line}`);
      for (const target of targets) if (target !== source) set.add(target);
    }
  }
  return table;
}

describe("transition table", () => {
  it("matches the behavior contract exactly", () => {
    for (const [from, targets] of documentedTransitions()) {
      assert.deepEqual(new Set(allowedTargets(from)), targets, `transitions from ${from}`);
    }
  });

  it("lets nothing leave a final state", () => {
    for (const state of FINAL_STATES) assert.deepEqual(allowedTargets(state), []);
  });

  it("lets every non-final state fail or be dismissed", () => {
    for (const from of [TRIGGER_LABEL, ...STATE_LABELS.filter((state) => !FINAL_STATES.has(state))] as const) {
      assert.ok(canTransition(from, "dismissed"), from);
      if (from !== "failed") assert.ok(canTransition(from, "failed"), from);
    }
  });

  it("never treats staying in a state as a transition", () => {
    for (const state of STATE_LABELS) assert.ok(!canTransition(state, state), state);
  });

  it("covers the single-task order path", () => {
    assert.ok(canTransition("arise", "in-progress"));
    assert.ok(canTransition("in-progress", "in-review"));
    assert.ok(canTransition("in-review", "ready-to-merge"));
    assert.ok(canTransition("ready-to-merge", "done"));
    assert.ok(!canTransition("in-progress", "done"));
    assert.ok(!canTransition("arise", "ready-to-merge"));
  });
});

describe("label definitions", () => {
  it("define every trigger, state and kind label once", () => {
    const names = LABEL_DEFINITIONS.map((label) => label.name);
    assert.deepEqual(names, [TRIGGER_LABEL, ...STATE_LABELS, ...KIND_LABELS]);
  });

  it("match the labels table in docs/configuration.md", () => {
    const doc = readFileSync(new URL("../docs/configuration.md", import.meta.url), "utf8");
    const section = doc.slice(doc.indexOf("## Labels"), doc.indexOf("## Issue Forms"));
    const rows = [...section.matchAll(/^\| `([a-z-]+)` \| `([0-9a-f]{6})` \| (.+?) \|$/gm)].map(([, name, color, description]) => ({
      name,
      color,
      description,
    }));
    assert.deepEqual(rows, LABEL_DEFINITIONS);
  });
});

describe("readState", () => {
  it("reads one state label, ignoring case and other labels", () => {
    assert.deepEqual(readState(["order", "In-Progress", "bug"]), { ok: true, state: "in-progress", trigger: false });
  });

  it("reads a fresh order", () => {
    assert.deepEqual(readState(["order", "arise"]), { ok: true, state: null, trigger: true });
  });

  it("reports more than one state label instead of guessing", () => {
    const result = readState(["failed", "in-progress"]);
    assert.equal(result.ok, false);
    assert.match(result.reason, /more than one state label: in-progress, failed/);
  });
});

describe("nextLabels", () => {
  it("replaces every state label and arise, keeping other labels in order", () => {
    assert.deepEqual(nextLabels(["bug", "ARISE", "queued", "order", "failed"], "in-progress"), ["bug", "order", "in-progress"]);
  });
});

/** A fake GitHub issue whose label calls behave like the REST API. */
class FakeIssue implements IssueLabelsApi {
  readonly writes: string[][] = [];
  labels: string[];
  constructor(labels: string[]) {
    this.labels = labels;
  }
  listLabels(): Promise<string[]> {
    return Promise.resolve([...this.labels]);
  }
  replaceLabels(_issue: number, labels: string[]): Promise<void> {
    this.writes.push(labels);
    this.labels = [...labels];
    return Promise.resolve();
  }
}

function stateCount(labels: readonly string[]): number {
  return labels.filter((label) => (STATE_LABELS as readonly string[]).includes(label.toLowerCase())).length;
}

describe("setState", () => {
  it("starts an order: removes arise and sets the state in one call", async () => {
    const issue = new FakeIssue(["order", "arise"]);
    assert.deepEqual(await setState(issue, 7, "in-progress"), { from: "arise", to: "in-progress", changed: true });
    assert.deepEqual(issue.writes, [["order", "in-progress"]]);
  });

  it("leaves exactly one state label after every allowed transition", async () => {
    for (const from of STATE_LABELS) {
      for (const to of allowedTargets(from)) {
        const issue = new FakeIssue(["order", from, "bug"]);
        await setState(issue, 1, to);
        assert.equal(issue.writes.length, 1, `${from} -> ${to}`);
        assert.equal(stateCount(issue.labels), 1, `${from} -> ${to}`);
        assert.ok(issue.labels.includes(to) && issue.labels.includes("bug") && issue.labels.includes("order"));
      }
    }
  });

  it("refuses a transition the table does not allow, without writing", async () => {
    const issue = new FakeIssue(["order", "in-progress"]);
    await assert.rejects(setState(issue, 3, "done"), new TransitionError("issue #3 cannot move from in-progress to done"));
    assert.deepEqual(issue.writes, []);
  });

  it("refuses to leave a final state", async () => {
    await assert.rejects(setState(new FakeIssue(["done"]), 1, "in-progress"), TransitionError);
  });

  it("refuses an issue with no state and no arise", async () => {
    await assert.rejects(setState(new FakeIssue(["order"]), 4, "in-progress"), /no state label and no arise/);
  });

  it("treats the same state as a no-op without writing", async () => {
    const issue = new FakeIssue(["in-review", "order"]);
    assert.deepEqual(await setState(issue, 1, "in-review"), { from: "in-review", to: "in-review", changed: false });
    assert.deepEqual(issue.writes, []);
  });

  it("removes a leftover arise when staying in the same state", async () => {
    const issue = new FakeIssue(["failed", "arise"]);
    assert.equal((await setState(issue, 1, "failed")).changed, true);
    assert.deepEqual(issue.labels, ["failed"]);
  });

  it("allows a retry when arise is added to a failed order", async () => {
    const issue = new FakeIssue(["order", "failed", "arise"]);
    assert.equal((await setState(issue, 1, "in-progress")).from, "failed");
    assert.deepEqual(issue.labels, ["order", "in-progress"]);
  });

  it("repairs two state labels only by failing or dismissing", async () => {
    await assert.rejects(setState(new FakeIssue(["queued", "in-progress"]), 9, "in-review"), /only failed or dismissed/);
    const issue = new FakeIssue(["queued", "in-progress", "order"]);
    assert.deepEqual(await setState(issue, 9, "failed"), { from: null, to: "failed", changed: true });
    assert.deepEqual(issue.labels, ["order", "failed"]);
  });

  it("keeps one state label when two events race on the same issue", async () => {
    // Both writers read the same labels before either writes; each write still
    // replaces the full set, so the issue ends with exactly one state label.
    const issue = new FakeIssue(["order", "in-review"]);
    await Promise.all([setState(issue, 1, "ready-to-merge"), setState(issue, 1, "in-progress")]);
    assert.equal(issue.writes.length, 2);
    for (const write of issue.writes) assert.equal(stateCount(write), 1);
    assert.equal(stateCount(issue.labels), 1);
  });
});
