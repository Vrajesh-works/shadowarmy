// Fetching and packing the target repository. Only jobs without an agent use
// these (they hold SHADOWARMY_GH_TOKEN); the agent jobs receive the packed
// checkout as an artifact.

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { git, GitError } from "./git.ts";
import { isSafeBranchName } from "./names.ts";

/** The packed target checkout in an agent's inputs; the agent job extracts it and deletes it. */
export const TARGET_ARCHIVE = "target.tar.gz";

export type Checkout = { ok: true; ref: string; sha: string } | { ok: false; reason: string };

/**
 * Fetch the head of `branch` (the default branch when null) into `dir`, on a
 * local branch of the same name. Depth 1: agents get the tree, not the history.
 */
export async function checkOutTarget(dir: string, target: string, branch: string | null, token: string, serverUrl: string): Promise<Checkout> {
  const run = (args: string[], auth = false) => git(args, { cwd: dir, serverUrl, ...(auth ? { token } : {}) });
  try {
    await run(["init", "--quiet"]);
    await run(["remote", "add", "origin", `${serverUrl}/${target}.git`]);
    let ref = branch;
    if (ref === null) {
      const head = await run(["ls-remote", "--symref", "origin", "HEAD"], true);
      ref = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head)?.[1] ?? "";
      if (!isSafeBranchName(ref)) return { ok: false, reason: `${target} has no default branch that can be checked out.` };
    }
    await run(["fetch", "--quiet", "--depth=1", "origin", `refs/heads/${ref}`], true);
    await run(["checkout", "--quiet", "-b", ref, "FETCH_HEAD"]);
    return { ok: true, ref, sha: (await run(["rev-parse", "HEAD"])).trim() };
  } catch (error) {
    if (error instanceof GitError) return { ok: false, reason: error.message };
    throw error;
  }
}

/** Pack `dir` (including .git) with tar, which keeps file modes. Paths stay relative, so no path reaches tar's arguments. */
export function packDirectory(dir: string, file: string): Promise<void> {
  const fd = openSync(file, "w");
  return new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-czf", "-", "."], { cwd: dir, stdio: ["ignore", fd, "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed (exit ${String(code)}): ${stderr.trim().slice(0, 1000)}`));
    });
  }).finally(() => {
    closeSync(fd);
  });
}
