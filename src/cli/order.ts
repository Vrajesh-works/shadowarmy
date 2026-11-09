// Entry point for the steps of the reusable order workflow:
//   node src/cli/order.ts gate | deliver | fail
// Configuration comes from environment variables set by the workflow; event
// data comes from the event payload file, never from expressions in scripts.

import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIssueLabeledEvent, readEventFile } from "../event.ts";
import { createClient } from "../github.ts";
import { runDeliver } from "../order/deliver.ts";
import { runFail } from "../order/fail.ts";
import { runGate } from "../order/gate.ts";
import type { RunInfo } from "../order/context.ts";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`environment variable ${name} is not set`);
  return value;
}

function optional(name: string): string {
  return process.env[name] ?? "";
}

/** Write step outputs with a random delimiter so no value can inject another output. */
function setOutputs(outputs: Record<string, string>): void {
  const file = env("GITHUB_OUTPUT");
  for (const [key, value] of Object.entries(outputs)) {
    const delimiter = `EOF_${crypto.randomUUID()}`;
    appendFileSync(file, `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
  }
}

function log(line: string): void {
  console.log(line);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== "") appendFileSync(summary, `${line}\n\n`);
}

function runInfo(): RunInfo {
  const serverUrl = optional("GITHUB_SERVER_URL") || "https://github.com";
  const runId = Number(env("GITHUB_RUN_ID"));
  return { runId, serverUrl, runUrl: `${serverUrl}/${env("GITHUB_REPOSITORY")}/actions/runs/${String(runId)}` };
}

async function main(command: string | undefined): Promise<void> {
  const event = parseIssueLabeledEvent(readEventFile(env("GITHUB_EVENT_PATH")));
  const apiUrl = optional("GITHUB_API_URL") || "https://api.github.com";
  const realmClient = createClient({ token: env("GITHUB_TOKEN"), apiUrl });
  const run = runInfo();

  switch (command) {
    case "gate": {
      const result = await runGate({
        event,
        client: realmClient,
        realmDir: env("SHADOWARMY_REALM_DIR"),
        engineDir: env("SHADOWARMY_ENGINE_DIR"),
        inputsDir: env("SHADOWARMY_INPUTS_DIR"),
        run,
        hasClaudeCredential: optional("HAS_CLAUDE_CREDENTIAL") === "true",
        hasGitHubToken: optional("HAS_GH_TOKEN") === "true",
        fakeAgent: optional("SHADOWARMY_FAKE_AGENT"),
        now: new Date(),
        log,
        onAuthorized: () => {
          setOutputs({ authorized: "true" });
        },
      });
      setOutputs({
        proceed: String(result.proceed),
        target: result.target ?? "",
        base: result.base ?? "",
        model: result.model ?? "",
        max_turns: String(result.maxTurns ?? 0),
        timeout_minutes: String(result.timeoutMinutes ?? 1),
        fake_agent: result.fakeAgent ?? "",
      });
      return;
    }
    case "deliver": {
      const token = env("SHADOWARMY_GH_TOKEN");
      await runDeliver({
        event,
        realmClient,
        targetClient: createClient({ token, apiUrl }),
        githubToken: token,
        realmDir: env("SHADOWARMY_REALM_DIR"),
        soldierDir: env("SHADOWARMY_SOLDIER_DIR"),
        soldierJob: optional("SOLDIER_JOB_RESULT"),
        baseSha: optional("BASE_SHA"),
        baseRef: optional("BASE_REF"),
        workDir: mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "shadowarmy-deliver-")),
        run,
        log,
      });
      return;
    }
    case "fail": {
      await runFail({
        event,
        client: realmClient,
        run,
        jobs: { gate: optional("GATE_RESULT"), soldier: optional("SOLDIER_RESULT"), deliver: optional("DELIVER_RESULT") },
        log,
      });
      return;
    }
    default:
      throw new Error(`usage: node src/cli/order.ts gate | deliver | fail (got ${String(command)})`);
  }
}

main(process.argv[2]).catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
