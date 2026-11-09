// Shared test fixtures.

import type { SoldierResult } from "../../src/soldierResult.ts";

export function labeledEvent(overrides: { label?: string | undefined; sender?: string | undefined; body?: string | undefined; title?: string | undefined; labels?: string[] | undefined } = {}) {
  return {
    action: "labeled",
    label: { name: overrides.label ?? "arise" },
    sender: { login: overrides.sender ?? "the-monarch" },
    issue: {
      number: 42,
      title: overrides.title ?? "Add an RSS feed",
      body: overrides.body ?? "",
      labels: (overrides.labels ?? ["order", "arise"]).map((name) => ({ name })),
    },
    repository: { full_name: "the-monarch/realm", owner: { login: "the-monarch" } },
  };
}

export function result(overrides: Partial<SoldierResult> = {}): SoldierResult {
  return {
    status: "done",
    title: "Add RSS feed at /rss.xml",
    summary: "Generates RSS 2.0 from the 20 newest posts.",
    verification: [{ command: "npm test", outcome: "pass", notes: "42 passed" }],
    limitations: ["Feed is not linked from the HTML head yet"],
    question: null,
    injectionNoticed: false,
    ...overrides,
  };
}

