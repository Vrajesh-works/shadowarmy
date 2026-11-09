import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkTarget, DEFAULTS, parseConfig, type Config, type ConfigResult } from "../src/config.ts";
import { formatIssues, type ValidationIssue } from "../src/schema.ts";

const realm = { owner: "monarch-login", repo: "realm" };

function fixture(name: string): string {
  return readFileSync(new URL(`fixtures/config/${name}`, import.meta.url), "utf8");
}

function valid(result: ConfigResult): Config {
  if (!result.ok) assert.fail(`expected a valid config, got:\n${formatIssues(result.issues)}`);
  return result.config;
}

function issuesOf(text: string): ValidationIssue[] {
  const result = parseConfig(text, realm);
  if (result.ok) assert.fail("expected the config to be rejected");
  return result.issues;
}

function assertIssue(issues: ValidationIssue[], path: string, message: RegExp): void {
  assert.ok(
    issues.some((issue) => issue.path === path && message.test(issue.message)),
    `expected an issue at ${path} matching ${String(message)}, got:\n${formatIssues(issues)}`,
  );
}

describe("parseConfig", () => {
  it("applies every default to a minimal file", () => {
    const config = valid(parseConfig("version: 1\ntargets: [someone/*]\n", realm));
    assert.deepEqual(config, { version: 1, monarch: "monarch-login", targets: ["someone/*"], ...DEFAULTS });
  });

  it("defaults monarch to the Realm owner", () => {
    assert.equal(valid(parseConfig("version: 1\ntargets: [a/b]\n", realm)).monarch, "monarch-login");
  });

  it("keeps every value of a full file", () => {
    const config = valid(parseConfig(fixture("full.yml"), realm));
    assert.equal(config.monarch, "the-monarch");
    assert.deepEqual(config.targets, ["the-monarch/*", "some-org/site"]);
    assert.equal(config.approval.plan, "always");
    assert.deepEqual(config.limits, {
      max_turns: 40,
      run_timeout_minutes: 30,
      max_fix_rounds: 0,
      max_concurrent_soldiers: 2,
      max_runs_per_day: 10,
      max_file_size_mb: 2,
    });
    assert.deepEqual(config.ci, { wait_minutes_in_job: 10, max_wait_minutes: 60, log_excerpt_lines: 100 });
    assert.equal(config.sentinel.interval_minutes, 5);
    assert.deepEqual(config.roles.scout, { enabled: true, model: "claude-sonnet-5-5" });
    assert.equal(config.git.author, "Army Bot <army@example.com>");
    assert.deepEqual(config.pr, { draft: true, link_realm: true });
    assert.equal(config.timezone, "Europe/Berlin");
  });

  it("merges a partial section with its defaults", () => {
    const config = valid(parseConfig("version: 1\ntargets: [a/b]\nlimits:\n  max_turns: 40\n", realm));
    assert.equal(config.limits.max_turns, 40);
    assert.equal(config.limits.max_fix_rounds, DEFAULTS.limits.max_fix_rounds);
  });

  it("treats an empty value as the default", () => {
    const config = valid(parseConfig("version: 1\ntargets: [a/b]\nlimits:\n  max_turns:\nci:\n", realm));
    assert.equal(config.limits.max_turns, DEFAULTS.limits.max_turns);
    assert.deepEqual(config.ci, DEFAULTS.ci);
  });

  it("accepts the documented example in docs/configuration.md with the documented defaults", () => {
    const doc = readFileSync(new URL("../docs/configuration.md", import.meta.url), "utf8");
    const example = /```yaml\n(version: 1\n[\s\S]*?)```/.exec(doc)?.[1];
    assert.ok(example, "docs/configuration.md must contain the shadowarmy.yml example");
    const config = valid(parseConfig(example, realm));
    const { version, monarch, targets, ...rest } = config;
    assert.equal(version, 1);
    assert.equal(monarch, "your-github-login");
    assert.deepEqual(targets, ["your-github-login/*"]);
    assert.deepEqual(rest, DEFAULTS, "the documented example and DEFAULTS must agree");
  });
});

