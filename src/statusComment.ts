// Renders and parses the one engine-authored status comment on each order and
// task (behavior contract section 5). The comment starts with the status
// marker and ends with a single-line state block:
//
//   <!-- shadowarmy:status -->
//   ...human-readable part...
//   <!-- shadowarmy:state {"version":1,...} -->
//
// Text shown to people may come from issues or agents, so it is escaped: it can
// never produce HTML, a marker or a state block, and it cannot @mention anyone.
// The state block is validated on render and on every read; an unreadable
// block is an error, never a guess. Callers must also check that the comment's
// author is the Realm's Actions bot before trusting it (docs/security.md).

import type { StateLabel } from "./labels.ts";
import { compileUncheckedValidator, formatIssues } from "./schema.ts";
import { stateSchema, type StateBlock } from "./schemas/state.ts";

export type { RunConclusion, RunRecord, RunRole, StateBlock } from "./schemas/state.ts";

export const STATUS_MARKER = "<!-- shadowarmy:status -->";
const STATE_PREFIX = "<!-- shadowarmy:state ";
const STATE_SUFFIX = " -->";

/** GitHub rejects comment bodies longer than this. */
export const MAX_COMMENT_LENGTH = 65536;

export const LIMITS = {
  summary: 1000,
  detail: 1000,
  details: 50,
  question: 4000,
  linkLabel: 100,
  links: 10,
  url: 1000,
} as const;

const SEPARATOR = "\n\n";

const STATE_TITLES: Readonly<Record<StateLabel, string>> = {
  queued: "Queued",
  planning: "Planning",
  "in-progress": "In progress",
  "in-review": "In review",
  "waiting-ci": "Waiting for CI",
  "needs-decision": "Needs your decision",
  "ready-to-merge": "Ready to merge",
  done: "Done",
  failed: "Failed",
  dismissed: "Dismissed",
};

export interface StatusLink {
  label: string;
  /** Must be an https URL, for example a pull request or workflow run. */
  url: string;
}

/** The human-readable part of a status comment. */
export interface StatusView {
  state: StateLabel;
  /** One sentence: what is happening now. */
  summary: string;
  /** Short facts, one line each: what the army is doing or waiting for. */
  details?: readonly string[];
  /** For `needs-decision`: the exact question or approval needed and how to answer. */
  question?: string;
  links?: readonly StatusLink[];
}

const validateState = compileUncheckedValidator<StateBlock>(stateSchema);

export class StatusCommentError extends Error {
  override name = "StatusCommentError";
}

/**
 * Render a full status comment. Throws if the state block is invalid; the engine never writes one.
 * The comment never exceeds MAX_COMMENT_LENGTH: the state block, the summary and the links
 * always fit, the question gets the remaining room first and the details get what is left.
 */
export function renderStatusComment(view: StatusView, state: StateBlock): string {
  const checked = validateState(state);
  if (!checked.ok) {
    throw new StatusCommentError(`refusing to write an invalid state block:\n${formatIssues(checked.issues)}`);
  }

  const header = `${STATUS_MARKER}${SEPARATOR}**${STATE_TITLES[view.state]}**: ${inline(view.summary, LIMITS.summary)}`;
  const links = renderLinks(view.links ?? []);
  const tail = [...(links === null ? [] : [links]), renderStateBlock(checked.value)].join(SEPARATOR);

  let room = MAX_COMMENT_LENGTH - (header.length + SEPARATOR.length + tail.length + 1);
  const question = renderQuestion(view.question ?? "", room - SEPARATOR.length);
  if (question !== null) room -= question.length + SEPARATOR.length;
  const details = renderDetails(view.details ?? [], room - SEPARATOR.length);

  const parts = [header, details, question, tail].filter((part): part is string => part !== null);
  return parts.join(SEPARATOR) + "\n";
}

function renderLinks(links: readonly StatusLink[]): string | null {
  const shown = links.slice(0, LIMITS.links);
  if (shown.length === 0) return null;
  return shown
    .map((link) => {
      if (!isSafeUrl(link.url)) throw new StatusCommentError(`refusing to link a non-https URL: ${link.url}`);
      if (link.url.length > LIMITS.url) {
        throw new StatusCommentError(`refusing to link a URL longer than ${String(LIMITS.url)} characters`);
      }
      return `- [${inline(link.label, LIMITS.linkLabel).replace(/[[\]]/g, "\\$&")}](${link.url})`;
    })
    .join("\n");
}

