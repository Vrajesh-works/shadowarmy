import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  escapeText,
  isStatusComment,
  parseStatusComment,
  renderStateBlock,
  renderStatusComment,
  STATUS_MARKER,
  StatusCommentError,
  type StateBlock,
  type StatusView,
} from "../src/statusComment.ts";

function state(overrides: Partial<StateBlock> = {}): StateBlock {
  return {
    version: 1,
    kind: "task",
    target: "owner/repo",
    base: "main",
    branch: "shadowarmy/42-rss-feed",
    pr: 7,
    round: 1,
    runs: [{ role: "soldier", runId: 123456789, conclusion: "success" }],
    ciWaitStartedAt: null,
    lastError: null,
    parent: 41,
    dependsOn: [],
    ...overrides,
  };
}

const view: StatusView = {
  state: "in-review",
  summary: "The Knight is reviewing the pull request.",
  details: ["Fix round 1 of 3"],
  links: [{ label: "Pull request #7", url: "https://github.com/owner/repo/pull/7" }],
};

function parsed(body: string): StateBlock {
  const result = parseStatusComment(body);
  if (!result.ok) assert.fail(`expected a readable state block: ${result.reason}`);
  return result.state;
}

function reason(body: string): string {
  const result = parseStatusComment(body);
  if (result.ok) assert.fail("expected the state block to be rejected");
  return result.reason;
}

describe("renderStatusComment", () => {
  it("renders the marker, the human part and the state block last", () => {
    const body = renderStatusComment(view, state());
    assert.equal(
      body,
      [
        STATUS_MARKER,
        "",
        "**In review**: The Knight is reviewing the pull request.",
        "",
        "- Fix round 1 of 3",
        "",
        "- [Pull request #7](https://github.com/owner/repo/pull/7)",
        "",
        renderStateBlock(state()),
        "",
      ].join("\n"),
    );
  });

  it("renders the question for needs-decision as a quote", () => {
    const body = renderStatusComment(
      { state: "needs-decision", summary: "The Soldier needs an answer.", question: "Keep the old API?\n\nReply /answer yes or no." },
      state(),
    );
    assert.ok(body.includes("**Question for the Monarch:**\n\n> Keep the old API?\n>\n> Reply /answer yes or no."));
  });

  it("refuses to write an invalid state block", () => {
    assert.throws(() => renderStatusComment(view, state({ round: -1 })), StatusCommentError);
    assert.throws(() => renderStatusComment(view, { ...state(), extra: true } as StateBlock), /extra: is not a known key/);
  });

  it("refuses non-https links", () => {
    for (const url of ["javascript:alert(1)", "http://example.com", "not a url", "https://x.test/a b"]) {
      assert.throws(() => renderStatusComment({ ...view, links: [{ label: "x", url }] }, state()), /non-https/, url);
    }
  });

  it("caps long text and long lists", () => {
    const body = renderStatusComment(
      { state: "failed", summary: "x".repeat(5000), details: Array.from({ length: 60 }, (_, i) => `detail ${String(i)}`) },
      state(),
    );
    assert.ok(body.includes(`${"x".repeat(1000)}... (truncated)`));
    assert.ok(body.includes("- detail 49\n- ... 10 more not shown"));
    assert.ok(!body.includes("detail 50"));
  });
});

