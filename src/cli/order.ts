// Entry point for the steps of the reusable order workflow:
//   node src/cli/order.ts gate | deliver | judge | fail
// Configuration comes from environment variables set by the workflow; event
// data comes from the event payload file (and, for a dispatch, from the API),
// never from expressions in scripts.

import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDispatchedIssue, parseDispatchEvent, parseIssueLabeledEvent, readEventFile, type OrderEvent } from "../event.ts";
import { createClient, type GitHubClient } from "../github.ts";
import type { RunInfo } from "../order/context.ts";
import { runDeliver } from "../order/deliver.ts";
import { runFail } from "../order/fail.ts";
import { runGate } from "../order/gate.ts";
import { runJudge } from "../order/judge.ts";

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

function tempDir(prefix: string): string {
  return mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), prefix));
}

async function loadEvent(realmClient: GitHubClient): Promise<OrderEvent> {
  const payload = readEventFile(env("GITHUB_EVENT_PATH"));
  if (optional("GITHUB_EVENT_NAME") === "workflow_dispatch") return loadDispatchedIssue(realmClient, parseDispatchEvent(payload));
  return parseIssueLabeledEvent(payload);
}

async function main(command: string | undefined): Promise<void> {
  const apiUrl = optional("GITHUB_API_URL") || "https://api.github.com";
  const realmClient = createClient({ token: env("GITHUB_TOKEN"), apiUrl });
  const event = await loadEvent(realmClient);
  const run = runInfo();

  switch (command) {
    case "gate": {
      const result = await runGate({
        event,
        client: realmClient,
        targetClient: createClient({ token: optional("SHADOWARMY_GH_TOKEN"), apiUrl }),
        realmDir: env("SHADOWARMY_REALM_DIR"),
        engineDir: env("SHADOWARMY_ENGINE_DIR"),
        inputsDir: env("SHADOWARMY_INPUTS_DIR"),
        workDir: tempDir("shadowarmy-target-"),
        run,
        hasClaudeCredential: optional("HAS_CLAUDE_CREDENTIAL") === "true",
        githubToken: optional("SHADOWARMY_GH_TOKEN"),
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
        base_ref: result.baseRef ?? "",
        base_sha: result.baseSha ?? "",
        start_sha: result.startSha ?? "",
        round: String(result.round ?? 0),
        model: result.model ?? "",
        knight_model: result.knightModel ?? "",
        max_turns: String(result.maxTurns ?? 0),
        timeout_minutes: String(result.timeoutMinutes ?? 1),
        judge_timeout_minutes: String(result.judgeTimeoutMinutes ?? 1),
        fake_agent: result.fakeAgent ?? "",
      });
      return;
    }
    case "deliver": {
      const token = env("SHADOWARMY_GH_TOKEN");
      const result = await runDeliver({
        event,
        realmClient,
        targetClient: createClient({ token, apiUrl }),
        githubToken: token,
        realmDir: env("SHADOWARMY_REALM_DIR"),
        engineDir: env("SHADOWARMY_ENGINE_DIR"),
        soldierDir: env("SHADOWARMY_SOLDIER_DIR"),
        knightInputsDir: env("SHADOWARMY_KNIGHT_INPUTS_DIR"),
        soldierJob: optional("SOLDIER_JOB_RESULT"),
        baseRef: optional("BASE_REF"),
        baseSha: optional("BASE_SHA"),
        startSha: optional("START_SHA"),
        round: Number(optional("ROUND") || "0"),
        workDir: tempDir("shadowarmy-deliver-"),
        run,
        log,
      });
      setOutputs({ knight: String(result.knight), head_sha: result.headSha });
      return;
    }
    case "judge": {
      await runJudge({
        event,
        realmClient,
        targetClient: createClient({ token: env("SHADOWARMY_GH_TOKEN"), apiUrl }),
        realmDir: env("SHADOWARMY_REALM_DIR"),
        knightDir: env("SHADOWARMY_KNIGHT_DIR"),
        soldierDir: env("SHADOWARMY_SOLDIER_DIR"),
        knightJob: optional("KNIGHT_JOB_RESULT"),
        workflowRef: env("CALLER_WORKFLOW_REF"),
        reviewedSha: optional("REVIEWED_SHA"),
        run,
        now: () => new Date(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        log,
      });
      return;
    }
    case "fail": {
      await runFail({
        event,
        client: realmClient,
        run,
        jobs: {
          gate: optional("GATE_RESULT"),
          soldier: optional("SOLDIER_RESULT"),
          deliver: optional("DELIVER_RESULT"),
          knight: optional("KNIGHT_RESULT"),
          judge: optional("JUDGE_RESULT"),
        },
        log,
      });
      return;
    }
    default:
      throw new Error(`usage: node src/cli/order.ts gate | deliver | judge | fail (got ${String(command)})`);
  }
}

main(process.argv[2]).catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
