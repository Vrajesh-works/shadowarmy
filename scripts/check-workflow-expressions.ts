// Fails when any `run:` script in a workflow or composite action contains a
// `${{ }}` expression. Expressions are expanded into the script text before
// the shell runs it, so an issue title or branch name could become code
// (docs/security.md). Values must reach scripts through `env:` instead.
//
// Usage: node scripts/check-workflow-expressions.ts [files...]
// Without arguments it checks every workflow and action file tracked by git.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node } from "yaml";

export interface Finding {
  file: string;
  line: number;
  message: string;
}

const EXPRESSION = "${{";

/** Find every `run:` value in a workflow (`jobs.*.steps[*]`) or composite action (`runs.steps[*]`) with an expression. */
export function findRunExpressions(text: string, file: string): Finding[] {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  if (doc.errors.length > 0) {
    return doc.errors.map((error) => ({ file, line: error.linePos?.[0].line ?? 1, message: `invalid YAML: ${error.message}` }));
  }

  const findings: Finding[] = [];
  const checkSteps = (steps: unknown, where: string) => {
    if (!isSeq(steps)) return;
    steps.items.forEach((step, index) => {
      if (!isMap(step)) return;
      const run = step.get("run", true);
      if (isScalar(run) && typeof run.value === "string" && run.value.includes(EXPRESSION)) {
        findings.push({
          file,
          line: lineOf(run, lineCounter),
          message: `${where}.steps[${String(index)}].run contains a \${{ }} expression; pass the value through env: instead`,
        });
      }
    });
  };

  const jobs = doc.get("jobs", true);
  if (isMap(jobs)) {
    for (const pair of jobs.items) {
      const name = isScalar(pair.key) ? String(pair.key.value) : "?";
      if (isMap(pair.value)) checkSteps(pair.value.get("steps", true), `jobs.${name}`);
    }
  }
  const runs = doc.get("runs", true);
  if (isMap(runs)) checkSteps(runs.get("steps", true), "runs");
  return findings;
}

function lineOf(node: Node, lineCounter: LineCounter): number {
  const offset = node.range?.[0] ?? 0;
  return lineCounter.linePos(offset).line;
}

function trackedWorkflowFiles(): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "--", "*.github/workflows/*.yml", "*.github/workflows/*.yaml", "**/action.yml", "**/action.yaml", "action.yml", "action.yaml"],
    { encoding: "utf8" },
  );
  return output.split("\n").filter((line) => line !== "");
}

function main(args: string[]): number {
  const files = args.length > 0 ? args : trackedWorkflowFiles();
  const findings = files.flatMap((file) => findRunExpressions(readFileSync(file, "utf8"), file));
  for (const finding of findings) console.error(`${finding.file}:${String(finding.line)}: ${finding.message}`);
  if (findings.length === 0) console.log(`No expressions in run: scripts (${String(files.length)} files checked).`);
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