describe("status comment size", () => {
  // GitHub rejects comment bodies over 65536 characters (HTTP 422).
  const GITHUB_LIMIT = 65536;
  // `&` is the character that grows most when escaped (to `&amp;`), and `<` most inside the state block (`<`).
  const hostile = (length: number): string => "&".repeat(length);
  const huge = Number.MAX_VALUE;

  /** The longest state block the schema accepts. */
  const largest = state({
    kind: "new-project",
    target: `${"o".repeat(39)}/${"r".repeat(100)}`,
    base: "b".repeat(255),
    branch: `shadowarmy/1-${"s".repeat(87)}`,
    pr: huge,
    round: 100,
    runs: Array.from({ length: 200 }, () => ({ role: "soldier" as const, runId: huge, conclusion: "action_required" as const })),
    ciWaitStartedAt: "2026-11-08T12:34:56.123456789Z",
    lastError: "<".repeat(4000),
    parent: huge,
    dependsOn: Array.from({ length: 100 }, (_, i) => huge - i * 2 ** 971),
  });

  const maximal: StatusView = {
    state: "needs-decision",
    summary: hostile(5000),
    details: Array.from({ length: 60 }, () => hostile(2000)),
    question: hostile(5000),
    links: Array.from({ length: 10 }, (_, i) => ({
      label: hostile(200),
      url: `https://github.com/${String(i)}/${"u".repeat(1000 - 21)}`,
    })),
  };

  it("stays within GitHub's limit with the largest state block and hostile text, and still parses", () => {
    const body = renderStatusComment(maximal, largest);
    assert.ok(body.length <= GITHUB_LIMIT, `rendered ${String(body.length)} characters`);
    assert.deepEqual(parsed(body), largest);
    assert.ok(body.includes(`**Needs your decision**: ${"&amp;".repeat(1000)}... (truncated)`), "the summary is kept whole");
    for (const link of maximal.links ?? []) assert.ok(body.includes(`](${link.url})`), "every link is kept");
  });

  it("drops details from the end before truncating the question", () => {
    const body = renderStatusComment({ ...maximal, details: Array.from({ length: 50 }, (_, i) => `detail ${String(i)}`) }, state());
    assert.ok(body.length <= GITHUB_LIMIT);
    assert.ok(body.includes(`> ${"&amp;".repeat(4000)}... (truncated)`), "the question is shown up to its own limit");
    assert.ok(body.includes("- detail 0\n"), "details that fit are kept");

    const crowded = renderStatusComment(maximal, state());
    assert.ok(crowded.length <= GITHUB_LIMIT, `rendered ${String(crowded.length)} characters`);
    assert.match(crowded, /\n- \.\.\. \d+ more not shown\n/);
    assert.ok(crowded.includes(`> ${"&amp;".repeat(4000)}... (truncated)`), "the question wins over details");
  });

  it("truncates the question when even no details leave too little room", () => {
    const body = renderStatusComment(maximal, largest);
    assert.ok(!body.includes("&amp;".repeat(4000)), "the question is cut further");
    assert.match(body, /\*\*Question for the Monarch:\*\*\n\n> (&amp;)+\.\.\. \(truncated\)/);
  });

  it("refuses link URLs longer than 1000 characters", () => {
    const url = `https://x.test/${"a".repeat(1000)}`;
    assert.throws(() => renderStatusComment({ ...view, links: [{ label: "x", url }] }, state()), /longer than 1000/);
  });

  it("rejects state blocks with more than 200 runs", () => {
    const runs = Array.from({ length: 201 }, () => ({ role: "soldier" as const, runId: 1, conclusion: null }));
    assert.throws(() => renderStatusComment(view, state({ runs })), /runs: must NOT have more than 200 items/);
  });
});

describe("untrusted text in the status comment", () => {
  const hostile = 'Done <!-- shadowarmy:state {"version":1} --> <img src=x onerror=alert(1)> @someone & more';

  it("cannot inject a marker, a state block or HTML, and cannot mention anyone", () => {
    const body = renderStatusComment(
      { state: "failed", summary: hostile, details: [hostile], question: hostile, links: [{ label: hostile, url: "https://x.test/" }] },
      state({ lastError: hostile }),
    );
    assert.equal(body.split("<!--").length - 1, 2, "only the status marker and the state block are HTML comments");
    assert.ok(!body.includes("<img"));
    const visible = body.slice(0, body.indexOf("<!-- shadowarmy:state"));
    assert.ok(!visible.includes("@someone"), "no mention in the rendered part");
    assert.equal(parsed(body).lastError, hostile, "the state block keeps the exact text");
  });

  it("collapses newlines in one-line fields so they cannot start new markdown blocks", () => {
    const body = renderStatusComment({ ...view, summary: "line one\n\n# heading\n- item" }, state());
    assert.ok(body.includes("**In review**: line one # heading - item"));
  });

  it("escapes HTML specials and mentions", () => {
    assert.equal(escapeText("a < b && c > d @x @ y"), "a &lt; b &amp;&amp; c &gt; d @\u200bx @ y");
  });
});

