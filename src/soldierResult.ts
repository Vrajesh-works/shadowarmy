// Reads and validates the Soldier's result.json. Agent output is untrusted:
// anything that does not match the schema is a failure, never a guess.

import { compileUncheckedValidator, formatIssues } from "./schema.ts";
import { resultSchema, type SoldierResult } from "./schemas/result.ts";

export type { SoldierResult, Verification } from "./schemas/result.ts";

/** result.json larger than this is rejected before parsing. */
export const MAX_RESULT_BYTES = 256 * 1024;

const validate = compileUncheckedValidator<SoldierResult>(resultSchema);

export type ResultCheck = { ok: true; result: SoldierResult } | { ok: false; reason: string };

export function checkSoldierResult(text: string | null): ResultCheck {
  if (text === null) return { ok: false, reason: "the Soldier did not write result.json" };
  if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) {
    return { ok: false, reason: `result.json is larger than ${String(MAX_RESULT_BYTES / 1024)} KB` };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    // Parser messages quote the input and can span lines; the status comment shows reasons line by line.
    return { ok: false, reason: `result.json is not valid JSON: ${(error as Error).message.replace(/\s+/g, " ").trim()}` };
  }
  const checked = validate(data);
  if (!checked.ok) {
    return { ok: false, reason: `result.json does not match the schema: ${formatIssues(checked.issues).replaceAll("\n", "; ")}` };
  }
  return { ok: true, result: checked.value };
}

/** The result schema as pretty JSON, for the Soldier's prompt. */
export function resultSchemaText(): string {
  return JSON.stringify(resultSchema, null, 2);
}
