// Assembles the input files an agent reads (docs/roles.md#assembled-input-files).
// All of them are data for the agent; the prompts say so explicitly.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewSchemaText } from "./knightReview.ts";
import { resultSchemaText } from "./soldierResult.ts";

/** What every agent of an order reads. */
export interface OrderInputs {
  engineDir: string;
  realmDir: string;
  outDir: string;
  issue: { number: number; title: string };
  target: string;
  base: string | null;
  task: string;
  answers: readonly string[];
  /** Fix rounds used so far; 0 for the first Soldier run. */
  round: number;
}

export interface SoldierInputs extends OrderInputs {
  /** feedback.md for a fix round: Knight findings and failing checks. */
  feedback: string | null;
  /** Name of a fake agent scenario, or null for the real Soldier. */
  fakeAgent: string | null;
}

export interface KnightInputs extends OrderInputs {
  /** The full diff of the task branch against the commit the first round started from. */
  diff: string;
  /** The latest Soldier result.json, as written by the Soldier. */
  soldierResult: string;
}

/** `projects/<owner>__<repo>.md` in the Realm. */
export function projectNotesPath(target: string): string {
  return join("projects", `${target.replace("/", "__")}.md`);
}

function writer(dir: string) {
  return (name: string, text: string) => {
    writeFileSync(join(dir, name), text.endsWith("\n") || text === "" ? text : `${text}\n`);
  };
}

function writeOrderInputs(inputs: OrderInputs, role: "soldier" | "knight", schema: string): void {
  mkdirSync(inputs.outDir, { recursive: true });
  const write = writer(inputs.outDir);

  write("prompt.md", readFileSync(join(inputs.engineDir, "roles", `${role}.md`), "utf8").replace(`{{${role === "soldier" ? "RESULT" : "REVIEW"}_SCHEMA}}`, schema));

  const company = join(inputs.realmDir, "rules", "company.md");
  write("company.md", existsSync(company) ? readFileSync(company, "utf8") : "No company rules are set.");

  const project = join(inputs.realmDir, projectNotesPath(inputs.target));
  if (existsSync(project)) write("project.md", readFileSync(project, "utf8"));

  const header = [
    `Order: Realm issue #${String(inputs.issue.number)}`,
    `Title: ${inputs.issue.title}`,
    `Target repository: ${inputs.target}`,
    `Base branch: ${inputs.base ?? "the repository's default branch"}`,
    `Fix round: ${inputs.round === 0 ? "none (first attempt)" : String(inputs.round)}`,
  ].join("\n");
  write("order.md", `${header}\n\n## Task\n\n${inputs.task}`);
  // A single-task order is its own task (behavior contract section 3).
  write("task.md", `# ${inputs.issue.title}\n\n${inputs.task}`);
  write(
    "answers.md",
    inputs.answers.length === 0 ? "No answers yet." : inputs.answers.map((answer, i) => `## Answer ${String(i + 1)}\n\n${answer}`).join("\n\n"),
  );
  write("round", String(inputs.round));
}

export function writeSoldierInputs(inputs: SoldierInputs): void {
  writeOrderInputs(inputs, "soldier", resultSchemaText());
  const write = writer(inputs.outDir);
  if (inputs.feedback !== null) write("feedback.md", inputs.feedback);
  if (inputs.fakeAgent !== null) {
    copyFileSync(join(inputs.engineDir, "scripts", "fake-agent.sh"), join(inputs.outDir, "fake-agent.sh"));
    write("fake-agent-scenario", inputs.fakeAgent);
  }
}

export function writeKnightInputs(inputs: KnightInputs): void {
  writeOrderInputs(inputs, "knight", reviewSchemaText());
  const write = writer(inputs.outDir);
  write("diff.patch", inputs.diff);
  write("soldier-result.json", inputs.soldierResult);
}
