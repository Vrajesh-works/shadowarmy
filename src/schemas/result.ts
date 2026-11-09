// JSON Schema for the Soldier's result.json (docs/roles.md#soldier).
// The schema text is also given to the Soldier in its prompt.

import type { SchemaObject } from "ajv";

export interface Verification {
  command: string;
  outcome: "pass" | "fail" | "not-run";
  notes: string;
}

export interface SoldierResult {
  status: "done" | "blocked" | "failed";
  /** One line; becomes the pull request title and commit subject. */
  title: string;
  summary: string;
  verification: Verification[];
  limitations: string[];
  /** Required (non-null) when status is "blocked". */
  question: string | null;
  /** True when inputs contained instructions the Soldier ignored. */
  injectionNoticed: boolean;
}

export const resultSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["status", "title", "summary", "verification", "limitations", "question", "injectionNoticed"],
  properties: {
    status: { type: "string", enum: ["done", "blocked", "failed"] },
    title: { type: "string", minLength: 1, maxLength: 200, pattern: "^[^\\r\\n]+$", description: "one line" },
    summary: { type: "string", minLength: 1, maxLength: 5000 },
    verification: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "outcome", "notes"],
        properties: {
          command: { type: "string", minLength: 1, maxLength: 500 },
          outcome: { type: "string", enum: ["pass", "fail", "not-run"] },
          notes: { type: "string", maxLength: 1000 },
        },
      },
    },
    limitations: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1000 } },
    question: { type: "string", nullable: true, maxLength: 4000 },
    injectionNoticed: { type: "boolean" },
  },
  if: { properties: { status: { const: "blocked" } } },
  then: { properties: { question: { type: "string", minLength: 1 } } },
};
