import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isLogin,
  isRepoFullName,
  isRepoName,
  isSafeBranchName,
  isTargetPattern,
  isTaskBranch,
  isTimeZone,
  isUtcDateTime,
} from "../src/names.ts";

function check(fn: (value: string) => boolean, good: string[], bad: string[]): void {
  for (const value of good) assert.ok(fn(value), `should accept ${JSON.stringify(value)}`);
  for (const value of bad) assert.ok(!fn(value), `should reject ${JSON.stringify(value)}`);
}

describe("names", () => {
  it("isLogin", () => {
    check(isLogin, ["a", "octo-cat", "A1", "x".repeat(39)], ["", "-a", "a-", "a--b", "a_b", "a.b", "x".repeat(40)]);
  });

  it("isRepoName", () => {
    check(isRepoName, ["repo", "my.repo", "my_repo-2", ".github"], ["", ".", "..", "a/b", "a b", "x.git", "x".repeat(101)]);
  });

  it("isRepoFullName", () => {
    check(isRepoFullName, ["owner/repo", "Owner/My.Repo"], ["owner", "owner/", "/repo", "a/b/c", "owner/*", "-o/r"]);
  });

  it("isTargetPattern", () => {
    check(
      isTargetPattern,
      ["owner/repo", "Owner/My.Repo", "owner/*"],
      ["owner", "owner/", "/repo", "/*", "a/b/c", "owner/*/x", "-o/r", "owner/re*", "owner/..", "owner/x.git"],
    );
  });

  it("isSafeBranchName", () => {
    check(
      isSafeBranchName,
      ["main", "release/2.x", "feature/a+b", "v1.0.0", "a_b-c"],
      ["", "-main", "/main", "main/", "a//b", "a..b", ".hidden", "a/.b", "x.lock", "a/x.lock/b", "main.", "a b",
        "a;b", "$(id)", "a`b`", "a~1", "a^", "a:b", "a?", "a*", "a[b", "a\\b", "@", "a@{1}", "é", "x".repeat(256)],
    );
  });

  it("isTaskBranch", () => {
    check(isTaskBranch, ["shadowarmy/42-rss-feed", "shadowarmy/1-x"], ["shadowarmy/42", "shadowarmy/0-x", "shadowarmy/42-RSS", "main", "shadowarmy/42-a--b", "shadowarmy/42-a-"]);
  });

  it("isUtcDateTime", () => {
    check(
      isUtcDateTime,
      ["2026-11-08T12:00:00Z", "2026-11-08T12:00:00.123Z", "2024-02-29T00:00:00Z"],
      ["2026-11-08", "2026-11-08T12:00:00", "2026-11-08T12:00:00+00:00", "2026-13-01T00:00:00Z", "2025-02-29T00:00:00Z", "2026-11-08T24:00:00Z"],
    );
  });

  it("isTimeZone", () => {
    check(isTimeZone, ["UTC", "Europe/Berlin", "America/New_York"], ["", "Mars/Olympus", "UTC+25"]);
  });
});
