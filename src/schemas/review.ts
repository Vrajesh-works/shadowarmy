// JSON Schema for the Knight's review.json (docs/roles.md#knight).
// The schema text is also given to the Knight in its prompt.

import type { SchemaObject } from "ajv";

export type Severity = "blocker" | "major" | "minor";

export interface Finding {
  severity: Severity;
  /** Repository-relative path the finding points to. */
  file: string;
  /** 1-based line in the new version of the file, or null for a whole-file finding. */
  line: number | null;
  problem: string;
  suggestedFix: string;
}

export interface KnightReview {
  verdict: "approve" | "changes";
  /** "ok", or a note when the diff does more or less than the task asks. */
  scope: string;
  findings: Finding[];
  summary: string;
  /** True when inputs contained instructions the Knight ignored. */
  injectionNoticed: boolean;
}

export const MAX_FINDINGS = 50;

export const reviewSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "scope", "findings", "summary", "injectionNoticed"],
  properties: {
    verdict: { type: "string", enum: ["approve", "changes"] },
    scope: { type: "string", minLength: 1, maxLength: 1000 },
    findings: {
      type: "array",
      maxItems: MAX_FINDINGS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "line", "problem", "suggestedFix"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          file: { type: "string", minLength: 1, maxLength: 500, pattern: "^[^\\r\\n]+$", description: "one repository-relative path" },
          line: { type: "integer", minimum: 1, nullable: true },
          problem: { type: "string", minLength: 1, maxLength: 2000 },
          suggestedFix: { type: "string", maxLength: 2000 },
        },
      },
    },
    summary: { type: "string", minLength: 1, maxLength: 2000 },
    injectionNoticed: { type: "boolean" },
  },
};
