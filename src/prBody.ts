// Renders the pull request body and the commit message from the Soldier's
// validated result (behavior contract section 7). Agent text is untrusted:
// it is escaped so it cannot add HTML or @mention anyone, and the body stays
// under GitHub's size limit.

import { renderFindings, type Finding } from "./knightReview.ts";
import type { SoldierResult } from "./soldierResult.ts";
import { escapeText } from "./statusComment.ts";

export const MAX_PR_BODY = 60000;

export interface PullRequestContext {
  issue: number;
  /** `owner/repo` of the Realm. */
  realm: string;
  /** Link the Realm issue: only for private targets or when `pr.link_realm` is set. */
  linkRealm: boolean;
  serverUrl?: string;
}

/** `minorFindings`: the Knight's minor findings on the approved change, listed for the Monarch. */
export function renderPullRequestBody(result: SoldierResult, context: PullRequestContext, minorFindings: readonly Finding[] = []): string {
  const sections: string[] = ["## Summary", escapeText(result.summary.trim())];

  sections.push("## Verification");
  sections.push(
    result.verification.length === 0
      ? "The Soldier reported no checks."
      : result.verification
          .map((check) => {
            const notes = check.notes.trim() === "" ? "" : ` - ${escapeText(oneLine(check.notes))}`;
            return `- <code>${escapeText(oneLine(check.command))}</code>: ${check.outcome}${notes}`;
          })
          .join("\n"),
  );

  sections.push("## Known limitations");
  sections.push(
    result.limitations.length === 0
      ? "None reported."
      : result.limitations.map((limitation) => `- ${escapeText(oneLine(limitation))}`).join("\n"),
  );

  if (minorFindings.length > 0) {
    sections.push("## Minor review findings");
    sections.push(`The Knight approved this change and noted these minor points:\n\n${renderFindings(minorFindings)}`);
  }

  // `#N` would link to the target repository's own issue N, so the number is in a code span
  // unless the Realm issue is linked.
  const reference = context.linkRealm
    ? `[issue #${String(context.issue)}](${context.serverUrl ?? "https://github.com"}/${context.realm}/issues/${String(context.issue)})`
    : `issue \`#${String(context.issue)}\``;
  const footer = `Ordered from a shadowarmy Realm (${reference}).`;

  let body = sections.join("\n\n");
  const room = MAX_PR_BODY - footer.length - 40;
  if (body.length > room) body = `${body.slice(0, room)}\n\n... (truncated)`;
  return `${body}\n\n${footer}\n`;
}

/** Subject from the title, body from the summary; no tool attribution. */
export function renderCommitMessage(result: SoldierResult): string {
  const clean = (text: string) => text.replace(/[^\P{Cc}\n\t]/gu, "").trim();
  return `${clean(oneLine(result.title))}\n\n${clean(result.summary)}\n`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
