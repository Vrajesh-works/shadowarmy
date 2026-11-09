import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseIssueLabeledEvent } from "../src/event.ts";
import { runDeliver } from "../src/order/deliver.ts";
import { runFail } from "../src/order/fail.ts";
import { runGate, TARGET_ARCHIVE, type GateInput } from "../src/order/gate.ts";
import { RealmIssue } from "../src/realmIssue.ts";
import { parseStatusComment, type StateBlock } from "../src/statusComment.ts";
import { FakeGitHub } from "./helpers/fakeGitHub.ts";
import { labeledEvent, result } from "./helpers/fixtures.ts";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const REALM = "the-monarch/realm";
const TARGET = "the-monarch/site";
const run = { runId: 99, runUrl: "https://github.com/the-monarch/realm/actions/runs/99", serverUrl: "https://github.com" };

const ORDER_BODY = "### Target repository\n\nthe-monarch/site\n\n### Task\n\nAdd a greeting to README.md.\n\n### Base branch\n\n_No response_";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "shadowarmy-test-"));
}

function realmDir(config = "version: 1\nmonarch: the-monarch\ntargets: [the-monarch/*]\n"): string {
  const dir = tmp();
  writeFileSync(join(dir, "shadowarmy.yml"), config);
  mkdirSync(join(dir, "rules"));
  writeFileSync(join(dir, "rules", "company.md"), "Be careful.\n");
  return dir;
}

function status(gh: FakeGitHub): { body: string; state: StateBlock | null } {
  const comment = gh.issue(REALM, 42).comments[0];
  if (comment === undefined) return { body: "", state: null };
  const parsed = parseStatusComment(comment.body);
  return { body: comment.body, state: parsed.ok ? parsed.state : null };
}

/** Seed the status comment an earlier run left on the issue. */
async function seedStatus(gh: FakeGitHub, state: Partial<StateBlock>): Promise<void> {
  const block: StateBlock = {
    version: 1, kind: "order", target: TARGET, base: null, branch: "shadowarmy/42-add-an-rss-feed", pr: null,
    round: 0, runs: [], ciWaitStartedAt: null, lastError: null, parent: null, dependsOn: [], ...state,
  };
  await new RealmIssue(gh, REALM, 42).writeStatus({ state: "in-progress", summary: "Working." }, block);
}

async function gate(
  gh: FakeGitHub,
  overrides: Partial<GateInput> & { body?: string; sender?: string; label?: string; remote?: TargetRepo } = {},
) {
  const logs: string[] = [];
  let authorized = false;
  const remote = overrides.remote ?? targetRepo();
  const output = await runGate({
    event: parseIssueLabeledEvent(labeledEvent({ body: overrides.body ?? ORDER_BODY, sender: overrides.sender, label: overrides.label })),
    client: gh,
    realmDir: realmDir(),
    engineDir: ENGINE,
    inputsDir: join(tmp(), "in"),
    workDir: tmp(),
    run: { ...run, serverUrl: `file://${remote.remoteRoot}` },
    hasClaudeCredential: true,
    githubToken: "test-token",
    fakeAgent: "",
    now: new Date("2026-11-08T12:00:00Z"),
    log: (line) => logs.push(line),
    onAuthorized: () => {
      authorized = true;
    },
    ...overrides,
  });
  return { output, logs, authorized };
}

function freshIssue(labels = ["order", "arise"]): FakeGitHub {
  const gh = new FakeGitHub();
  gh.issue(REALM, 42).labels = labels;
  return gh;
}

