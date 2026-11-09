// Validates the Knight's review.json and turns it into a pull request review.
// The posted review ends with a machine block, so a later run (a fix round)
// can read the findings back from GitHub instead of from runner storage:
//
//   <!-- shadowarmy:review {"round":1,"review":{...}} -->
//
// Agent output is untrusted: anything that does not match the schema, or whose
// verdict contradicts its findings, is a failure.

import { compileUncheckedValidator, formatIssues } from "./schema.ts";
import { reviewSchema, type Finding, type KnightReview } from "./schemas/review.ts";
import { escapeText } from "./statusComment.ts";

export type { Finding, KnightReview, Severity } from "./schemas/review.ts";

export const MAX_REVIEW_BYTES = 256 * 1024;
const BLOCK_PREFIX = "<!-- shadowarmy:review ";
const BLOCK_SUFFIX = " -->";
/** GitHub rejects a review body longer than 65536 characters. */
export const MAX_REVIEW_BODY_CHARS = 65_000;
/** Room kept for the line that counts the findings left out of the readable list. */
const MORE_LINE_RESERVE = 100;

const validate = compileUncheckedValidator<KnightReview>(reviewSchema);

export type ReviewCheck = { ok: true; review: KnightReview } | { ok: false; reason: string };

/** Findings that require a fix round. */
export function blocking(review: KnightReview): Finding[] {
  return review.findings.filter((finding) => finding.severity !== "minor");
}

export function minor(review: KnightReview): Finding[] {
  return review.findings.filter((finding) => finding.severity === "minor");
}

function validateData(data: unknown): ReviewCheck {
  const checked = validate(data);
  if (!checked.ok) {
    return { ok: false, reason: `review.json does not match the schema: ${formatIssues(checked.issues).replaceAll("\n", "; ")}` };
  }
  const review = checked.value;
  const required = blocking(review).length;
  if (review.verdict === "approve" && required > 0) {
    return { ok: false, reason: `review.json approves but lists ${String(required)} blocker or major finding(s)` };
  }
  if (review.verdict === "changes" && required === 0) {
    return { ok: false, reason: "review.json requests changes but lists no blocker or major finding" };
  }
  return { ok: true, review };
}

export function checkKnightReview(text: string | null): ReviewCheck {
  if (text === null) return { ok: false, reason: "the Knight did not write review.json" };
  if (Buffer.byteLength(text, "utf8") > MAX_REVIEW_BYTES) {
    return { ok: false, reason: `review.json is larger than ${String(MAX_REVIEW_BYTES / 1024)} KB` };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `review.json is not valid JSON: ${(error as Error).message.replace(/\s+/g, " ").trim()}` };
  }
  return validateData(data);
}

export function reviewSchemaText(): string {
  return JSON.stringify(reviewSchema, null, 2);
}

function location(finding: Finding): string {
  return finding.line === null ? finding.file : `${finding.file}:${String(finding.line)}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** One markdown bullet per finding, escaped. */
export function renderFindings(findings: readonly Finding[]): string {
  return findings
    .map((finding) => {
      const fix = finding.suggestedFix.trim() === "" ? "" : ` Suggested fix: ${escapeText(oneLine(finding.suggestedFix))}`;
      return `- **${finding.severity}** <code>${escapeText(location(finding))}</code>: ${escapeText(oneLine(finding.problem))}${fix}`;
    })
    .join("\n");
}

function machineBlock(round: number, review: KnightReview): string {
  const json = JSON.stringify({ round, review }).replace(/[<>&]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `${BLOCK_PREFIX}${json}${BLOCK_SUFFIX}`;
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}...`;
}

function shortened(review: KnightReview, max: number): KnightReview {
  return {
    ...review,
    findings: review.findings.map((finding) => ({ ...finding, problem: clip(finding.problem, max), suggestedFix: clip(finding.suggestedFix, max) })),
  };
}

/**
 * The pull request review body: readable part, then the machine block, within
 * GitHub's size limit. Findings that do not fit are left out of the readable
 * list; if the machine block alone is too long, its problem and suggestedFix
 * texts are shortened.
 */
export function renderReviewBody(review: KnightReview, round: number): string {
  const verdict = review.verdict === "approve" ? "approved" : "changes requested";
  const head = [`**shadowarmy Knight review, round ${String(round)}: ${verdict}.** ${escapeText(oneLine(review.summary))}`];
  if (review.scope.trim().toLowerCase() !== "ok") head.push(`Scope: ${escapeText(oneLine(review.scope))}`);
  const size = (block: string) => [...head, block].join("\n\n").length + 1;
  const budget = MAX_REVIEW_BODY_CHARS - MORE_LINE_RESERVE;

  let block = machineBlock(round, review);
  for (let max = 1000; size(block) > budget && max >= 1; max = Math.floor(max / 2)) block = machineBlock(round, shortened(review, max));

  let room = budget - size(block);
  const shown: string[] = [];
  for (const finding of review.findings) {
    const line = renderFindings([finding]);
    if (line.length + 2 > room) break;
    shown.push(line);
    room -= line.length + 2;
  }
  const hidden = review.findings.length - shown.length;
  if (hidden > 0) shown.push(`... ${String(hidden)} more finding(s) in the review block.`);
  return `${[...head, ...(shown.length > 0 ? [shown.join("\n")] : []), block].join("\n\n")}\n`;
}

/** Read a review back from a posted review body; null when the body carries no valid block. */
export function parseReviewBody(body: string): { round: number; review: KnightReview } | null {
  const line = body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((text) => text.trim())
    .findLast((text) => text.startsWith(BLOCK_PREFIX) && text.endsWith(BLOCK_SUFFIX));
  if (line === undefined) return null;
  let data: unknown;
  try {
    data = JSON.parse(line.slice(BLOCK_PREFIX.length, -BLOCK_SUFFIX.length));
  } catch {
    return null;
  }
  const { round, review } = (data ?? {}) as { round?: unknown; review?: unknown };
  if (typeof round !== "number" || !Number.isInteger(round) || round < 0) return null;
  const checked = validateData(review);
  return checked.ok ? { round, review: checked.review } : null;
}
