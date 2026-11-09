// Loads and validates the Realm's shadowarmy.yml. The contract is
// docs/configuration.md; an invalid file fails the run with every problem
// listed by key, and nothing else happens.

import { parseDocument } from "yaml";
import { isRepoFullName, isTimeZone } from "./names.ts";
import { compileValidator, type ValidationIssue } from "./schema.ts";
import { configSchema, type PlanApproval, type RawConfig } from "./schemas/config.ts";

export type { PlanApproval } from "./schemas/config.ts";

export interface Config {
  version: 1;
  monarch: string;
  targets: string[];
  approval: { plan: PlanApproval };
  limits: {
    max_turns: number;
    run_timeout_minutes: number;
    max_fix_rounds: number;
    max_concurrent_soldiers: number;
    max_runs_per_day: number;
    max_file_size_mb: number;
  };
  ci: { wait_minutes_in_job: number; max_wait_minutes: number; log_excerpt_lines: number };
  sentinel: { interval_minutes: number };
  roles: {
    marshal: { model: string };
    soldier: { model: string };
    knight: { model: string };
    scout: { enabled: boolean; model: string };
  };
  git: { author: string };
  pr: { draft: boolean; link_realm: boolean };
  timezone: string;
}

/** Defaults for every optional key. `monarch` defaults to the Realm owner instead. */
export const DEFAULTS: Omit<Config, "version" | "monarch" | "targets"> = {
  approval: { plan: "multi-task" },
  limits: {
    max_turns: 150,
    run_timeout_minutes: 45,
    max_fix_rounds: 3,
    max_concurrent_soldiers: 3,
    max_runs_per_day: 30,
    max_file_size_mb: 5,
  },
  ci: { wait_minutes_in_job: 15, max_wait_minutes: 120, log_excerpt_lines: 200 },
  sentinel: { interval_minutes: 15 },
  roles: {
    marshal: { model: "opus" },
    soldier: { model: "sonnet" },
    knight: { model: "opus" },
    scout: { enabled: false, model: "sonnet" },
  },
  git: { author: "shadowarmy <shadowarmy@users.noreply.github.com>" },
  pr: { draft: false, link_realm: false },
  timezone: "UTC",
};

/** The Realm repository the configuration belongs to. */
export interface Realm {
  owner: string;
  repo: string;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; issues: ValidationIssue[] };

const validateRaw = compileValidator(configSchema);

/** Parse and validate shadowarmy.yml text. Every problem is returned, not just the first. */
export function parseConfig(text: string, realm: Realm): ConfigResult {
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: true });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      issues: doc.errors.map((error) => ({ path: "", message: `invalid YAML: ${error.message}` })),
    };
  }
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return { ok: false, issues: [{ path: "", message: `invalid YAML: ${(error as Error).message}` }] };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, issues: [{ path: "", message: "must be a mapping of keys to values" }] };
  }

  const validated = validateRaw(data);
  if (!validated.ok) return { ok: false, issues: validated.issues };

  const config = applyDefaults(validated.value, realm);
  const issues = crossFieldIssues(config);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, config };
}

/** YAML `key:` with no value is null; null and missing both mean "use the default". */
function pick<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

function applyDefaults(raw: RawConfig, realm: Realm): Config {
  const d = DEFAULTS;
  const limits = raw.limits ?? {};
  const ci = raw.ci ?? {};
  const roles = raw.roles ?? {};
  return {
    version: 1,
    monarch: pick(raw.monarch, realm.owner),
    targets: raw.targets,
    approval: { plan: pick(raw.approval?.plan, d.approval.plan) },
    limits: {
      max_turns: pick(limits.max_turns, d.limits.max_turns),
      run_timeout_minutes: pick(limits.run_timeout_minutes, d.limits.run_timeout_minutes),
      max_fix_rounds: pick(limits.max_fix_rounds, d.limits.max_fix_rounds),
      max_concurrent_soldiers: pick(limits.max_concurrent_soldiers, d.limits.max_concurrent_soldiers),
      max_runs_per_day: pick(limits.max_runs_per_day, d.limits.max_runs_per_day),
      max_file_size_mb: pick(limits.max_file_size_mb, d.limits.max_file_size_mb),
    },
    ci: {
      wait_minutes_in_job: pick(ci.wait_minutes_in_job, d.ci.wait_minutes_in_job),
      max_wait_minutes: pick(ci.max_wait_minutes, d.ci.max_wait_minutes),
      log_excerpt_lines: pick(ci.log_excerpt_lines, d.ci.log_excerpt_lines),
    },
    sentinel: { interval_minutes: pick(raw.sentinel?.interval_minutes, d.sentinel.interval_minutes) },
    roles: {
      marshal: { model: pick(roles.marshal?.model, d.roles.marshal.model) },
      soldier: { model: pick(roles.soldier?.model, d.roles.soldier.model) },
      knight: { model: pick(roles.knight?.model, d.roles.knight.model) },
      scout: {
        enabled: pick(roles.scout?.enabled, d.roles.scout.enabled),
        model: pick(roles.scout?.model, d.roles.scout.model),
      },
    },
    git: { author: pick(raw.git?.author, d.git.author) },
    pr: {
      draft: pick(raw.pr?.draft, d.pr.draft),
      link_realm: pick(raw.pr?.link_realm, d.pr.link_realm),
    },
    timezone: pick(raw.timezone, d.timezone),
  };
}

function crossFieldIssues(config: Config): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (config.ci.wait_minutes_in_job >= config.limits.run_timeout_minutes) {
    issues.push({
      path: "ci.wait_minutes_in_job",
      message: `must be less than limits.run_timeout_minutes (${String(config.limits.run_timeout_minutes)})`,
    });
  }
  if (config.ci.max_wait_minutes < config.ci.wait_minutes_in_job) {
    issues.push({
      path: "ci.max_wait_minutes",
      message: `must be at least ci.wait_minutes_in_job (${String(config.ci.wait_minutes_in_job)})`,
    });
  }
  if (!isTimeZone(config.timezone)) {
    issues.push({ path: "timezone", message: "must be an IANA time zone name such as \"UTC\" or \"Europe/Berlin\"" });
  }
  return issues;
}

export type TargetCheck = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether an order may target `target`. GitHub names are case-insensitive,
 * so matching is too. A Realm is never its own target.
 */
export function checkTarget(config: Config, target: string, realm: Realm): TargetCheck {
  if (!isRepoFullName(target)) {
    return { ok: false, reason: `"${target}" is not a repository name in the form owner/name` };
  }
  const wanted = target.toLowerCase();
  if (wanted === `${realm.owner}/${realm.repo}`.toLowerCase()) {
    return { ok: false, reason: "the Realm cannot be its own target" };
  }
  const [owner = ""] = wanted.split("/");
  const allowed = config.targets.some((pattern) => {
    const p = pattern.toLowerCase();
    return p === wanted || p === `${owner}/*`;
  });
  return allowed
    ? { ok: true }
    : { ok: false, reason: `"${target}" is not listed in targets in shadowarmy.yml` };
}
