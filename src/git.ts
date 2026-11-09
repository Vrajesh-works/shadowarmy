// Runs git without a shell. Authentication goes through GIT_CONFIG_* environment
// variables, so the token never appears in a command line or in .git/config.

import { execFile } from "node:child_process";

export interface GitOptions {
  cwd: string;
  /** A token for https://github.com; sent as an HTTP header for this command only. */
  token?: string;
  env?: Record<string, string>;
  /** Text written to git's standard input. */
  input?: string;
  serverUrl?: string;
}

export class GitError extends Error {
  override name = "GitError";
  readonly stderr: string;
  readonly code: number | string | null;
  constructor(args: readonly string[], stderr: string, code: number | string | null) {
    super(`git ${args[0] ?? ""} failed (exit ${String(code)}): ${stderr.trim().slice(0, 1000)}`);
    this.stderr = stderr;
    this.code = code;
  }
}

export function authEnv(token: string, serverUrl = "https://github.com"): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${serverUrl}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

export function git(args: readonly string[], options: GitOptions): Promise<string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...(options.token === undefined ? {} : authEnv(options.token, options.serverUrl)),
    ...options.env,
  };
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...args],
      { cwd: options.cwd, env, maxBuffer: 256 * 1024 * 1024, encoding: "utf8", timeout: 10 * 60 * 1000 },
      (error, stdout, stderr) => {
        if (error) reject(new GitError(args, stderr, error.code ?? null));
        else resolve(stdout);
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}
