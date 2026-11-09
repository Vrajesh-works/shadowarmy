import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countAgentRuns, isAgentJob, startOfDay } from "../src/limits.ts";
import { FakeGitHub } from "./helpers/fakeGitHub.ts";

describe("startOfDay", () => {
  it("is midnight UTC for UTC", () => {
    assert.equal(startOfDay(new Date("2026-11-08T15:30:00Z"), "UTC").toISOString(), "2026-11-08T00:00:00.000Z");
  });

  it("uses the local date in other zones", () => {
    // 01:30 UTC on Nov 8 is still Nov 7 in New York (UTC-5).
    assert.equal(startOfDay(new Date("2026-11-08T01:30:00Z"), "America/New_York").toISOString(), "2026-11-07T05:00:00.000Z");
    assert.equal(startOfDay(new Date("2026-11-08T23:30:00Z"), "Asia/Kolkata").toISOString(), "2026-11-08T18:30:00.000Z");
  });

  it("handles days where daylight saving time changes", () => {
    // Berlin switches from UTC+1 to UTC+2 at 01:00 UTC on 2026-03-29; midnight was still UTC+1.
    assert.equal(startOfDay(new Date("2026-03-29T20:00:00Z"), "Europe/Berlin").toISOString(), "2026-03-28T23:00:00.000Z");
    // New York switches back to UTC-5 on 2026-11-01; midnight was still UTC-4.
    assert.equal(startOfDay(new Date("2026-11-01T20:00:00Z"), "America/New_York").toISOString(), "2026-11-01T04:00:00.000Z");
  });
});

describe("agent run counting", () => {
  it("counts started agent jobs only", () => {
    const job = (name: string, conclusion: string | null, started: boolean) => ({
      name,
      status: started ? "completed" : "queued",
      conclusion,
      started_at: started ? "2026-11-08T10:00:00Z" : null,
    });
    assert.ok(isAgentJob(job("order / soldier", "success", true)));
    assert.ok(isAgentJob(job("soldier", "failure", true)));
    assert.ok(!isAgentJob(job("order / soldier", "skipped", true)));
    assert.ok(!isAgentJob(job("order / soldier", null, false)));
    assert.ok(!isAgentJob(job("order / gate", "success", true)));
  });

  it("counts across runs created since the given instant", async () => {
    const gh = new FakeGitHub();
    const started = { status: "completed", conclusion: "success", started_at: "2026-11-08T10:00:00Z" };
    gh.runs = [
      { id: 1, created_at: "2026-11-07T23:00:00Z", jobs: [{ name: "order / soldier", ...started }] },
      { id: 2, created_at: "2026-11-08T01:00:00Z", jobs: [{ name: "order / gate", ...started }, { name: "order / soldier", ...started }] },
      { id: 3, created_at: "2026-11-08T02:00:00Z", jobs: [{ name: "order / soldier", ...started, conclusion: "skipped" }] },
      { id: 4, created_at: "2026-11-08T03:00:00Z", jobs: [{ name: "order / soldier", ...started, conclusion: "failure" }] },
    ];
    assert.equal(await countAgentRuns(gh, "me/realm", new Date("2026-11-08T00:00:00Z")), 2);
  });
});
