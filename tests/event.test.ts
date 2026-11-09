import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadDispatchedIssue, parseDispatchEvent, parseIssueLabeledEvent } from "../src/event.ts";
import { FakeGitHub } from "./helpers/fakeGitHub.ts";
import { taskBranchName, isTaskBranch } from "../src/names.ts";
import { labeledEvent } from "./helpers/fixtures.ts";

describe("parseIssueLabeledEvent", () => {
  it("reads the fields the engine needs", () => {
    assert.deepEqual(parseIssueLabeledEvent(labeledEvent({ body: "b" })), {
      trigger: "label",
      label: "arise",
      sender: "the-monarch",
      issue: { number: 42, title: "Add an RSS feed", body: "b", labels: ["order", "arise"] },
      repository: { fullName: "the-monarch/realm", owner: "the-monarch", private: true },
    });
  });

  it("treats a null body as empty and rejects other payloads", () => {
    const event = labeledEvent();
    assert.equal(parseIssueLabeledEvent({ ...event, issue: { ...event.issue, body: null } }).issue.body, "");
    assert.throws(() => parseIssueLabeledEvent({ action: "opened" }), /not an issues.labeled event/);
    assert.throws(() => parseIssueLabeledEvent({ ...event, sender: {} }), /sender.login is missing/);
    assert.throws(() => parseIssueLabeledEvent({ ...event, repository: { ...event.repository, private: undefined } }), /repository.private is missing/);
    assert.throws(() => parseIssueLabeledEvent({ ...event, issue: { ...event.issue, pull_request: {} } }), /pull request/);
  });
});

describe("taskBranchName", () => {
  it("slugs the title", () => {
    assert.equal(taskBranchName(42, "Add an RSS feed!"), "shadowarmy/42-add-an-rss-feed");
    assert.equal(taskBranchName(7, "Café: résumé / naïve"), "shadowarmy/7-cafe-resume-naive");
    assert.equal(taskBranchName(1, "!!! ???"), "shadowarmy/1-task");
    assert.equal(taskBranchName(1, "$(rm -rf /) `id`"), "shadowarmy/1-rm-rf-id");
  });

  it("stays within 40 characters of slug at a word boundary", () => {
    const name = taskBranchName(3, "one two three four five six seven eight nine ten eleven");
    assert.equal(name, "shadowarmy/3-one-two-three-four-five-six-seven-eight");
    assert.equal(taskBranchName(3, "x".repeat(80)), `shadowarmy/3-${"x".repeat(40)}`);
  });

  it("always produces a valid task branch", () => {
    for (const title of ["", "a", "Ünïcödé only", "--", "Release v2.0 (final)", "日本語のタイトル"]) {
      assert.ok(isTaskBranch(taskBranchName(12, title)), title);
    }
  });
});

describe("dispatch events", () => {
  const payload = {
    inputs: { issue: "42" },
    sender: { login: "github-actions[bot]" },
    repository: { full_name: "the-monarch/realm", owner: { login: "the-monarch" }, private: true },
  };

  it("reads the issue number and sender, then loads the issue from the API", async () => {
    const dispatch = parseDispatchEvent(payload);
    assert.deepEqual(dispatch, {
      sender: "github-actions[bot]",
      issueNumber: 42,
      repository: { fullName: "the-monarch/realm", owner: "the-monarch", private: true },
    });
    const gh = new FakeGitHub();
    Object.assign(gh.issue("the-monarch/realm", 42), { title: "Add an RSS feed", body: "b", labels: ["order", "in-progress"] });
    assert.deepEqual((await loadDispatchedIssue(gh, dispatch)).issue, { number: 42, title: "Add an RSS feed", body: "b", labels: ["order", "in-progress"] });
  });

  it("rejects malformed issue inputs", () => {
    for (const issue of ["0", "-1", "4.2", "42; rm -rf /", "", "12345678901"]) {
      assert.throws(() => parseDispatchEvent({ ...payload, inputs: { issue } }), /inputs.issue is missing/, issue);
    }
    assert.throws(() => parseDispatchEvent({ sender: payload.sender, repository: payload.repository }), /not a workflow_dispatch event/);
  });
});
