// JSON Schema for the state block (version 1) at the end of every status
// comment. The contract is docs/behavior-contract.md section 5 and the data
// model in functional-diagrams/architecture.md.

import type { SchemaObject } from "ajv";

export const RUN_ROLES = ["marshal", "soldier", "knight", "scout"] as const;
export type RunRole = (typeof RUN_ROLES)[number];

/** GitHub's workflow run conclusions; null while the run has not finished. */
export const RUN_CONCLUSIONS = [
  "success",
  "failure",
  "cancelled",
  "timed_out",
  "skipped",
  "neutral",
  "action_required",
  "stale",
] as const;
export type RunConclusion = (typeof RUN_CONCLUSIONS)[number];

export interface RunRecord {
  role: RunRole;
  runId: number;
  conclusion: RunConclusion | null;
}

export interface StateBlock {
  version: 1;
  kind: "order" | "task" | "new-project";
  /** `owner/repo`; null for a New project order before its repository exists. */
  target: string | null;
  /** Base branch; null means the target's default branch. */
  base: string | null;
  /** The commit the first Soldier round started from; the Knight reviews the diff from here. Null until the target is fetched. */
  baseSha: string | null;
  branch: string | null;
  pr: number | null;
  /** Fix rounds used. */
  round: number;
  runs: RunRecord[];
  ciWaitStartedAt: string | null;
  lastError: string | null;
  /** The order issue a task belongs to. */
  parent: number | null;
  /** Task issue numbers this task waits for. */
  dependsOn: number[];
}

export const MAX_RUNS = 200;
export const MAX_ERROR_LENGTH = 4000;

const issueNumber = { type: "integer", minimum: 1 } as const;

/**
 * Ajv's JSONSchemaType cannot express a required key whose value may be null,
 * which most keys here are, so this schema is a plain schema object. Tests in
 * tests/statusComment.test.ts keep it and StateBlock in step.
 */
export const stateSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "kind",
    "target",
    "base",
    "baseSha",
    "branch",
    "pr",
    "round",
    "runs",
    "ciWaitStartedAt",
    "lastError",
    "parent",
    "dependsOn",
  ],
  properties: {
    version: { type: "integer", const: 1 },
    kind: { type: "string", enum: ["order", "task", "new-project"] },
    target: { type: "string", format: "repo-full-name", description: "\"owner/name\"", nullable: true },
    base: { type: "string", format: "branch-name", description: "a valid branch name", nullable: true },
    baseSha: { type: "string", pattern: "^[0-9a-f]{40}$", description: "a full commit SHA", nullable: true },
    branch: {
      type: "string",
      format: "task-branch",
      description: "a task branch \"shadowarmy/<issue>-<slug>\"",
      nullable: true,
    },
    pr: { ...issueNumber, nullable: true },
    round: { type: "integer", minimum: 0, maximum: 100 },
    runs: {
      type: "array",
      maxItems: MAX_RUNS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "runId", "conclusion"],
        properties: {
          role: { type: "string", enum: RUN_ROLES },
          runId: { type: "integer", minimum: 1 },
          conclusion: { type: "string", enum: [...RUN_CONCLUSIONS, null], nullable: true },
        },
      },
    },
    ciWaitStartedAt: {
      type: "string",
      format: "utc-date-time",
      description: "an ISO 8601 UTC timestamp such as \"2026-11-08T12:00:00Z\"",
      nullable: true,
    },
    lastError: { type: "string", maxLength: MAX_ERROR_LENGTH, nullable: true },
    parent: { ...issueNumber, nullable: true },
    dependsOn: { type: "array", maxItems: 100, uniqueItems: true, items: issueNumber },
  },
};
