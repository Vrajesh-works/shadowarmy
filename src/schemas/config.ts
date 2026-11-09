// JSON Schema for the Realm's shadowarmy.yml (version 1).
// The contract is docs/configuration.md. Defaults live in src/config.ts.

import type { JSONSchemaType } from "ajv";

export type PlanApproval = "always" | "multi-task" | "never";

/** shadowarmy.yml as written by the Monarch: everything except `version` and `targets` is optional. */
export interface RawConfig {
  version: 1;
  monarch?: string;
  targets: string[];
  approval?: { plan?: PlanApproval };
  limits?: {
    max_turns?: number;
    run_timeout_minutes?: number;
    max_fix_rounds?: number;
    max_concurrent_soldiers?: number;
    max_runs_per_day?: number;
    max_file_size_mb?: number;
  };
  ci?: {
    wait_minutes_in_job?: number;
    max_wait_minutes?: number;
    log_excerpt_lines?: number;
  };
  sentinel?: { interval_minutes?: number };
  roles?: {
    marshal?: { model?: string };
    soldier?: { model?: string };
    knight?: { model?: string };
    scout?: { enabled?: boolean; model?: string };
  };
  git?: { author?: string };
  pr?: { draft?: boolean; link_realm?: boolean };
  timezone?: string;
}

function int(minimum: number, maximum: number) {
  return { type: "integer", minimum, maximum } as const;
}

const model = {
  type: "string",
  pattern: "^[A-Za-z0-9._:\\[\\]-]{1,100}$",
  description: "a Claude Code model name such as \"opus\" or \"sonnet\"",
  nullable: true,
} as const;

export const configSchema: JSONSchemaType<RawConfig> = {
  type: "object",
  additionalProperties: false,
  required: ["version", "targets"],
  properties: {
    version: { type: "integer", const: 1 },
    monarch: {
      type: "string",
      format: "login",
      description: "a GitHub login",
      nullable: true,
    },
    targets: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: {
        type: "string",
        format: "target-pattern",
        description: "\"owner/name\" or \"owner/*\"",
      },
    },
    approval: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      properties: {
        plan: { type: "string", enum: ["always", "multi-task", "never"], nullable: true },
      },
    },
    limits: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      properties: {
        max_turns: { ...int(1, 1000), nullable: true },
        // GitHub-hosted jobs cannot run longer than 6 hours.
        run_timeout_minutes: { ...int(1, 360), nullable: true },
        max_fix_rounds: { ...int(0, 20), nullable: true },
        max_concurrent_soldiers: { ...int(1, 20), nullable: true },
        max_runs_per_day: { ...int(1, 1000), nullable: true },
        // GitHub rejects files over 100 MB.
        max_file_size_mb: { ...int(1, 100), nullable: true },
      },
    },
    ci: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      properties: {
        wait_minutes_in_job: { ...int(0, 359), nullable: true },
        max_wait_minutes: { ...int(1, 10080), nullable: true },
        log_excerpt_lines: { ...int(1, 5000), nullable: true },
      },
    },
    sentinel: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      // GitHub does not run schedules more often than every 5 minutes.
      properties: { interval_minutes: { ...int(5, 1440), nullable: true } },
    },
    roles: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      properties: {
        marshal: { type: "object", nullable: true, additionalProperties: false, properties: { model } },
        soldier: { type: "object", nullable: true, additionalProperties: false, properties: { model } },
        knight: { type: "object", nullable: true, additionalProperties: false, properties: { model } },
        scout: {
          type: "object",
          nullable: true,
          additionalProperties: false,
          properties: { enabled: { type: "boolean", nullable: true }, model },
        },
      },
    },
    git: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      properties: {
        author: {
          type: "string",
          pattern: "^[^<>\\n]+ <[^<>\\s@]+@[^<>\\s@]+>$",
          description: "\"Name <email>\"",
          nullable: true,
        },
      },
    },
    pr: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      properties: {
        draft: { type: "boolean", nullable: true },
        link_realm: { type: "boolean", nullable: true },
      },
    },
    timezone: { type: "string", minLength: 1, nullable: true },
  },
};