describe("gate", () => {
  it("starts a valid order: in-progress, status comment, inputs and job outputs", async () => {
    const gh = freshIssue();
    const inputsDir = join(tmp(), "in");
    const remote = targetRepo();
    const { output, authorized } = await gate(gh, { inputsDir, remote });
    assert.deepEqual(output, {
      proceed: true,
      target: TARGET,
      baseRef: "main",
      baseSha: remote.baseSha,
      model: "sonnet",
      maxTurns: 150,
      timeoutMinutes: 45,
      fakeAgent: "",
    });
    assert.ok(authorized);
    assert.deepEqual(gh.issue(REALM, 42).labels, ["order", "in-progress"]);
    const { body, state } = status(gh);
    assert.match(body, /\*\*In progress\*\*: A Soldier is working on this order in the-monarch\/site\./);
    assert.ok(state);
    assert.equal(state.branch, "shadowarmy/42-add-an-rss-feed");
    assert.equal(state.target, TARGET);

    const prompt = readFileSync(join(inputsDir, "prompt.md"), "utf8");
    assert.ok(!prompt.includes("{{RESULT_SCHEMA}}") && prompt.includes('"injectionNoticed"'));
    assert.match(readFileSync(join(inputsDir, "task.md"), "utf8"), /Add a greeting to README.md/);
    assert.equal(readFileSync(join(inputsDir, "company.md"), "utf8"), "Be careful.\n");
    assert.ok(!existsSync(join(inputsDir, "project.md")));
    assert.ok(!existsSync(join(inputsDir, "fake-agent.sh")));
  });

  it("changes nothing for arise from any account other than the Monarch", async () => {
    const gh = freshIssue();
    const { output, logs, authorized } = await gate(gh, { sender: "outsider" });
    assert.deepEqual(output, { proceed: false });
    assert.ok(!authorized);
    assert.deepEqual(gh.issue(REALM, 42).labels, ["order", "arise"]);
    assert.deepEqual(gh.issue(REALM, 42).comments, []);
    assert.ok(gh.calls.every((call) => call.startsWith("GET")), gh.calls.join("\n"));
    assert.match(logs.join("\n"), /outsider is not the Monarch/);
  });

  it("ignores labels other than arise", async () => {
    const gh = freshIssue();
    assert.deepEqual((await gate(gh, { label: "bug" })).output, { proceed: false });
    assert.deepEqual(gh.calls, []);
  });

  it("fails with the exact keys when shadowarmy.yml is invalid, but only for the Realm owner", async () => {
    const gh = freshIssue();
    await gate(gh, { realmDir: realmDir("version: 1\ntargets: []\nlimits: {max_turns: 0}\n") });
    assert.deepEqual(gh.issue(REALM, 42).labels, ["order", "failed"]);
    assert.match(status(gh).body, /targets: must NOT have fewer than 1 items/);
    assert.match(status(gh).body, /limits.max_turns: must be &gt;= 1/);

    const outsider = freshIssue();
    await gate(outsider, { sender: "outsider", realmDir: realmDir("nonsense: [") });
    assert.deepEqual(outsider.issue(REALM, 42).labels, ["order", "arise"]);
  });

  it("with an invalid shadowarmy.yml, only removes arise from an order arise cannot restart", async () => {
    for (const final of ["ready-to-merge", "done", "dismissed"]) {
      const gh = freshIssue(["order", final, "arise"]);
      await seedStatus(gh, { pr: 7 });
      const before = gh.issue(REALM, 42).comments[0]?.body;
      const { output } = await gate(gh, { realmDir: realmDir("nonsense: [") });
      assert.equal(output.proceed, false);
      assert.deepEqual(gh.issue(REALM, 42).labels, ["order", final]);
      assert.equal(gh.issue(REALM, 42).comments[0]?.body, before, "the status comment is untouched");
    }
  });

  it("keeps the recorded branch, pull request and runs when it fails on an invalid shadowarmy.yml", async () => {
    const gh = freshIssue(["order", "failed", "arise"]);
    const runs = [{ role: "soldier" as const, runId: 5, conclusion: "failure" as const }];
    await seedStatus(gh, { pr: 7, runs });
    await gate(gh, { realmDir: realmDir("nonsense: [") });
    assert.deepEqual(gh.issue(REALM, 42).labels, ["order", "failed"]);
    const { body, state } = status(gh);
    assert.match(body, /step &quot;load configuration&quot;|step "load configuration"/);
    assert.ok(state);
    assert.equal(state.pr, 7);
    assert.equal(state.branch, "shadowarmy/42-add-an-rss-feed");
    assert.deepEqual(state.runs, runs);
  });

  it("fails orders whose body does not match the form, or whose target is not allowed", async () => {
    const gh = freshIssue();
    await gate(gh, { body: "please do things" });
    assert.deepEqual(gh.issue(REALM, 42).labels, ["order", "failed"]);
    assert.match(status(gh).body, /does not match the Order form/);

    const other = freshIssue();
    await gate(other, { body: ORDER_BODY.replace("the-monarch/site", "someone-else/site") });
    assert.match(status(other).body, /not listed in targets/);

    const realm = freshIssue();
    await gate(realm, { body: ORDER_BODY.replace("the-monarch/site", "the-monarch/realm") });
    assert.match(status(realm).body, /Realm cannot be its own target/);
  });

  it("fails clearly when secrets are missing", async () => {
    const gh = freshIssue();
    await gate(gh, { hasClaudeCredential: false, githubToken: "" });
    assert.match(status(gh).body, /Missing Realm secrets: SHADOWARMY_GH_TOKEN; CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY\./);
  });

  it("queues the order when the daily cap is reached", async () => {
    const gh = freshIssue();
    const job = { name: "order / soldier", status: "completed", conclusion: "success", started_at: "2026-11-08T01:00:00Z" };
    gh.runs = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, created_at: "2026-11-08T01:00:00Z", jobs: [job] }));
    const { output } = await gate(gh);
    assert.equal(output.proceed, false);
    assert.deepEqual(gh.issue(REALM, 42).labels, ["order", "queued"]);
    assert.match(status(gh).body, /Agent runs today: 30 of 30/);
  });

  it("packs the target at the head of the default branch for the soldier job", async () => {
    const remote = targetRepo(undefined, "trunk");
    const inputsDir = join(tmp(), "in");
    const { output } = await gate(freshIssue(), { inputsDir, remote });
    assert.equal(output.baseRef, "trunk");
    assert.equal(output.baseSha, remote.baseSha);

    const work = tmp();
    execFileSync("tar", ["-xzf", "-"], { cwd: work, input: readFileSync(join(inputsDir, TARGET_ARCHIVE)) });
    assert.equal(sh(work, "rev-parse", "HEAD").trim(), remote.baseSha);
    assert.equal(sh(work, "rev-parse", "--abbrev-ref", "HEAD").trim(), "trunk");
    assert.equal(sh(work, "status", "--porcelain"), "", "the checkout is clean");
    const config = readFileSync(join(work, ".git", "config"), "utf8");
    assert.ok(!config.includes("test-token") && !config.includes("extraheader"), "no credential is stored in the checkout");
  });

  it("checks out the base branch the order names", async () => {
    const remote = targetRepo();
    writeFileSync(join(remote.work, "CHANGELOG.md"), "release\n");
    sh(remote.work, "checkout", "--quiet", "-b", "release");
    sh(remote.work, "add", "-A");
    sh(remote.work, "commit", "--quiet", "-m", "release");
    sh(remote.work, "push", "--quiet", remote.bare, "release");
    const releaseSha = sh(remote.work, "rev-parse", "HEAD").trim();

    const { output } = await gate(freshIssue(), { remote, body: ORDER_BODY.replace("_No response_", "release") });
    assert.equal(output.baseRef, "release");
    assert.equal(output.baseSha, releaseSha);
    assert.notEqual(releaseSha, remote.baseSha);
  });

  it("fails at check out target when the base branch does not exist, before starting the order", async () => {
    const gh = freshIssue();
    const inputsDir = join(tmp(), "in");
    const { output } = await gate(gh, { inputsDir, body: ORDER_BODY.replace("_No response_", "no-such-branch") });
    assert.deepEqual(output, { proceed: false });
    assert.deepEqual(gh.issue(REALM, 42).labels, ["order", "failed"]);
    const { body } = status(gh);
    assert.match(body, /step &quot;check out target&quot;|step "check out target"/);
    assert.match(body, /refs\/heads\/no-such-branch/);
    assert.match(body, /Check that SHADOWARMY_GH_TOKEN can read the-monarch\/site and that the base branch exists\./);
    assert.ok(!existsSync(join(inputsDir, "prompt.md")));
  });

  it("does not restart an order that is already past the Soldier", async () => {
    const gh = freshIssue(["order", "ready-to-merge", "arise"]);
    const { output, logs } = await gate(gh);
    assert.equal(output.proceed, false);
    assert.deepEqual(gh.issue(REALM, 42).labels, ["order", "ready-to-merge"]);
    assert.match(logs.join("\n"), /arise cannot restart/);
  });

  it("restarts a failed order and keeps its run history", async () => {
    const gh = freshIssue(["order", "failed", "arise"]);
    await gate(gh, { body: "broken" });
    await gate(gh);
    assert.deepEqual(gh.issue(REALM, 42).labels, ["order", "in-progress"]);
    assert.equal(gh.issue(REALM, 42).comments.length, 1, "the status comment is edited in place");
  });

  it("passes a known fake agent scenario through and rejects unknown ones", async () => {
    const gh = freshIssue();
    const inputsDir = join(tmp(), "in");
    const { output } = await gate(gh, { fakeAgent: "edit-claude-md", hasClaudeCredential: false, inputsDir });
    assert.equal(output.fakeAgent, "edit-claude-md");
    assert.ok(existsSync(join(inputsDir, "fake-agent.sh")));

    const bad = freshIssue();
    await gate(bad, { fakeAgent: "rm -rf" });
    assert.match(status(bad).body, /SHADOWARMY_FAKE_AGENT is &quot;rm -rf&quot;|SHADOWARMY_FAKE_AGENT is "rm -rf"/);
  });
});

