import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient, GitHubError, repoPath } from "../src/github.ts";

function fakeFetch(responses: (() => Response)[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fn = (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("no more responses");
    return Promise.resolve(next());
  };
  return { fn: fn, seen };
}

const json = (status: number, data: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

describe("GitHub client", () => {
  it("sends the token and JSON body", async () => {
    const { fn, seen } = fakeFetch([json(200, { ok: true })]);
    const client = createClient({ token: "t0k", fetch: fn, apiUrl: "https://api.test/" });
    assert.deepEqual(await client.request("POST", "/x", { a: 1 }), { ok: true });
    const [first] = seen;
    assert.ok(first);
    assert.equal(first.url, "https://api.test/x");
    const headers = first.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer t0k");
    assert.equal(first.init.body, '{"a":1}');
  });

  it("retries transient errors a bounded number of times", async () => {
    const { fn, seen } = fakeFetch([json(502, {}), json(503, {}), json(200, [1])]);
    const client = createClient({ token: "t", fetch: fn, sleep: () => Promise.resolve() });
    assert.deepEqual(await client.request("GET", "/x"), [1]);
    assert.equal(seen.length, 3);

    const failing = fakeFetch([json(500, {}), json(500, {}), json(500, { message: "boom" })]);
    const limited = createClient({ token: "t", fetch: failing.fn, retries: 2, sleep: () => Promise.resolve() });
    await assert.rejects(limited.request("GET", "/x"), /HTTP 500: boom/);
  });

  it("sends a POST only once, even when GitHub answers with a transient error", async () => {
    const { fn, seen } = fakeFetch([json(502, { message: "Bad Gateway" }), json(201, { id: 1 })]);
    const client = createClient({ token: "t", fetch: fn, sleep: () => Promise.resolve() });
    await assert.rejects(client.request("POST", "/repos/a/b/pulls", { title: "x" }), /HTTP 502/);
    assert.equal(seen.length, 1);
  });

  it("does not retry client errors and reports GitHub's message", async () => {
    const { fn, seen } = fakeFetch([json(404, { message: "Not Found" })]);
    const error = await createClient({ token: "t", fetch: fn }).request("GET", "/repos/a/b").catch((e: unknown) => e);
    assert.ok(error instanceof GitHubError);
    assert.equal(error.status, 404);
    assert.match(error.message, /GET \/repos\/a\/b failed with HTTP 404: Not Found/);
    assert.equal(seen.length, 1);
  });

  it("follows pagination links and unwraps list envelopes, within the page limit", async () => {
    const { fn, seen } = fakeFetch([
      json(200, { total_count: 3, jobs: [1, 2] }, { link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"' }),
      json(200, { total_count: 3, jobs: [3] }, { link: '<https://api.github.com/x?page=3>; rel="next"' }),
    ]);
    const client = createClient({ token: "t", fetch: fn });
    assert.deepEqual(await client.paginate("/x", 2), [1, 2, 3]);
    assert.equal(seen[0]?.url, "https://api.github.com/x?per_page=100");
    assert.equal(seen.length, 2);
  });

  it("encodes repository paths", () => {
    assert.equal(repoPath("me/my.repo"), "me/my.repo");
    assert.equal(repoPath("me/a b"), "me/a%20b");
  });
});
