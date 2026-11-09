// Validators for GitHub and git names. Every value that later reaches git, the
// GitHub API or a branch name passes through one of these first.

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** A GitHub user or organization login. */
export function isLogin(value: string): boolean {
  return LOGIN.test(value);
}

/** A GitHub repository name (the part after the slash). */
export function isRepoName(value: string): boolean {
  return REPO_NAME.test(value) && value !== "." && value !== ".." && !value.endsWith(".git");
}

/** `owner/name` with a valid login and repository name. */
export function isRepoFullName(value: string): boolean {
  const parts = value.split("/");
  return parts.length === 2 && isLogin(parts[0] ?? "") && isRepoName(parts[1] ?? "");
}

/**
 * A branch name that git accepts (the rules of `git check-ref-format --branch`)
 * and that is also safe anywhere it ends up: at most 255 characters of letters,
 * digits, `.`, `_`, `/`, `+` and `-`. Git allows more (`;`, `$`, quotes); the
 * engine deliberately does not.
 */
export function isSafeBranchName(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false;
  if (!/^[A-Za-z0-9._/+-]+$/.test(value)) return false;
  if (value.includes("..")) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) return false;
  if (value.endsWith(".") || value.includes("//")) return false;
  return value
    .split("/")
    .every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

/** A task branch in a target repository: `shadowarmy/<issue>-<slug>`. */
export function isTaskBranch(value: string): boolean {
  return /^shadowarmy\/[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 100;
}

/** An ISO 8601 timestamp in UTC with a `Z` suffix that names a real instant. */
export function isUtcDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

/** An IANA time zone name the runtime knows, such as `UTC` or `Europe/Berlin`. */
export function isTimeZone(value: string): boolean {
  if (value.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