describe("parseConfig validation errors", () => {
  it("reports every problem with its exact key", () => {
    const issues = issuesOf(fixture("many-errors.yml"));
    assertIssue(issues, "version", /must be 1/);
    assertIssue(issues, "monarch", /GitHub login/);
    assertIssue(issues, "targets[1]", /owner\/name/);
    assertIssue(issues, "approval.plan", /one of: "always", "multi-task", "never"/);
    assertIssue(issues, "limits.max_turns", /must be integer/);
    assertIssue(issues, "limits.run_timeout_minutes", /<= 360/);
    assertIssue(issues, "limits.max_concurrent_soldiers", />= 1/);
    assertIssue(issues, "limits.max_turn", /not a known key/);
    assertIssue(issues, "sentinel.interval_minutes", />= 5/);
    assertIssue(issues, "roles.soldier.model", /model name/);
    assertIssue(issues, "roles.scout.enabled", /must be boolean/);
    assertIssue(issues, "git.author", /Name <email>/);
    assertIssue(issues, "pr.draft", /must be boolean/);
    assertIssue(issues, "colour", /not a known key/);
    assert.equal(issues.length, 14, formatIssues(issues));
  });

  it("requires version and targets", () => {
    const issues = issuesOf("monarch: someone\n");
    assertIssue(issues, "version", /is required/);
    assertIssue(issues, "targets", /is required/);
  });

  it("rejects an empty targets list", () => {
    assertIssue(issuesOf("version: 1\ntargets: []\n"), "targets", /fewer than 1/);
  });

  it("rejects duplicate targets", () => {
    assertIssue(issuesOf("version: 1\ntargets: [a/b, a/b]\n"), "targets", /duplicate/);
  });

  it("rejects an empty file and a non-mapping", () => {
    assertIssue(issuesOf(""), "", /mapping/);
    assertIssue(issuesOf("- a\n- b\n"), "", /mapping/);
    assertIssue(issuesOf("just a string\n"), "", /mapping/);
  });

  it("rejects invalid YAML and duplicate keys", () => {
    assertIssue(issuesOf("version: 1\ntargets: [a/b\n"), "", /invalid YAML/);
    assertIssue(issuesOf("version: 1\nversion: 1\ntargets: [a/b]\n"), "", /invalid YAML.*[Uu]nique/s);
  });

  it("rejects an unknown time zone", () => {
    assertIssue(issuesOf("version: 1\ntargets: [a/b]\ntimezone: Mars/Olympus\n"), "timezone", /IANA/);
  });

  it("rejects a CI wait that cannot fit in the job", () => {
    const issues = issuesOf("version: 1\ntargets: [a/b]\nlimits: {run_timeout_minutes: 20}\nci: {wait_minutes_in_job: 20}\n");
    assertIssue(issues, "ci.wait_minutes_in_job", /less than limits.run_timeout_minutes \(20\)/);
  });

  it("rejects a total CI wait shorter than the in-job wait", () => {
    const issues = issuesOf("version: 1\ntargets: [a/b]\nci: {wait_minutes_in_job: 30, max_wait_minutes: 10}\n");
    assertIssue(issues, "ci.max_wait_minutes", /at least ci.wait_minutes_in_job \(30\)/);
  });

  it("does not expand an alias bomb", () => {
    const bomb = [
      "a: &a [x, x, x, x, x, x, x, x, x, x]",
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]",
      "version: 1",
      "targets: [a/b]",
    ].join("\n");
    assertIssue(issuesOf(bomb), "", /invalid YAML.*alias/is);
  });

  it("formats issues one per line", () => {
    assert.equal(
      formatIssues([{ path: "limits.max_turns", message: "must be integer" }, { path: "", message: "bad" }], "shadowarmy.yml: "),
      "shadowarmy.yml: limits.max_turns: must be integer\nshadowarmy.yml: (root): bad",
    );
  });
});

describe("checkTarget", () => {
  const config = valid(parseConfig("version: 1\ntargets: [monarch-login/*, other/site]\n", realm));

  it("allows an exact entry and an owner wildcard, ignoring case", () => {
    assert.deepEqual(checkTarget(config, "other/site", realm), { ok: true });
    assert.deepEqual(checkTarget(config, "Other/Site", realm), { ok: true });
    assert.deepEqual(checkTarget(config, "monarch-login/anything", realm), { ok: true });
  });

  it("refuses repositories that are not listed", () => {
    const result = checkTarget(config, "other/elsewhere", realm);
    assert.equal(result.ok, false);
    assert.match(result.reason, /not listed in targets/);
  });

  it("refuses the Realm itself even when a wildcard covers it", () => {
    const result = checkTarget(config, "Monarch-Login/Realm", realm);
    assert.equal(result.ok, false);
    assert.match(result.reason, /Realm cannot be its own target/);
  });

  it("refuses malformed names", () => {
    for (const target of ["", "a", "a/b/c", "a/*", "../x", "a/..", "-a/b"]) {
      assert.equal(checkTarget(config, target, realm).ok, false, target);
    }
  });
});
