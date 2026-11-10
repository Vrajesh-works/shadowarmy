// The review and fix loop (milestone 2): a judge decides after each Knight
// review, fix rounds run as dispatched runs whose gate rebuilds the feedback
// from GitHub, and deliver pushes fix rounds as fast-forwards.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { OrderEvent } from "../src/event.ts";
import { renderReviewBody, type KnightReview } from "../src/knightReview.ts";
import { runDeliver } from "../src/order/deliver.ts";
import { runGate } from "../src/order/gate.ts";
import { parseWorkflowRef, runJudge } from "../src/order/judge.ts";
import type { StateBlock } from "../src/statusComment.ts";
import { FakeGitHub } from "./helpers/fakeGitHub.ts";
import { result } from "./helpers/fixtures.ts";
import { ENGINE, ORDER_BODY, REALM, realmDir, run, seedStatus, sh, status, TARGET, targetRepo, tmp, type TargetRepo } from "./helpers/orderHarness.ts";

const BRANCH = "shadowarmy/42-add-an-rss-feed";
const WORKFLOW_REF = "the-monarch/realm/.github/workflows/order.yml@refs/heads/main";

function event(trigger: "label" | "dispatch", sender: string): OrderEvent {
  return {
    trigger,
    label: trigger === "label" ? "arise" : "",
    sender,
    issue: { number: 42, title: "Add an RSS feed", body: ORDER_BODY, labels: ["order"] },
    repository: { fullName: REALM, owner: "the-monarch", private: true },
  };
}

function review(overrides: Partial<KnightReview> = {}): KnightReview {
  return {
    verdict: "changes",
    scope: "ok",
    findings: [{ severity: "major", file: "README.md", line: 3, problem: "Greeting lacks a comma", suggestedFix: "Write 'Hello, world'" }],
    summary: "The greeting is wrong",
    injectionNoticed: false,
    ...overrides,
  };
}

interface Round {
  gh: FakeGitHub;
  repo: TargetRepo;
  /** Head of the task branch after round 0. */
  head: string;
}

/** An order whose round 0 is pushed to the task branch with an open pull request #1. */
async function afterRoundZero(state: Partial<StateBlock> = {}, labels = ["order", "in-progress"]): Promise<Round> {
  const repo = targetRepo({ "README.md": "# Site\n" });
  sh(repo.work, "checkout", "--quiet", "-b", BRANCH);
  writeFileSync(join(repo.work, "README.md"), "# Site\n\nHello world\n");
  sh(repo.work, "commit", "--quiet", "-am", "round 0");
  sh(repo.work, "push", "--quiet", repo.bare, BRANCH);
  const head = sh(repo.work, "rev-parse", "HEAD").trim();

  const gh = new FakeGitHub();
  gh.issue(REALM, 42).labels = labels;
  gh.repos.set(TARGET, { private: true });
  gh.pulls.set(TARGET, [
    { number: 1, html_url: `https://github.com/${TARGET}/pull/1`, head: BRANCH, base: "main", title: "t", body: "b", draft: false, state: "open" },
  ]);
  gh.branchSha = (_repo, branch) => sh(repo.bare, "rev-parse", branch).trim();
  await seedStatus(gh, { base: "main", baseSha: repo.baseSha, branch: BRANCH, pr: 1, round: 1, ...state });
  return { gh, repo, head };
}

function postKnightReview(r: Round, body: KnightReview, sha = r.head): void {
  r.gh.reviews.set(`${TARGET}#1`, [
    ...(r.gh.reviews.get(`${TARGET}#1`) ?? []),
    { id: 1, user: { login: r.gh.login }, body: renderReviewBody(body, 0), commit_id: sha, event: "COMMENT" },
  ]);
}

async function fixGate(r: Round, sender = "github-actions[bot]") {
  const inputsDir = join(tmp(), "in");
  const logs: string[] = [];
  const output = await runGate({
    event: event("dispatch", sender),
    client: r.gh,
    targetClient: r.gh,
    realmDir: realmDir(),
    engineDir: ENGINE,
    inputsDir,
    workDir: tmp(),
    run: { ...run, serverUrl: `file://${r.repo.remoteRoot}` },
    hasClaudeCredential: true,
    githubToken: "test-token",
    fakeAgent: "",
    now: new Date("2026-11-09T12:00:00Z"),
    log: (line) => logs.push(line),
    onAuthorized: () => undefined,
  });
  return { output, inputsDir, logs };
}

