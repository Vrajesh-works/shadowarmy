// Shared helpers for tests that drive order steps against a fake GitHub and
// real git repositories (a local bare repository stands in for the target).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RealmIssue } from "../../src/realmIssue.ts";
import { parseStatusComment, type StateBlock } from "../../src/statusComment.ts";
import { FakeGitHub } from "./fakeGitHub.ts";

export const ENGINE = fileURLToPath(new URL("../..", import.meta.url));
export const REALM = "the-monarch/realm";
export const TARGET = "the-monarch/site";
export const run = { runId: 99, runUrl: "https://github.com/the-monarch/realm/actions/runs/99", serverUrl: "https://github.com" };

export const ORDER_BODY = "### Target repository\n\nthe-monarch/site\n\n### Task\n\nAdd a greeting to README.md.\n\n### Base branch\n\n_No response_";

export function tmp(): string {
  return mkdtempSync(join(tmpdir(), "shadowarmy-test-"));
}

export function realmDir(config = "version: 1\nmonarch: the-monarch\ntargets: [the-monarch/*]\n"): string {
  const dir = tmp();
  writeFileSync(join(dir, "shadowarmy.yml"), config);
  mkdirSync(join(dir, "rules"));
  writeFileSync(join(dir, "rules", "company.md"), "Be careful.\n");
  return dir;
}

export function status(gh: FakeGitHub): { body: string; state: StateBlock | null } {
  const comment = gh.issue(REALM, 42).comments[0];
  if (comment === undefined) return { body: "", state: null };
  const parsed = parseStatusComment(comment.body);
  return { body: comment.body, state: parsed.ok ? parsed.state : null };
}

/** Seed the status comment an earlier run left on the issue. */
export async function seedStatus(gh: FakeGitHub, state: Partial<StateBlock>): Promise<void> {
  const block: StateBlock = {
    version: 1, kind: "order", target: TARGET, base: null, baseSha: null, branch: "shadowarmy/42-add-an-rss-feed", pr: null,
    round: 0, runs: [], ciWaitStartedAt: null, lastError: null, parent: null, dependsOn: [], ...state,
  };
  await new RealmIssue(gh, REALM, 42).writeStatus({ state: "in-progress", summary: "Working." }, block);
}

export function freshIssue(labels = ["order", "arise"]): FakeGitHub {
  const gh = new FakeGitHub();
  gh.issue(REALM, 42).labels = labels;
  return gh;
}

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

export interface TargetRepo {
  remoteRoot: string;
  bare: string;
  baseSha: string;
  work: string;
}

/** A bare target repository under `file://<remoteRoot>/the-monarch/site.git` with one commit on its default branch, and a working copy. */
export function targetRepo(files: Record<string, string> = { "README.md": "# Site\n" }, defaultBranch = "main"): TargetRepo {
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

