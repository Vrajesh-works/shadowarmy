// Builds feedback.md for a fix round from what GitHub records, so a fix round
// needs nothing from the run that requested it (all state lives in GitHub):
//
// - the Knight's latest review of the pull request's head commit, posted by
//   the engine (the account behind SHADOWARMY_GH_TOKEN) with a review block;
// - the failed checks of that commit, with log excerpts.
//
// Review text, check output and logs are untrusted data for the Soldier.

import { failureExcerpt, readChecks, type CheckResult } from "./ci.ts";
import { repoPath, type GitHubClient } from "./github.ts";
import { blocking, parseReviewBody, renderFindings, type KnightReview } from "./knightReview.ts";

interface ReviewJson {
  user?: { login?: string } | null;
  body?: string | null;
  commit_id?: string | null;
}

/** The latest Knight review the engine posted on `sha`, or null. */
export async function latestKnightReview(
  client: GitHubClient,
  target: string,
  pr: number,
  sha: string,
  engineLogin: string,
): Promise<{ round: number; review: KnightReview } | null> {
  const reviews = await client.paginate<ReviewJson>(`/repos/${repoPath(target)}/pulls/${String(pr)}/reviews`, 10);
  for (const review of [...reviews].reverse()) {
    if (review.commit_id !== sha) continue;
    if ((review.user?.login ?? "").toLowerCase() !== engineLogin.toLowerCase()) continue;
    const parsed = parseReviewBody(review.body ?? "");
    if (parsed !== null) return parsed;
  }
  return null;
}

export interface Feedback {
  text: string;
  /** Short descriptions of what the feedback contains, for the status comment. */
  sources: string[];
}

const MAX_FAILED_CHECKS = 5;

export async function gatherFeedback(options: {
  client: GitHubClient;
  target: string;
  pr: number;
  headSha: string;
  engineLogin: string;
  logLines: number;
}): Promise<Feedback | null> {
  const { client, target, pr, headSha } = options;
  const sections: string[] = [];
  const sources: string[] = [];

  const knight = await latestKnightReview(client, target, pr, headSha, options.engineLogin);
  if (knight !== null && knight.review.verdict === "changes") {
    const findings = blocking(knight.review);
    sources.push(`${String(findings.length)} Knight finding(s)`);
    sections.push(
      [
        "## Knight review",
        "",
        `The Knight requested changes in round ${String(knight.round)}: ${knight.review.summary}`,
        "",
        "Fix every finding below.",
        "",
        renderFindings(findings),
      ].join("\n"),
    );
  }

  const failed: CheckResult[] = (await readChecks(client, target, headSha)).filter((check) => check.state === "failed");
  if (failed.length > 0) {
    sources.push(`${String(failed.length)} failing check(s): ${failed.map((check) => check.name).join(", ")}`);
    const parts = ["## Failing checks", "", "The target repository's CI fails on this branch. Make it pass."];
    for (const check of failed.slice(0, MAX_FAILED_CHECKS)) {
      const excerpt = await failureExcerpt(client, target, check, options.logLines);
      parts.push(
        "",
        `### ${check.name} (${check.conclusion})`,
        ...(check.url === null ? [] : [`Details: ${check.url}`]),
        "",
        "```text",
        excerpt.replaceAll("```", "'''") || "(no log output available)",
        "```",
      );
    }
    if (failed.length > MAX_FAILED_CHECKS) parts.push("", `... and ${String(failed.length - MAX_FAILED_CHECKS)} more failing checks.`);
    sections.push(parts.join("\n"));
  }

  if (sections.length === 0) return null;
  return { text: `# Feedback for this fix round\n\n${sections.join("\n\n")}\n`, sources };
}
