// The diff guard (behavior contract section 7). It runs on the staged change
// in a fresh checkout before every push and decides, deterministically,
// whether the change may leave the runner. Agents never decide this.

export interface ChangedFile {
  /** git status letter: A added, M modified, D deleted, R renamed, C copied, T type changed. */
  status: "A" | "M" | "D" | "R" | "C" | "T";
  path: string;
  /** For renames and copies: the path before. */
  oldPath?: string;
  /** git mode of the new file, for example 100644; 160000 is a submodule. */
  mode?: string;
  /** Object id of the new content (from `--raw --no-abbrev`); all zeros for deletions. */
  blob?: string;
  /** Size in bytes of the new content; absent for deletions. */
  size?: number;
  /** True when the new content contains a shadowarmy marker (`<!-- shadowarmy:`). */
  hasMarker?: boolean;
}

export interface GuardInput {
  files: readonly ChangedFile[];
  /** The order's task text; naming a protected path here is the explicit request that allows it. */
  orderText: string;
  maxFileSizeMb: number;
}

export interface GuardViolation {
  path: string;
  reason: string;
}

export interface GuardResult {
  ok: boolean;
  violations: GuardViolation[];
  /** Protected paths allowed because the order names them; recorded in the status comment. */
  exceptions: string[];
}

export const MARKER = "<!-- shadowarmy:";

/** Why a path is protected, or null when it is not. */
export function protectedReason(path: string): string | null {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  if (parts[0] === ".shadowarmy") return "shadowarmy state directory";
  if (parts.includes(".claude")) return "agent configuration directory .claude/";
  if (name === "CLAUDE.md" || name === "CLAUDE.local.md") return "agent instructions file";
  if (name === "AGENTS.md") return "agent instructions file";
  if (path.startsWith(".github/workflows/")) return "workflow file (runs with the repository's secrets)";
  return null;
}

/** The order explicitly asks for this protected path when its text names the path or its folder. */
function explicitlyRequested(path: string, orderText: string): boolean {
  if (namesPath(orderText, path)) return true;
  return path.startsWith(".github/workflows/") && namesPath(orderText, ".github/workflows");
}

/** `text` names `path` as a whole path: not as the tail of a longer one (`docs/CLAUDE.md` does not name `CLAUDE.md`). */
function namesPath(text: string, path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\w./-])${escaped}(?![\\w-]|[./]\\w)`).test(text);
}

export function checkDiff(input: GuardInput): GuardResult {
  const violations: GuardViolation[] = [];
  const exceptions = new Set<string>();
  const maxBytes = input.maxFileSizeMb * 1024 * 1024;

  for (const file of input.files) {
    const paths = [file.path, ...(file.oldPath === undefined ? [] : [file.oldPath])];
    for (const path of paths) {
      const reason = protectedReason(path);
      if (reason === null) continue;
      if (explicitlyRequested(path, input.orderText)) exceptions.add(path);
      else violations.push({ path, reason: `${reason}; the order does not ask for it` });
    }
    if (file.status === "D") continue;
    if (file.mode === "160000") violations.push({ path: file.path, reason: "submodule changes are not allowed" });
    if (file.hasMarker === true) {
      violations.push({ path: file.path, reason: "contains a shadowarmy status or state marker" });
    }
    if (file.size !== undefined && file.size > maxBytes) {
      violations.push({
        path: file.path,
        reason: `is ${(file.size / 1024 / 1024).toFixed(1)} MB, over the ${String(input.maxFileSizeMb)} MB limit`,
      });
    }
  }
  return { ok: violations.length === 0, violations, exceptions: [...exceptions] };
}

/**
 * Parse `git diff --cached --raw -z -M --no-abbrev` output into changes.
 * Records: `:oldmode newmode oldsha newsha status\0path\0[newpath\0]`.
 */
export function parseRawDiff(raw: string): ChangedFile[] {
  const fields = raw.split("\0");
  const files: ChangedFile[] = [];
  let index = 0;
  while (index < fields.length) {
    const header = fields[index++] ?? "";
    if (header === "") continue;
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ ([0-9a-f]+) ([AMDRCTUX])\d*$/.exec(header);
    if (match === null) throw new Error(`unexpected git diff --raw record: ${JSON.stringify(header.slice(0, 100))}`);
    const [, , newMode = "", blob = "", letter = ""] = match;
    if (letter === "U" || letter === "X") throw new Error(`unexpected git diff status ${letter}`);
    const status = letter as ChangedFile["status"];
    const first = fields[index++] ?? "";
    if (status === "R" || status === "C") {
      const second = fields[index++] ?? "";
      files.push({ status, oldPath: first, path: second, mode: newMode, blob });
    } else {
      files.push({ status, path: first, mode: newMode, blob });
    }
  }
  return files;
}