// ---- deliver: real git against a local bare repository standing in for the target ----

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

interface TargetRepo {
  remoteRoot: string;
  bare: string;
  baseSha: string;
  work: string;
}

interface Fixture extends TargetRepo {
  gh: FakeGitHub;
  soldierDir: string;
}

/** A bare target repository under `file://<remoteRoot>/the-monarch/site.git` with one commit on its default branch, and a working copy. */
function targetRepo(files: Record<string, string> = { "README.md": "# Site\n" }, defaultBranch = "main"): TargetRepo {
  const remoteRoot = tmp();
  const bare = join(remoteRoot, "the-monarch", "site.git");
  mkdirSync(bare, { recursive: true });
  sh(bare, "init", "--bare", "--quiet", `--initial-branch=${defaultBranch}`);
  const work = tmp();
  sh(work, "init", "--quiet", `--initial-branch=${defaultBranch}`);
  for (const [path, text] of Object.entries(files)) writeFileSync(join(work, path), text);
  sh(work, "add", "-A");
  sh(work, "commit", "--quiet", "-m", "initial");
  sh(work, "push", "--quiet", bare, defaultBranch);
  return { remoteRoot, bare, baseSha: sh(work, "rev-parse", "HEAD").trim(), work };
}

/** A target repository, its working copy, and an empty soldier output folder. */
function fixture(files: Record<string, string> = { "README.md": "# Site\n" }): Fixture {
  const gh = freshIssue(["order", "in-progress"]);
  gh.repos.set(TARGET, { private: true });
  return { ...targetRepo(files), gh, soldierDir: tmp() };
}

