import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { DEFAULTS, parseConfig } from "../src/config.ts";
import { ORDER_FORM } from "../src/issueForm.ts";
import { FAKE_AGENT_SCENARIOS } from "../src/order/gate.ts";

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

  it("has a caller workflow that only filters arise, serializes per issue and grants minimal permissions", () => {
    const workflow = parse(read("template/.github/workflows/order.yml")) as Record<string, unknown>;
    assert.deepEqual(workflow.on, { issues: { types: ["labeled"] } });
    assert.deepEqual(workflow.permissions, { contents: "read", issues: "write", actions: "read" });
    assert.deepEqual(workflow.concurrency, { group: "shadowarmy-${{ github.event.issue.number }}", "cancel-in-progress": false });
    const job = (workflow.jobs as Record<string, Record<string, unknown> | undefined>).order;
    assert.ok(job);
    assert.equal(job.if, "github.event.label.name == 'arise'");
    assert.match(String(job.uses), /^Vrajesh-works\/shadowarmy\/\.github\/workflows\/order\.yml@/);
    assert.equal(job.secrets, "inherit");
  });

  it("knows exactly the fake agent scenarios the script implements", () => {
    const script = read("scripts/fake-agent.sh");
    const cases = [...script.matchAll(/^ {2}([a-z-]+)\)$/gm)].map((match) => match[1]);
    assert.deepEqual(cases, [...FAKE_AGENT_SCENARIOS]);
  });
});
