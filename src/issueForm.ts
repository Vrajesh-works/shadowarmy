// Parses Realm issues created from the Order and New project forms
// (docs/configuration.md#issue-forms). GitHub renders each answer as a
// `### <field label>` section; empty optional answers read `_No response_`.
//
// The body is untrusted data. A multi-line answer can itself contain lines
// that look like section headings, so sections are not split naively:
// single-line answers (inputs, dropdowns) are fixed to one line, and the end
// of a multi-line answer is the last matching heading that still lets the rest
// of the form parse. Values are returned verbatim apart from trimming.

import { isRepoFullName, isRepoName, isSafeBranchName } from "./names.ts";
import type { ValidationIssue } from "./schema.ts";

/** GitHub limits an issue body to 65536 characters. */
export const MAX_BODY_LENGTH = 65536;
const NO_RESPONSE = "_No response_";

interface FieldSpec<Id extends string> {
  id: Id;
  /** The `label` in the issue form template; the heading GitHub renders. */
  label: string;
  /** `line` for inputs and dropdowns, `text` for textareas. */
  kind: "line" | "text";
}

export interface FormSpec<Id extends string> {
  name: string;
  fields: readonly FieldSpec<Id>[];
}

export const ORDER_FORM: FormSpec<"target" | "task" | "base"> = {
  name: "Order",
  fields: [
    { id: "target", label: "Target repository", kind: "line" },
    { id: "task", label: "Task", kind: "text" },
    { id: "base", label: "Base branch", kind: "line" },
  ],
};

export const NEW_PROJECT_FORM: FormSpec<"idea" | "name" | "visibility"> = {
  name: "New project",
  fields: [
    { id: "idea", label: "Idea", kind: "text" },
    { id: "name", label: "Repository name", kind: "line" },
    { id: "visibility", label: "Visibility", kind: "line" },
  ],
};

export interface OrderForm {
  target: string;
  task: string;
  /** Null means the target's default branch. */
  base: string | null;
}

export interface NewProjectForm {
  idea: string;
  /** Null means the Marshal proposes a name. */
  name: string | null;
  visibility: "private" | "public";
}

export type FormResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

export function parseOrderForm(body: string): FormResult<OrderForm> {
  const sections = readSections(body, ORDER_FORM);
  if (!sections.ok) return sections;
  const { target, task, base } = sections.value;
  const issues: ValidationIssue[] = [];

  if (target === null) issues.push({ path: "target", message: "is required" });
  else if (!isRepoFullName(target)) issues.push({ path: "target", message: "must be a repository in the form owner/name" });
  if (task === null) issues.push({ path: "task", message: "is required" });
  if (base !== null && !isSafeBranchName(base)) issues.push({ path: "base", message: "must be a valid branch name" });

  if (issues.length > 0 || target === null || task === null) return { ok: false, issues };
  return { ok: true, value: { target, task, base } };
}

export function parseNewProjectForm(body: string): FormResult<NewProjectForm> {
  const sections = readSections(body, NEW_PROJECT_FORM);
  if (!sections.ok) return sections;
  const { idea, name, visibility } = sections.value;
  const issues: ValidationIssue[] = [];

  if (idea === null) issues.push({ path: "idea", message: "is required" });
  if (name !== null && !isRepoName(name)) {
    issues.push({ path: "name", message: "must be a repository name (letters, digits, '.', '-', '_')" });
  }
  if (visibility === null) issues.push({ path: "visibility", message: "is required" });
  else if (visibility !== "private" && visibility !== "public") {
    issues.push({ path: "visibility", message: "must be \"private\" or \"public\"" });
  }

  if (issues.length > 0 || idea === null || (visibility !== "private" && visibility !== "public")) {
    return { ok: false, issues };
  }
  return { ok: true, value: { idea, name, visibility } };
}

type Sections<Id extends string> = FormResult<Record<Id, string | null>>;

function readSections<Id extends string>(body: string, form: FormSpec<Id>): Sections<Id> {
  const fail = (message: string): Sections<Id> => ({ ok: false, issues: [{ path: "", message }] });
  if (body.length > MAX_BODY_LENGTH) return fail(`issue body is longer than ${String(MAX_BODY_LENGTH)} characters`);

  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  // nonBlank[i] = number of non-blank lines before line i, for O(1) range counts.
  const nonBlank = [0];
  for (const line of lines) nonBlank.push((nonBlank.at(-1) ?? 0) + (line.trim() === "" ? 0 : 1));
  const countNonBlank = (from: number, to: number) => (nonBlank[to] ?? 0) - (nonBlank[from] ?? 0);

  const headingLines = form.fields.map((field) => {
    const heading = `### ${field.label}`;
    return lines.flatMap((line, index) => (line.trim() === heading ? [index] : []));
  });
  const missing = form.fields.filter((_, index) => headingLines[index]?.length === 0);
  if (missing.length > 0) {
    return fail(
      `does not match the ${form.name} form: missing ${missing.map((field) => `"### ${field.label}"`).join(", ")}`,
    );
  }

  const first = lines.findIndex((line) => line.trim() !== "");
  if (headingLines[0]?.[0] !== first) {
    return fail(`does not match the ${form.name} form: it must start with "### ${form.fields[0]?.label ?? ""}"`);
  }

  // starts[i] = line index of field i's heading. Fields end where the next starts.
  const solve = (fieldIndex: number, start: number): number[] | null => {
    const field = form.fields[fieldIndex];
    if (field === undefined) return [];
    const isLast = fieldIndex === form.fields.length - 1;
    const fits = (end: number) => field.kind === "text" || countNonBlank(start + 1, end) <= 1;
    if (isLast) return fits(lines.length) ? [start] : null;

    const later = (headingLines[fieldIndex + 1] ?? []).filter((index) => index > start);
    // A single-line answer cannot contain a heading line, so the next heading is the first one.
    const candidates = field.kind === "line" ? later.slice(0, 1) : later.reverse();
    for (const next of candidates) {
      if (!fits(next)) continue;
      const rest = solve(fieldIndex + 1, next);
      if (rest !== null) return [start, ...rest];
    }
    return null;
  };

  const starts = solve(0, first);
  if (starts === null) {
    return fail(
      `does not match the ${form.name} form: sections must appear once each, in order, ` +
        `with single-line answers for ${form.fields
          .filter((field) => field.kind === "line")
          .map((field) => `"${field.label}"`)
          .join(", ")}`,
    );
  }

  const values = {} as Record<Id, string | null>;
  form.fields.forEach((field, index) => {
    const start = starts[index] ?? 0;
    const end = starts[index + 1] ?? lines.length;
    const text = lines.slice(start + 1, end).join("\n").trim();
    values[field.id] = text === "" || text === NO_RESPONSE ? null : text;
  });
  return { ok: true, value: values };
}
