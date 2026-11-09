// Assembles the input files an agent reads (docs/roles.md#assembled-input-files).
// All of them are data for the agent; the prompt says so explicitly.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resultSchemaText } from "./soldierResult.ts";

export interface SoldierInputs {
  engineDir: string;
  realmDir: string;
  outDir: string;
  issue: { number: number; title: string };
  target: string;
  base: string | null;
  task: string;
  answers: readonly string[];
  /** Name of a fake agent scenario, or null for the real Soldier. */
  fakeAgent: string | null;
}

/** `projects/<owner>__<repo>.md` in the Realm. */
export function projectNotesPath(target: string): string {
  return join("projects", `${target.replace("/", "__")}.md`);
}

export function writeSoldierInputs(inputs: SoldierInputs): void {
  mkdirSync(inputs.outDir, { recursive: true });
  const write = (name: string, text: string) => {
    writeFileSync(join(inputs.outDir, name), text.endsWith("\n") ? text : `${text}\n`);
  };

  const prompt = readFileSync(join(inputs.engineDir, "roles", "soldier.md"), "utf8").replace(
    "{{RESULT_SCHEMA}}",
    resultSchemaText(),
  );
  write("prompt.md", prompt);

  const company = join(inputs.realmDir, "rules", "company.md");
  write("company.md", existsSync(company) ? readFileSync(company, "utf8") : "No company rules are set.");

  const project = join(inputs.realmDir, projectNotesPath(inputs.target));
  if (existsSync(project)) write("project.md", readFileSync(project, "utf8"));

  const header = [
    `Order: Realm issue #${String(inputs.issue.number)}`,
    `Title: ${inputs.issue.title}`,
    `Target repository: ${inputs.target}`,
    `Base branch: ${inputs.base ?? "the repository's default branch"}`,
  ].join("\n");
  write("order.md", `${header}\n\n## Task\n\n${inputs.task}`);
  // A single-task order is its own task (behavior contract section 3).
  write("task.md", `# ${inputs.issue.title}\n\n${inputs.task}`);
  write(
    "answers.md",
    inputs.answers.length === 0 ? "No answers yet." : inputs.answers.map((answer, i) => `## Answer ${String(i + 1)}\n\n${answer}`).join("\n\n"),
  );

  if (inputs.fakeAgent !== null) {
    copyFileSync(join(inputs.engineDir, "scripts", "fake-agent.sh"), join(inputs.outDir, "fake-agent.sh"));
    write("fake-agent-scenario", inputs.fakeAgent);
  }
}