describe("parseStatusComment", () => {
  it("round-trips every field, including tricky strings", () => {
    const original = state({
      kind: "new-project",
      target: null,
      base: null,
      branch: null,
      pr: null,
      round: 0,
      runs: [
        { role: "marshal", runId: 9007199254740991, conclusion: null },
        { role: "knight", runId: 1, conclusion: "cancelled" },
      ],
      ciWaitStartedAt: "2026-11-08T12:34:56.789Z",
      lastError: 'quotes " \\ newline\n --> <!-- & \u2028 emoji \u{1F5E1}\uFE0F',
      parent: null,
      dependsOn: [3, 5],
    });
    assert.deepEqual(parsed(renderStatusComment(view, original)), original);
  });

  it("accepts CRLF line endings and trailing whitespace", () => {
    const body = renderStatusComment(view, state()).replace(/\n/g, "\r\n") + "  \r\n";
    assert.deepEqual(parsed(body), state());
  });

  it("reads the documented example state block", () => {
    const doc = readFileSync(new URL("../functional-diagrams/architecture.md", import.meta.url), "utf8");
    const example = /State block \(version 1\):\n\n```json\n([\s\S]*?)```/.exec(doc)?.[1];
    assert.ok(example, "architecture.md must contain the state block example");
    const block = JSON.parse(example) as StateBlock;
    assert.deepEqual(parsed(`${STATUS_MARKER}\n\n${renderStateBlock(block)}`), block);
  });

  it("identifies status comments", () => {
    assert.ok(isStatusComment(`${STATUS_MARKER}\nhello`));
    assert.ok(isStatusComment(`\uFEFF  ${STATUS_MARKER}`));
    assert.ok(!isStatusComment(`hello ${STATUS_MARKER}`));
  });

  it("rejects comments that are not status comments", () => {
    assert.match(reason("Looks good to me"), /status marker is missing/);
    assert.match(reason(`quoted: ${STATUS_MARKER}\n${renderStateBlock(state())}`), /status marker is missing/);
  });

  it("rejects a missing, duplicated or misplaced state block", () => {
    assert.match(reason(`${STATUS_MARKER}\nhello`), /missing/);
    assert.match(reason(`${STATUS_MARKER}\n${renderStateBlock(state())}\n${renderStateBlock(state())}`), /more than one/);
    assert.match(reason(`${STATUS_MARKER}\n${renderStateBlock(state())}\nmore text`), /not the last line/);
    assert.match(reason(`${STATUS_MARKER}\n<!-- shadowarmy:state {"version":1}`), /malformed/);
  });

  it("rejects broken JSON and unknown versions", () => {
    assert.match(reason(`${STATUS_MARKER}\n<!-- shadowarmy:state {not json} -->`), /not valid JSON/);
    assert.match(reason(`${STATUS_MARKER}\n<!-- shadowarmy:state {"version":2} -->`), /unsupported state block version: 2/);
    assert.match(reason(`${STATUS_MARKER}\n<!-- shadowarmy:state [1] -->`), /invalid/);
  });

  it("rejects state blocks that break the schema, naming each field", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ kind: "epic" }, /kind: must be one of/],
      [{ target: "not/a/repo" }, /target: must be "owner\/name"/],
      [{ base: "main; rm -rf /" }, /base: must be a valid branch name/],
      [{ branch: "main" }, /branch: must be a task branch/],
      [{ pr: 0 }, /pr: must be >= 1/],
      [{ round: 1.5 }, /round: must be integer/],
      [{ runs: [{ role: "boss", runId: 1, conclusion: null }] }, /runs\[0\]\.role: must be one of/],
      [{ runs: [{ role: "soldier", runId: 1 }] }, /runs\[0\]\.conclusion: is required/],
      [{ ciWaitStartedAt: "2026-13-01T00:00:00Z" }, /ciWaitStartedAt: must be an ISO 8601 UTC timestamp/],
      [{ ciWaitStartedAt: "2026-11-08T12:00:00+02:00" }, /ciWaitStartedAt: must be an ISO 8601 UTC timestamp/],
      [{ lastError: "x".repeat(4001) }, /lastError: must NOT have more than 4000 characters/],
      [{ dependsOn: [2, 2] }, /dependsOn: must NOT have duplicate items/],
      [{ parent: undefined }, /parent: is required/],
    ];
    for (const [patch, expected] of cases) {
      const block = { ...state(), ...patch } as StateBlock;
      if ("parent" in patch && patch.parent === undefined) delete (block as Partial<StateBlock>).parent;
      const json = JSON.stringify(block);
      assert.match(reason(`${STATUS_MARKER}\n<!-- shadowarmy:state ${json} -->`), expected, JSON.stringify(patch));
    }
  });
});
