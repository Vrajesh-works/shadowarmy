// Shared JSON Schema validator. Schemas live in src/schemas/ as TypeScript
// modules. Where Ajv's JSONSchemaType can describe a schema, it is typed with
// it, so the schema and the TypeScript type cannot drift apart silently.

import { Ajv, type ErrorObject, type JSONSchemaType, type SchemaObject } from "ajv";
import { isLogin, isRepoFullName, isSafeBranchName, isTargetPattern, isTaskBranch, isUtcDateTime } from "./names.ts";

/** One validation problem, located by a dotted path such as `limits.max_turns`. */
export interface ValidationIssue {
  path: string;
  message: string;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

const ajv = new Ajv({ allErrors: true, strict: true, verbose: true });
ajv.addFormat("login", { type: "string", validate: isLogin });
ajv.addFormat("target-pattern", { type: "string", validate: isTargetPattern });
ajv.addFormat("repo-full-name", { type: "string", validate: isRepoFullName });
ajv.addFormat("branch-name", { type: "string", validate: isSafeBranchName });
ajv.addFormat("task-branch", { type: "string", validate: isTaskBranch });
ajv.addFormat("utc-date-time", { type: "string", validate: isUtcDateTime });

/** Compile a schema into a function that returns a typed value or every problem found. */
export function compileValidator<T>(schema: JSONSchemaType<T>): (data: unknown) => Validated<T> {
  return compileUncheckedValidator<T>(schema);
}

/**
 * Like compileValidator for schemas Ajv's static types cannot describe (such as
 * required keys that may be null). The caller's tests must keep `T` and the schema in step.
 */
export function compileUncheckedValidator<T>(schema: SchemaObject): (data: unknown) => Validated<T> {
  const validate = ajv.compile<T>(schema);
  return (data) => {
    if (validate(data)) return { ok: true, value: data };
    return { ok: false, issues: dedupe((validate.errors ?? []).map(toIssue)) };
  };
}

/** `"/limits/max_turns"` to `"limits.max_turns"`, `"/targets/0"` to `"targets[0]"`. */
export function pointerToPath(pointer: string): string {
  let path = "";
  for (const raw of pointer.split("/").slice(1)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    path += /^\d+$/.test(segment) ? `[${segment}]` : path === "" ? segment : `.${segment}`;
  }
  return path;
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function toIssue(error: ErrorObject): ValidationIssue {
  const path = pointerToPath(error.instancePath);
  const params = error.params as Record<string, unknown>;
  const described = (error.parentSchema as { description?: unknown } | undefined)?.description;
  switch (error.keyword) {
    case "required":
      return { path: join(path, String(params.missingProperty)), message: "is required" };
    case "additionalProperties":
      return { path: join(path, String(params.additionalProperty)), message: "is not a known key" };
    case "type":
      return { path, message: `must be ${String(params.type).replace(",", " or ")}` };
    case "enum":
      return {
        path,
        message: `must be one of: ${(params.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`,
      };
    case "const":
      return { path, message: `must be ${JSON.stringify(params.allowedValue)}` };
    case "pattern":
    case "format":
      return {
        path,
        message: typeof described === "string" ? `must be ${described}` : (error.message ?? "is invalid"),
      };
    default:
      return { path, message: error.message ?? "is invalid" };
  }
}

function dedupe(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Render problems as one line each: `path: message`. */
export function formatIssues(issues: readonly ValidationIssue[], prefix = ""): string {
  return issues
    .map((issue) => `${prefix}${issue.path === "" ? "(root)" : issue.path}: ${issue.message}`)
    .join("\n");
}