/** The question as a quote, truncated further when it does not fit in `room`; null when there is none or no room. */
function renderQuestion(question: string, room: number): string | null {
  const text = question.trim();
  if (text === "") return null;
  const render = (max: number): string =>
    "**Question for the Monarch:**" +
    SEPARATOR +
    escapeText(truncate(text, max))
      .split(/\r?\n/)
      .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
      .join("\n");

  const length = Math.min(Array.from(text).length, LIMITS.question);
  const full = render(length);
  if (full.length <= room) return full;
  // Every shorter rendering ends with the truncation note, so its length only grows with `max`.
  let low = 0;
  let high = length - 1;
  let best: string | null = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = render(mid);
    if (candidate.length <= room) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/** One line per detail, dropping details from the end (with a count) until they fit in `room`. */
function renderDetails(details: readonly string[], room: number): string | null {
  const lines = details.slice(0, LIMITS.details).map((detail) => `- ${inline(detail, LIMITS.detail)}`);
  for (let count = lines.length; count >= 0; count--) {
    const hidden = details.length - count;
    if (hidden === 0 && count === 0) return null;
    const shown = hidden > 0 ? [...lines.slice(0, count), `- ... ${String(hidden)} more not shown`] : lines;
    const text = shown.join("\n");
    if (text.length <= room) return text;
  }
  return null;
}

/**
 * The state block line. `<`, `>` and `&` are written as JSON unicode escapes so
 * that no string inside the block can close the HTML comment early.
 */
export function renderStateBlock(state: StateBlock): string {
  const json = JSON.stringify(state).replace(/[<>&]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `${STATE_PREFIX}${json}${STATE_SUFFIX}`;
}

export function isStatusComment(body: string): boolean {
  return body.replace(/^\uFEFF/, "").trimStart().startsWith(STATUS_MARKER);
}

export type ParsedStatus = { ok: true; state: StateBlock } | { ok: false; reason: string };

/** Read the state block from a status comment body. Every failure has a reason a person can act on. */
export function parseStatusComment(body: string): ParsedStatus {
  if (!isStatusComment(body)) return { ok: false, reason: "not a status comment: the status marker is missing" };

  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const blockLines = lines.filter((line) => line.includes(STATE_PREFIX.trim()));
  if (blockLines.length === 0) return { ok: false, reason: "state block is missing" };
  if (blockLines.length > 1) return { ok: false, reason: "more than one state block" };

  const lastLine = lines.findLast((line) => line.trim() !== "")?.trim() ?? "";
  if (blockLines[0]?.trim() !== lastLine) return { ok: false, reason: "state block is not the last line" };
  if (!lastLine.startsWith(STATE_PREFIX) || !lastLine.endsWith(STATE_SUFFIX)) {
    return { ok: false, reason: "state block is malformed" };
  }

  let data: unknown;
  try {
    data = JSON.parse(lastLine.slice(STATE_PREFIX.length, -STATE_SUFFIX.length));
  } catch (error) {
    return { ok: false, reason: `state block is not valid JSON: ${(error as Error).message}` };
  }

  if (typeof data === "object" && data !== null && "version" in data && data.version !== 1) {
    return { ok: false, reason: `unsupported state block version: ${JSON.stringify(data.version)}` };
  }
  const checked = validateState(data);
  if (!checked.ok) return { ok: false, reason: `state block is invalid: ${formatIssues(checked.issues).replaceAll("\n", "; ")}` };
  return { ok: true, state: checked.value };
}

/** Escape untrusted text for a GitHub comment: no HTML, no markers, no @mentions. */
export function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@(?=[A-Za-z0-9])/g, "@\u200b");
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}... (truncated)`;
}

/** One escaped, length-limited line. */
function inline(text: string, max: number): string {
  return escapeText(truncate(text.replace(/\s+/g, " ").trim(), max));
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !/[\s()<>]/.test(url);
  } catch {
    return false;
  }
}