/** Simulate the soldier job: edit the working copy, then write changes.patch and result.json. */
function soldier(f: Fixture, edit: (dir: string) => void, res: object | null = result()): void {
  edit(f.work);
  sh(f.work, "add", "-A");
  writeFileSync(join(f.soldierDir, "changes.patch"), sh(f.work, "diff", "--cached", "--binary", f.baseSha));
  if (res !== null) writeFileSync(join(f.soldierDir, "result.json"), JSON.stringify(res));
}

async function deliver(f: Fixture, options: { body?: string; soldierJob?: string; state?: Partial<StateBlock> } = {}) {
  // Seed the status comment the gate would have written.
  if (f.gh.issue(REALM, 42).comments.length === 0) await seedStatus(f.gh, options.state ?? {});

  await runDeliver({
    event: parseIssueLabeledEvent(labeledEvent({ body: options.body ?? ORDER_BODY })),
    realmClient: f.gh,
    targetClient: f.gh,
    githubToken: "test-token",
    realmDir: realmDir(),
    soldierDir: f.soldierDir,
    soldierJob: options.soldierJob ?? "success",
    baseSha: f.baseSha,
    baseRef: "main",
    workDir: tmp(),
    run: { ...run, serverUrl: `file://${f.remoteRoot}` },
    log: () => undefined,
  });
}

