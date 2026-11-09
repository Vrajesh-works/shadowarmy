import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { DEFAULTS, parseConfig } from "../src/config.ts";
import { ORDER_FORM } from "../src/issueForm.ts";
import { FAKE_AGENT_SCENARIOS } from "../src/order/gate.ts";
import { checkSoldierResult } from "../src/soldierResult.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

interface FormField {
  type: string;
  id: string;
  attributes: { label: string };
  validations?: { required?: boolean };
}

describe("Realm template", () => {
  it("has an Order form whose fields match the parser, in order", () => {
    const form = parse(read("template/.github/ISSUE_TEMPLATE/order.yml")) as { labels: string[]; body: FormField[] };
    assert.deepEqual(form.labels, ["order"]);
    assert.deepEqual(
      form.body.map((field) => ({ id: field.id, label: field.attributes.label, kind: field.type === "textarea" ? "text" : "line" })),
      ORDER_FORM.fields.map((field) => ({ id: field.id, label: field.label, kind: field.kind })),
    );
    assert.deepEqual(form.body.map((field) => field.validations?.required === true), [true, true, false]);
  });

  it("ships a valid shadowarmy.yml with the documented defaults", () => {
    const result = parseConfig(read("template/shadowarmy.yml"), { owner: "someone", repo: "realm" });
    assert.ok(result.ok);
    const { version, monarch, targets, ...rest } = result.config;
    assert.deepEqual({ version, monarch, targets }, { version: 1, monarch: "your-github-login", targets: ["your-github-login/*"] });
    assert.deepEqual(rest, DEFAULTS);
  });

  it("has a caller workflow that only filters arise, serializes arise runs per issue and grants minimal permissions", () => {
    const workflow = parse(read("template/.github/workflows/order.yml")) as Record<string, unknown>;
    assert.deepEqual(workflow.on, { issues: { types: ["labeled"] } });
    assert.deepEqual(workflow.permissions, { contents: "read", issues: "write", actions: "read" });
    assert.equal(workflow.concurrency, undefined);
    const job = (workflow.jobs as Record<string, Record<string, unknown> | undefined>).order;
    assert.ok(job);
    assert.equal(job.if, "github.event.label.name == 'arise'");
    assert.deepEqual(job.concurrency, { group: "shadowarmy-${{ github.event.issue.number }}", "cancel-in-progress": false });
    assert.match(String(job.uses), /^Vrajesh-works\/shadowarmy\/\.github\/workflows\/order\.yml@/);
    assert.equal(job.secrets, "inherit");
  });

  // Oracle: the scenario list in decision 24; every scenario the gate accepts must run.
  const script = fileURLToPath(new URL("../scripts/fake-agent.sh", import.meta.url));
  const runScenario = (scenario: string) => {
    const work = mkdtempSync(join(tmpdir(), "shadowarmy-fake-"));
    execFileSync("git", ["init", "--quiet"], { cwd: work });
    const out = mkdtempSync(join(tmpdir(), "shadowarmy-fake-out-"));
    const ran = spawnSync("bash", [script, scenario], { cwd: work, env: { ...process.env, SHADOWARMY_OUT: out }, encoding: "utf8" });
    const resultPath = join(out, "result.json");
    return { ran, result: existsSync(resultPath) ? readFileSync(resultPath, "utf8") : null };
  };

  for (const scenario of FAKE_AGENT_SCENARIOS) {
    it(`runs the fake agent scenario ${scenario} and writes a ${scenario === "invalid-result" ? "rejected" : "valid"} result`, () => {
      const { ran, result } = runScenario(scenario);
      assert.equal(ran.status, 0, ran.stderr);
      assert.equal(checkSoldierResult(result).ok, scenario !== "invalid-result");
    });
  }

  it("rejects an unknown fake agent scenario", () => {
    const { ran, result } = runScenario("rm -rf");
    assert.equal(ran.status, 2);
    assert.equal(result, null);
  });
});
