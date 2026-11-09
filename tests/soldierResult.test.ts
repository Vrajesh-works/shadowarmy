import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderCommitMessage, renderPullRequestBody, MAX_PR_BODY } from "../src/prBody.ts";
import { checkSoldierResult, MAX_RESULT_BYTES } from "../src/soldierResult.ts";
import { result } from "./helpers/fixtures.ts";

function reason(text: string | null): string {
  const checked = checkSoldierResult(text);
  if (checked.ok) assert.fail("expected the result to be rejected");
  return checked.reason;
}

describe("checkSoldierResult", () => {
  it("accepts the documented example", () => {
    const checked = checkSoldierResult(JSON.stringify(result()));
    assert.deepEqual(checked, { ok: true, result: result() });
  });

  it("requires a question when blocked", () => {
    assert.match(reason(JSON.stringify(result({ status: "blocked" }))), /question: must be string/);
    assert.equal(checkSoldierResult(JSON.stringify(result({ status: "blocked", question: "Which one?" }))).ok, true);
  });

  it("treats a missing, unparsable, oversized or off-schema result as a failure", () => {
    assert.match(reason(null), /did not write result.json/);
    assert.match(reason("not json"), /not valid JSON/);
    assert.ok(!reason("this is not json\n").includes("\n"), "the reason is one line");
    assert.match(reason(" ".repeat(MAX_RESULT_BYTES + 1)), /larger than/);
    assert.match(reason(JSON.stringify({ ...result(), status: "success" })), /status: must be one of/);
    assert.match(reason(JSON.stringify({ ...result(), extra: 1 })), /extra: is not a known key/);
    assert.match(reason(JSON.stringify(result({ title: "two\nlines" }))), /title: must be one line/);
    assert.match(reason(JSON.stringify({ ...result(), verification: [{ command: "x", outcome: "ok", notes: "" }] })), /outcome: must be one of/);
  });
});

describe("pull request body", () => {
  it("lists summary, verification, limitations and an unlinked issue reference", () => {
    const body = renderPullRequestBody(result(), { issue: 42, realm: "me/realm", linkRealm: false });
    assert.equal(
      body,
      [
        "## Summary",
        "",
        "Generates RSS 2.0 from the 20 newest posts.",
        "",
        "## Verification",
        "",
        "- <code>npm test</code>: pass - 42 passed",
        "",
        "## Known limitations",
        "",
        "- Feed is not linked from the HTML head yet",
        "",
        "Ordered from a shadowarmy Realm (issue `#42`).",
        "",
      ].join("\n"),
    );
  });

  it("links the Realm issue only when asked", () => {
    const body = renderPullRequestBody(result({ verification: [], limitations: [] }), { issue: 7, realm: "me/realm", linkRealm: true });
    assert.ok(body.includes("The Soldier reported no checks."));
    assert.ok(body.includes("None reported."));
    assert.ok(body.endsWith("Ordered from a shadowarmy Realm ([issue #7](https://github.com/me/realm/issues/7)).\n"));
  });

  it("escapes agent text and stays under the size limit", () => {
    const hostile = "<script>x</script> @someone <!-- shadowarmy:state {} -->";
    const body = renderPullRequestBody(
      result({
        summary: hostile,
        verification: Array.from({ length: 50 }, () => ({ command: hostile.repeat(5), outcome: "pass" as const, notes: "y".repeat(1000) })),
      }),
      { issue: 1, realm: "me/realm", linkRealm: false },
    );
    assert.ok(!body.includes("<script>") && !body.includes("<!--") && !body.includes("@someone"));
    assert.ok(body.length <= MAX_PR_BODY);
    assert.ok(body.includes("... (truncated)"));
  });

  it("writes a commit message without tool attribution or control characters", () => {
    assert.equal(renderCommitMessage(result({ summary: "Line one.\u0007\nLine two." })), "Add RSS feed at /rss.xml\n\nLine one.\nLine two.\n");
  });
});