function remoteFile(f: Fixture, branch: string, path: string): string {
  return sh(f.bare, "show", `${branch}:${path}`);
}

describe("deliver", () => {
  it("pushes the change to the task branch and opens a pull request", async () => {
    const f = fixture();
    soldier(f, (dir) => { writeFileSync(join(dir, "README.md"), "# Site\n\nHello!\n"); });
    await deliver(f);

    assert.equal(remoteFile(f, "shadowarmy/42-add-an-rss-feed", "README.md"), "# Site\n\nHello!\n");
    const log = sh(f.bare, "log", "-1", "--format=%an <%ae>%n%s%n%b", "shadowarmy/42-add-an-rss-feed");
    assert.match(log, /^shadowarmy <shadowarmy@users.noreply.github.com>\nAdd RSS feed at \/rss.xml\n/);
    assert.ok(!/co-authored-by/i.test(log));
    assert.equal(sh(f.bare, "rev-parse", "main").trim(), f.baseSha, "the default branch is untouched");

    const [pull] = f.gh.pulls.get(TARGET) ?? [];
    assert.ok(pull);
    assert.equal(pull.head, "shadowarmy/42-add-an-rss-feed");
    assert.equal(pull.base, "main");
    assert.equal(pull.title, "Add RSS feed at /rss.xml");
    assert.ok(pull.body.includes(`[issue #42](file://${f.remoteRoot}/the-monarch/realm/issues/42)`), "private targets link the Realm issue");

    assert.deepEqual(f.gh.issue(REALM, 42).labels, ["order", "ready-to-merge"]);
    const { body, state } = status(f.gh);
    assert.match(body, /Pull request #1 in the-monarch\/site is ready for your review/);
    assert.ok(state);
    assert.equal(state.pr, 1);
    assert.deepEqual(state.runs, [{ role: "soldier", runId: 99, conclusion: "success" }]);
  });

  it("leaves the target clean: only the requested change, no shadowarmy files", async () => {
    const f = fixture();
    soldier(f, (dir) => { writeFileSync(join(dir, "README.md"), "# Site\n\nHello!\n"); });
    await deliver(f);
    const files = sh(f.bare, "ls-tree", "-r", "--name-only", "shadowarmy/42-add-an-rss-feed").trim().split("\n");
    assert.deepEqual(files, ["README.md"]);
  });

  it("rejects an unrequested CLAUDE.md edit with the diff guard and pushes nothing", async () => {
    const f = fixture({ "README.md": "# Site\n", "CLAUDE.md": "Notes\n" });
    soldier(f, (dir) => { writeFileSync(join(dir, "CLAUDE.md"), "Notes\nMore\n"); });
    await deliver(f);
    assert.deepEqual(f.gh.issue(REALM, 42).labels, ["order", "failed"]);
    assert.match(status(f.gh).body, /step &quot;diff guard&quot;|step "diff guard"/);
    assert.match(status(f.gh).body, /CLAUDE.md: agent instructions file; the order does not ask for it/);
    assert.equal(sh(f.bare, "branch", "--list").trim(), "* main");
    assert.equal(f.gh.pulls.get(TARGET), undefined);
  });

  it("allows CLAUDE.md when the order names it", async () => {
    const f = fixture({ "README.md": "# Site\n", "CLAUDE.md": "Notes\n" });
    soldier(f, (dir) => { writeFileSync(join(dir, "CLAUDE.md"), "Notes\nMore\n"); });
    await deliver(f, { body: ORDER_BODY.replace("Add a greeting to README.md.", "Add a testing note to CLAUDE.md.") });
    assert.deepEqual(f.gh.issue(REALM, 42).labels, ["order", "ready-to-merge"]);
    assert.match(status(f.gh).body, /Allowed because the order names them: CLAUDE.md/);
  });

  it("rejects a submodule added by the Soldier with the diff guard", async () => {
    const f = fixture();
    soldier(f, (dir) => {
      const nested = join(dir, "vendor", "lib");
      mkdirSync(nested, { recursive: true });
      sh(nested, "init", "--quiet");
      writeFileSync(join(nested, "lib.txt"), "lib\n");
      sh(nested, "add", "-A");
      sh(nested, "commit", "--quiet", "-m", "lib");
    });
    assert.match(readFileSync(join(f.soldierDir, "changes.patch"), "utf8"), /Subproject commit [0-9a-f]{40}/);
    await deliver(f);
    assert.deepEqual(f.gh.issue(REALM, 42).labels, ["order", "failed"]);
    assert.match(status(f.gh).body, /step &quot;diff guard&quot;|step "diff guard"/);
    assert.match(status(f.gh).body, /vendor\/lib: submodule changes are not allowed/);
    assert.equal(sh(f.bare, "branch", "--list").trim(), "* main");
  });

  it("reads agent-chosen file names literally, not as git pathspec or revision syntax", { skip: process.platform === "win32" && "git on Windows rejects file names with colons" }, async () => {
    const f = fixture({ "README.md": "# Site\n", small: "x\n" });
    soldier(f, (dir) => {
      writeFileSync(join(dir, "notes.md"), "<!-- shadowarmy:state {} -->\n");
      writeFileSync(join(dir, ":(exclude)notes.md"), "hide the marker\n");
      writeFileSync(join(dir, "0:small"), Buffer.alloc(6 * 1024 * 1024, 97));
    });
    await deliver(f);
    assert.deepEqual(f.gh.issue(REALM, 42).labels, ["order", "failed"]);
    const { body } = status(f.gh);
    assert.match(body, /notes.md: contains a shadowarmy status or state marker/);
    assert.match(body, /0:small: is 6.0 MB, over the 5 MB limit/);
    assert.equal(sh(f.bare, "branch", "--list").trim(), "* main");
  });

  it("rejects files carrying shadowarmy markers", async () => {
    const f = fixture();
    soldier(f, (dir) => { writeFileSync(join(dir, "notes.md"), "<!-- shadowarmy:state {} -->\n"); });
    await deliver(f);
    assert.match(status(f.gh).body, /notes.md: contains a shadowarmy status or state marker/);
  });

  it("fails done-without-changes", async () => {
    const f = fixture();
    soldier(f, () => undefined);
    await deliver(f);
    assert.deepEqual(f.gh.issue(REALM, 42).labels, ["order", "failed"]);
    assert.match(status(f.gh).body, /reported done but produced no changes/);
  });

  it("fails on a Soldier that could not do the task, with its reason", async () => {
    const f = fixture();
    soldier(f, () => undefined, result({ status: "failed", summary: "The repository has no web server to add a page to." }));
    await deliver(f);
    assert.match(status(f.gh).body, /The Soldier could not complete the task: The repository has no web server/);
  });

  it("fails on an unparsable or missing result", async () => {
    const f = fixture();
    soldier(f, (dir) => { writeFileSync(join(dir, "x.txt"), "x"); }, null);
    writeFileSync(join(f.soldierDir, "result.json"), "{ not json");
    await deliver(f);
    assert.match(status(f.gh).body, /result.json is not valid JSON/);
    assert.deepEqual(f.gh.issue(REALM, 42).labels, ["order", "failed"]);

    const g = fixture();
    writeFileSync(join(g.soldierDir, "claude.json"), JSON.stringify({ subtype: "error_max_turns" }));
    await deliver(g, { soldierJob: "failure" });
    assert.match(status(g.gh).body, /used all 150 turns/);
    assert.deepEqual(status(g.gh).state?.runs, [{ role: "soldier", runId: 99, conclusion: "failure" }]);
  });

  it("moves a blocked Soldier to needs-decision with its question", async () => {
    const f = fixture();
    soldier(f, () => undefined, result({ status: "blocked", question: "Keep the old URL working?" }));
    await deliver(f);
    assert.deepEqual(f.gh.issue(REALM, 42).labels, ["order", "needs-decision"]);
    assert.match(status(f.gh).body, /> Keep the old URL working\?/);
  });

  it("updates the existing pull request when the order runs again", async () => {
    const f = fixture();
    soldier(f, (dir) => { writeFileSync(join(dir, "README.md"), "# Site\n\nHello!\n"); });
    await deliver(f);
    f.gh.issue(REALM, 42).labels = ["order", "in-progress"];
    soldier(f, (dir) => { writeFileSync(join(dir, "README.md"), "# Site\n\nHello again!\n"); });
    await deliver(f);
    assert.equal(f.gh.pulls.get(TARGET)?.length, 1);
    assert.equal(remoteFile(f, "shadowarmy/42-add-an-rss-feed", "README.md"), "# Site\n\nHello again!\n");
  });

  it("refuses to push anything but a shadowarmy task branch", async () => {
    const f = fixture();
    soldier(f, (dir) => { writeFileSync(join(dir, "README.md"), "changed\n"); });
    await deliver(f, { state: { branch: null } });
    // A null branch falls back to the generated task branch.
    assert.deepEqual(f.gh.issue(REALM, 42).labels, ["order", "ready-to-merge"]);
    assert.equal(sh(f.bare, "rev-parse", "main").trim(), f.baseSha);
  });
});

describe("report-failure", () => {
  it("marks a still-running order failed", async () => {
    const gh = freshIssue(["order", "in-progress"]);
    await runFail({
      event: parseIssueLabeledEvent(labeledEvent()),
      client: gh,
      run,
      jobs: { gate: "success", soldier: "success", deliver: "failure" },
      log: () => undefined,
    });
    assert.deepEqual(gh.issue(REALM, 42).labels, ["order", "failed"]);
    assert.match(status(gh).body, /The deliver job failed unexpectedly/);
  });

  it("marks a retried or continued order failed when the gate crashed before reporting", async () => {
    for (const previous of ["failed", "needs-decision", "queued"]) {
      const gh = freshIssue(["order", previous, "arise"]);
      await runFail({ event: parseIssueLabeledEvent(labeledEvent()), client: gh, run, jobs: { gate: "failure" }, log: () => undefined });
      assert.deepEqual(gh.issue(REALM, 42).labels, ["order", "failed"]);
      assert.match(status(gh).body, /The gate job failed unexpectedly/);
    }
  });

  it("leaves an order arise cannot restart alone, even when arise is still on it", async () => {
    const gh = freshIssue(["order", "done", "arise"]);
    await runFail({ event: parseIssueLabeledEvent(labeledEvent()), client: gh, run, jobs: { gate: "failure" }, log: () => undefined });
    assert.deepEqual(gh.issue(REALM, 42).labels, ["order", "done", "arise"]);
    assert.deepEqual(gh.issue(REALM, 42).comments, []);
  });

  it("never overwrites an outcome that was already reported", async () => {
    const gh = freshIssue(["order", "needs-decision"]);
    await runFail({ event: parseIssueLabeledEvent(labeledEvent()), client: gh, run, jobs: { gate: "failure" }, log: () => undefined });
    assert.deepEqual(gh.issue(REALM, 42).labels, ["order", "needs-decision"]);
    assert.deepEqual(gh.issue(REALM, 42).comments, []);
  });
});