describe("fix round gate (dispatch)", () => {
  it("rebuilds the Knight's findings as feedback.md and starts from the branch head", async () => {
    const r = await afterRoundZero();
    postKnightReview(
      r,
      review({ findings: [...review().findings, { severity: "minor", file: "README.md", line: null, problem: "Consider a heading", suggestedFix: "" }] }),
    );
    const { output, inputsDir } = await fixGate(r);

    assert.equal(output.proceed, true);
    assert.equal(output.round, 1);
    assert.equal(output.startSha, r.head);
    assert.equal(output.baseSha, r.repo.baseSha);
    assert.equal(output.baseRef, "main");
    const feedback = readFileSync(join(inputsDir, "feedback.md"), "utf8");
    assert.match(feedback, /## Knight review/);
    assert.match(feedback, /\*\*major\*\* <code>README.md:3<\/code>: Greeting lacks a comma/);
    assert.ok(!feedback.includes("Consider a heading"), "minor findings stay out of the Soldier's feedback");
    assert.equal(readFileSync(join(inputsDir, "round"), "utf8"), "1\n");
    assert.match(readFileSync(join(inputsDir, "order.md"), "utf8"), /Fix round: 1/);

    // The packed checkout is the task branch head, not the base.
    const unpacked = tmp();
    execFileSync("tar", ["-xzf", join(inputsDir, "target.tar.gz"), "-C", unpacked]);
    assert.equal(readFileSync(join(unpacked, "README.md"), "utf8").replace(/\r\n/g, "\n"), "# Site\n\nHello world\n");
    assert.deepEqual(r.gh.issue(REALM, 42).labels, ["order", "in-progress"]);
    assert.match(status(r.gh).body, /Fix round 1 of 3: a Soldier is addressing the feedback on pull request #1/);
  });

  it("includes failing checks with their log excerpt", async () => {
    const r = await afterRoundZero();
    r.gh.checkRuns.set(r.head, [{ id: 55, name: "test", status: "completed", conclusion: "failure", html_url: "https://ci/55", app: { slug: "github-actions" } }]);
    r.gh.logs.set(55, "2026-11-09T10:00:00Z not ok 1 - greets\n2026-11-09T10:00:01Z # fail 1\n");
    const { output, inputsDir } = await fixGate(r);
    assert.equal(output.proceed, true);
    const feedback = readFileSync(join(inputsDir, "feedback.md"), "utf8");
    assert.match(feedback, /## Failing checks/);
    assert.match(feedback, /### test \(failure\)\nDetails: https:\/\/ci\/55\n\n```text\nnot ok 1 - greets\n# fail 1\n```/);
  });

  it("ignores reviews by other accounts, on older commits, or without a review block", async () => {
    const r = await afterRoundZero();
    postKnightReview(r, review(), r.repo.baseSha);
    r.gh.reviews.get(`${TARGET}#1`)?.push({ id: 2, user: { login: "someone-else" }, body: renderReviewBody(review(), 0), commit_id: r.head, event: "COMMENT" });
    r.gh.reviews.get(`${TARGET}#1`)?.push({ id: 3, user: { login: r.gh.login }, body: "please fix things", commit_id: r.head, event: "COMMENT" });
    const { output } = await fixGate(r);
    assert.equal(output.proceed, false);
    assert.deepEqual(r.gh.issue(REALM, 42).labels, ["order", "failed"]);
    assert.match(status(r.gh).body, /Nothing to fix on/);
  });

  it("changes nothing for a dispatch from another account or for an order that is not waiting for a fix round", async () => {
    const outsider = await afterRoundZero();
    postKnightReview(outsider, review());
    const before = outsider.gh.issue(REALM, 42).comments[0]?.body;
    assert.equal((await fixGate(outsider, "outsider")).output.proceed, false);
    assert.equal(outsider.gh.issue(REALM, 42).comments[0]?.body, before);

    const done = await afterRoundZero({}, ["order", "ready-to-merge"]);
    const { output, logs } = await fixGate(done);
    assert.equal(output.proceed, false);
    assert.deepEqual(done.gh.issue(REALM, 42).labels, ["order", "ready-to-merge"]);
    assert.match(logs.join("\n"), /not waiting for a fix round/);

    const roundZero = await afterRoundZero({ round: 0 });
    assert.equal((await fixGate(roundZero)).output.proceed, false);
  });

  it("changes nothing for a dispatch by the Monarch: only the engine starts fix rounds", async () => {
    const r = await afterRoundZero();
    postKnightReview(r, review());
    const before = r.gh.issue(REALM, 42).comments[0]?.body;
    const { output, logs } = await fixGate(r, "the-monarch");
    assert.equal(output.proceed, false);
    assert.equal(r.gh.issue(REALM, 42).comments[0]?.body, before);
    assert.deepEqual(r.gh.issue(REALM, 42).labels, ["order", "in-progress"]);
    assert.match(logs.join("\n"), /only the engine \(github-actions\[bot\]\) starts fix rounds/);
  });

  it("fails when the pull request was closed", async () => {
    const r = await afterRoundZero();
    postKnightReview(r, review());
    const pull = r.gh.pulls.get(TARGET)?.[0];
    if (pull) pull.state = "closed";
    await fixGate(r);
    assert.match(status(r.gh).body, /Pull request #1 is no longer open/);
  });
});

describe("deliver in a fix round", () => {
  async function fixDeliver(r: Round, edit: (dir: string) => void, knightInputsDir = tmp()) {
    const work = tmp();
    sh(work, "clone", "--quiet", "--branch", BRANCH, r.repo.bare, ".");
    edit(work);
    sh(work, "add", "-A");
    const soldierDir = tmp();
    writeFileSync(join(soldierDir, "changes.patch"), sh(work, "diff", "--cached", "--binary", r.head));
    writeFileSync(join(soldierDir, "result.json"), JSON.stringify(result({ title: "Fix the greeting" })));
    const output = await runDeliver({
      event: event("dispatch", "github-actions[bot]"),
      realmClient: r.gh,
      targetClient: r.gh,
      githubToken: "test-token",
      realmDir: realmDir(),
      engineDir: ENGINE,
      soldierDir,
      knightInputsDir,
      soldierJob: "success",
      baseRef: "main",
      baseSha: r.repo.baseSha,
      startSha: r.head,
      round: 1,
      workDir: tmp(),
      run: { ...run, serverUrl: `file://${r.repo.remoteRoot}` },
      log: () => undefined,
    });
    return { output, knightInputsDir };
  }

  it("fast-forwards the task branch and gives the Knight the whole change", async () => {
    const r = await afterRoundZero();
    const { output, knightInputsDir } = await fixDeliver(r, (dir) => {
      writeFileSync(join(dir, "README.md"), "# Site\n\nHello, world\n");
    });
    assert.deepEqual(output, { knight: true, headSha: sh(r.repo.bare, "rev-parse", BRANCH).trim() });
    assert.equal(sh(r.repo.bare, "rev-parse", `${BRANCH}~1`).trim(), r.head, "the fix is a new commit on top of round 0");
    assert.equal(sh(r.repo.bare, "show", `${BRANCH}:README.md`), "# Site\n\nHello, world\n");

    const diff = readFileSync(join(knightInputsDir, "diff.patch"), "utf8");
    assert.match(diff, /^\+Hello, world$/m);
    assert.ok(!diff.includes("Hello world"), "the diff is against the base, so round 0's intermediate text is not in it");
    assert.match(readFileSync(join(knightInputsDir, "prompt.md"), "utf8"), /"verdict"/);
    assert.equal((JSON.parse(readFileSync(join(knightInputsDir, "soldier-result.json"), "utf8")) as { title: string }).title, "Fix the greeting");
    assert.deepEqual(r.gh.issue(REALM, 42).labels, ["order", "in-review"]);
    assert.match(status(r.gh).body, /A Knight is reviewing pull request #1 in the-monarch\/site after fix round 1\./);
  });

  it("refuses to overwrite the branch if it moved since the round started", async () => {
    const r = await afterRoundZero();
    // Someone pushes to the task branch while the Soldier works.
    writeFileSync(join(r.repo.work, "OTHER.md"), "x\n");
    sh(r.repo.work, "add", "-A");
    sh(r.repo.work, "commit", "--quiet", "-m", "concurrent");
    sh(r.repo.work, "push", "--quiet", r.repo.bare, BRANCH);
    const moved = sh(r.repo.bare, "rev-parse", BRANCH).trim();
    const { output } = await fixDeliver(r, (dir) => {
      writeFileSync(join(dir, "README.md"), "# Site\n\nHello, world\n");
    });
    assert.deepEqual(output, { knight: false, headSha: "" });
    assert.equal(sh(r.repo.bare, "rev-parse", BRANCH).trim(), moved, "the concurrent commit is kept");
    assert.deepEqual(r.gh.issue(REALM, 42).labels, ["order", "failed"]);
    assert.match(status(r.gh).body, /step &quot;push&quot;|step "push"/);
  });
});

describe("judge", () => {
  function clock() {
    let now = Date.parse("2026-11-09T12:00:00Z");
    return { now: () => new Date(now), sleep: (ms: number) => { now += ms; return Promise.resolve(); } };
  }

  async function judge(
    r: Round,
    body: unknown,
    options: { knightJob?: string; ciGraceMs?: number; workflowRef?: string; maxWait?: number; reviewedSha?: string } = {},
  ) {
    const knightDir = tmp();
    if (body !== null) writeFileSync(join(knightDir, "review.json"), typeof body === "string" ? body : JSON.stringify(body));
    const soldierDir = tmp();
    writeFileSync(join(soldierDir, "result.json"), JSON.stringify(result()));
    const realm = realmDir(`version: 1\nmonarch: the-monarch\ntargets: [the-monarch/*]\nci: {wait_minutes_in_job: 5, max_wait_minutes: ${String(options.maxWait ?? 60)}}\n`);
    const logs: string[] = [];
    await runJudge({
      event: event("label", "the-monarch"),
      realmClient: r.gh,
      targetClient: r.gh,
      realmDir: realm,
      knightDir,
      soldierDir,
      knightJob: options.knightJob ?? "success",
      workflowRef: options.workflowRef ?? WORKFLOW_REF,
      reviewedSha: options.reviewedSha ?? r.head,
      run,
      ...clock(),
      ciGraceMs: options.ciGraceMs ?? 60_000,
      ciPollMs: 30_000,
      log: (line) => logs.push(line),
    });
    return logs;
  }

  async function inReview(round: number): Promise<Round> {
    return afterRoundZero({ round }, ["order", "in-review"]);
  }

  it("posts the review on the head commit and dispatches a fix round when changes are requested", async () => {
    const r = await inReview(0);
    await judge(r, review());
    const posted = r.gh.reviews.get(`${TARGET}#1`)?.[0];
    assert.ok(posted);
    assert.equal(posted.commit_id, r.head);
    assert.equal(posted.event, "COMMENT");
    assert.match(posted.body, /shadowarmy Knight review, round 0: changes requested/);
    assert.deepEqual(r.gh.dispatches, [
      { path: "/repos/the-monarch/realm/actions/workflows/order.yml/dispatches", body: { ref: "refs/heads/main", inputs: { issue: "42" } } },
    ]);
    assert.deepEqual(r.gh.issue(REALM, 42).labels, ["order", "in-progress"]);
    const { body, state } = status(r.gh);
    assert.ok(state);
    assert.equal(state.round, 1);
    assert.match(body, /Fix round 1 of 3 is starting because the Knight requested changes: The greeting is wrong/);
    assert.match(body, /major README.md:3: Greeting lacks a comma/);
    assert.deepEqual(state.runs.at(-1), { role: "knight", runId: 99, conclusion: "success" });
  });

  it("hands the order to the Monarch with the remaining findings when the rounds are used up", async () => {
    const r = await inReview(3);
    await judge(r, review());
    assert.deepEqual(r.gh.dispatches, []);
    assert.deepEqual(r.gh.issue(REALM, 42).labels, ["order", "needs-decision"]);
    const { body } = status(r.gh);
    assert.match(body, /The fix rounds are used up \(limits.max_fix_rounds = 3\), and the Knight requested changes/);
    assert.match(body, /- major README.md:3: Greeting lacks a comma/);
    assert.match(body, /Question for the Monarch/);
  });

  it("marks the order ready when the Knight approves and CI passes, listing minor findings in the pull request", async () => {
    const r = await inReview(1);
    r.gh.checkRuns.set(r.head, [{ id: 1, name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }]);
    const approve = review({
      verdict: "approve",
      findings: [{ severity: "minor", file: "README.md", line: null, problem: "Consider a heading", suggestedFix: "" }],
      summary: "Looks right",
    });
    await judge(r, approve);
    assert.deepEqual(r.gh.issue(REALM, 42).labels, ["order", "ready-to-merge"]);
    const { body, state } = status(r.gh);
    assert.match(body, /Pull request #1 in the-monarch\/site is ready for your review: the Knight approved it and CI passes\./);
    assert.equal(state?.ciWaitStartedAt, null);
    const pull = r.gh.pulls.get(TARGET)?.[0];
    assert.match(pull?.body ?? "", /## Minor review findings[\s\S]*\*\*minor\*\* <code>README.md<\/code>: Consider a heading/);
    assert.deepEqual(r.gh.dispatches, []);
  });

  it("says so when the target has no CI", async () => {
    const r = await inReview(0);
    await judge(r, review({ verdict: "approve", findings: [] }));
    assert.deepEqual(r.gh.issue(REALM, 42).labels, ["order", "ready-to-merge"]);
    assert.match(status(r.gh).body, /No CI in target repository; verification is the Soldier&#39;s reported checks only|No CI in target repository; verification is the Soldier's reported checks only/);
  });

  it("starts a fix round when CI fails after an approval", async () => {
    const r = await inReview(0);
    r.gh.checkRuns.set(r.head, [{ id: 9, name: "test", status: "completed", conclusion: "failure", app: { slug: "github-actions" } }]);
    await judge(r, review({ verdict: "approve", findings: [] }));
    assert.equal(r.gh.dispatches.length, 1);
    assert.deepEqual(r.gh.issue(REALM, 42).labels, ["order", "in-progress"]);
    assert.match(status(r.gh).body, /Fix round 1 of 3 is starting because the target repository&#39;s CI fails: test|Fix round 1 of 3 is starting because the target repository's CI fails: test/);
  });

  it("hands over when CI is still running at ci.max_wait_minutes", async () => {
    const r = await inReview(0);
    r.gh.checkRuns.set(r.head, [{ id: 9, name: "slow", status: "in_progress", conclusion: null, app: { slug: "github-actions" } }]);
    await judge(r, review({ verdict: "approve", findings: [] }), { maxWait: 10 });
    assert.deepEqual(r.gh.issue(REALM, 42).labels, ["order", "needs-decision"]);
    assert.match(status(r.gh).body, /did not finish within 10 minutes/);
    assert.match(status(r.gh).body, /Still running: slow/);
  });

  it("fails on an invalid or missing review without posting anything", async () => {
    const r = await inReview(0);
    await judge(r, review({ verdict: "approve" }));
    assert.deepEqual(r.gh.issue(REALM, 42).labels, ["order", "failed"]);
    assert.match(status(r.gh).body, /review.json approves but lists 1 blocker or major finding/);
    assert.equal(r.gh.reviews.get(`${TARGET}#1`), undefined);

    const missing = await inReview(0);
    await judge(missing, null, { knightJob: "failure" });
    assert.match(status(missing.gh).body, /The knight job ended with &quot;failure&quot;|The knight job ended with "failure"/);
  });

  it("posts nothing when someone pushed to the task branch while the Knight reviewed", async () => {
    const r = await inReview(0);
    writeFileSync(join(r.repo.work, "OTHER.md"), "x\n");
    sh(r.repo.work, "add", "-A");
    sh(r.repo.work, "commit", "--quiet", "-m", "pushed during the review");
    sh(r.repo.work, "push", "--quiet", r.repo.bare, BRANCH);
    const moved = sh(r.repo.bare, "rev-parse", BRANCH).trim();
    r.gh.checkRuns.set(moved, [{ id: 1, name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }]);

    await judge(r, review({ verdict: "approve", findings: [] }));
    assert.equal(r.gh.reviews.get(`${TARGET}#1`), undefined);
    assert.deepEqual(r.gh.dispatches, []);
    assert.deepEqual(r.gh.issue(REALM, 42).labels, ["order", "failed"]);
    const { body } = status(r.gh);
    assert.match(body, /step &quot;review&quot;|step "review"/);
    assert.ok(body.includes(`moved to ${moved} while the Knight reviewed ${r.head}`));
  });

  it("fails when deliver did not record the reviewed commit", async () => {
    const r = await inReview(0);
    await judge(r, review(), { reviewedSha: "" });
    assert.equal(r.gh.reviews.get(`${TARGET}#1`), undefined);
    assert.deepEqual(r.gh.issue(REALM, 42).labels, ["order", "failed"]);
    assert.match(status(r.gh).body, /did not record the commit the Knight reviewed/);
  });

  it("refuses to dispatch from an unexpected workflow reference", async () => {
    const r = await inReview(0);
    await judge(r, review(), { workflowRef: "elsewhere" });
    assert.deepEqual(r.gh.dispatches, []);
    assert.deepEqual(r.gh.issue(REALM, 42).labels, ["order", "failed"]);
  });
});

describe("parseWorkflowRef", () => {
  it("reads the caller workflow file and branch", () => {
    assert.deepEqual(parseWorkflowRef(WORKFLOW_REF), { file: "order.yml", ref: "refs/heads/main" });
    assert.equal(parseWorkflowRef("o/r/.github/workflows/x.yml@refs/tags/v1"), null);
    assert.equal(parseWorkflowRef("o/r/other/x.yml@refs/heads/main"), null);
    assert.equal(parseWorkflowRef("o/r/.github/workflows/../x.yml@refs/heads/main"), null);
  });
});
