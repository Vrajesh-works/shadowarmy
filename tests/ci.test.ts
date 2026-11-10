import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyCheckRun, classifyStatus, cleanLogLine, failureExcerpt, readChecks, summarize, waitForChecks } from "../src/ci.ts";
import { FakeGitHub } from "./helpers/fakeGitHub.ts";

const SHA = "a".repeat(40);
const run = (name: string, status: string, conclusion: string | null, extra: Record<string, unknown> = {}) => ({
  id: 7,
  name,
  status,
  conclusion,
  html_url: `https://github.com/o/r/runs/${name}`,
  app: { slug: "github-actions" },
  ...extra,
});

describe("CI classification", () => {
  it("classifies check runs and statuses", () => {
    assert.equal(classifyCheckRun(run("test", "in_progress", null)).state, "pending");
    assert.equal(classifyCheckRun(run("test", "completed", "success")).state, "passed");
    assert.equal(classifyCheckRun(run("test", "completed", "skipped")).state, "passed");
    for (const bad of ["failure", "timed_out", "cancelled", "action_required", "startup_failure"]) {
      assert.equal(classifyCheckRun(run("test", "completed", bad)).state, "failed", bad);
    }
    assert.equal(classifyCheckRun(run("test", "completed", "failure")).jobId, 7);
    assert.equal(classifyCheckRun(run("x", "completed", "failure", { app: { slug: "codecov" } })).jobId, null);
    assert.equal(classifyStatus({ context: "ci/legacy", state: "error" }).state, "failed");
    assert.equal(classifyStatus({ context: "ci/legacy", state: "pending" }).state, "pending");
  });

  it("summarizes: none, pending wins, then failing, else passing", () => {
    const passed = classifyCheckRun(run("a", "completed", "success"));
    const failed = classifyCheckRun(run("b", "completed", "failure"));
    const pending = classifyCheckRun(run("c", "queued", null));
    assert.equal(summarize([]).kind, "none");
    assert.equal(summarize([passed, failed, pending]).kind, "pending");
    assert.equal(summarize([passed, failed]).kind, "failing");
    assert.equal(summarize([passed]).kind, "passing");
  });

  it("reads check runs and statuses together", async () => {
    const gh = new FakeGitHub();
    gh.checkRuns.set(SHA, [run("test", "completed", "success")]);
    gh.statuses.set(SHA, [{ context: "deploy", state: "success" }]);
    assert.deepEqual((await readChecks(gh, "o/r", SHA)).map((check) => check.name), ["test", "deploy"]);
  });
});

describe("reading checks without check-run access", () => {
  it("falls back to the GitHub Actions jobs of the commit", async () => {
    const gh = new FakeGitHub();
    gh.checkRunsForbidden = true;
    gh.runs = [
      {
        id: 1,
        created_at: "2026-11-09T10:00:00Z",
        head_sha: SHA,
        jobs: [
          { id: 11, name: "test", status: "completed", conclusion: "failure", started_at: "2026-11-09T10:00:00Z" },
          { id: 12, name: "lint", status: "in_progress", conclusion: null, started_at: "2026-11-09T10:00:00Z" },
        ],
      },
      { id: 2, created_at: "2026-11-09T10:00:00Z", head_sha: "b".repeat(40), jobs: [{ id: 21, name: "other", status: "completed", conclusion: "success", started_at: null }] },
    ];
    const checks = await readChecks(gh, "o/r", SHA);
    assert.deepEqual(checks.map((check) => [check.name, check.state, check.jobId]), [["test", "failed", 11], ["lint", "pending", 12]]);
  });
});

describe("waitForChecks", () => {
  function clock() {
    let now = 0;
    return { now: () => new Date(now), sleep: (ms: number) => { now += ms; return Promise.resolve(); } };
  }

  it("waits until pending checks finish", async () => {
    const gh = new FakeGitHub();
    const c = clock();
    gh.checkRuns.set(SHA, [run("test", "in_progress", null)]);
    const sleep = async (ms: number) => {
      await c.sleep(ms);
      if (c.now().getTime() >= 90_000) gh.checkRuns.set(SHA, [run("test", "completed", "failure")]);
    };
    const status = await waitForChecks(gh, "o/r", SHA, { deadline: new Date(600_000), graceMs: 120_000, pollMs: 30_000, now: c.now, sleep });
    assert.equal(status.kind, "failing");
    assert.equal(c.now().getTime(), 90_000);
  });

  it("concludes there is no CI after the grace period", async () => {
    const c = clock();
    const status = await waitForChecks(new FakeGitHub(), "o/r", SHA, { deadline: new Date(600_000), graceMs: 120_000, pollMs: 30_000, ...c });
    assert.equal(status.kind, "none");
    assert.equal(c.now().getTime(), 120_000);
  });

  it("stops at the deadline with what is still pending", async () => {
    const gh = new FakeGitHub();
    gh.checkRuns.set(SHA, [run("slow", "in_progress", null)]);
    const c = clock();
    const status = await waitForChecks(gh, "o/r", SHA, { deadline: new Date(100_000), graceMs: 1000, pollMs: 30_000, ...c });
    assert.equal(status.kind, "pending");
    assert.equal(c.now().getTime(), 100_000);
  });
});

describe("failure excerpts", () => {
  it("takes the last lines of the job log, without timestamps or colours", async () => {
    const gh = new FakeGitHub();
    gh.logs.set(7, ["2026-11-09T10:00:00.1234567Z line 1", "2026-11-09T10:00:01.0000000Z \u001b[31mnot ok 2 - greets\u001b[0m", "2026-11-09T10:00:02Z done", ""].join("\n"));
    const check = classifyCheckRun(run("test", "completed", "failure"));
    assert.equal(await failureExcerpt(gh, "o/r", check, 2), "not ok 2 - greets\ndone");
  });

  it("falls back to the check's own output when there is no log", async () => {
    const check = classifyCheckRun(run("lint", "completed", "failure", { app: { slug: "other" }, output: { title: "3 problems", summary: "src/a.ts:1 bad" } }));
    assert.equal(await failureExcerpt(new FakeGitHub(), "o/r", check, 10), "3 problems\nsrc/a.ts:1 bad");
  });

  it("cleans log lines", () => {
    assert.equal(cleanLogLine("2026-11-09T10:00:00.1Z \u001b[1mhello\u001b[0m"), "hello");
  });
});
