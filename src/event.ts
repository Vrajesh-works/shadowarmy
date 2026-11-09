// Reads the GitHub event that started a workflow run. The payload is
// untrusted text from GitHub; only the fields the engine needs are taken,
// and each is type-checked.
//
// Two events start an order run:
//   issues.labeled     - the Monarch added a label (only `arise` counts).
//   workflow_dispatch  - the engine (or the Monarch) continues an order, with
//                        the issue number as input; the issue itself is then
//                        read from the API (see loadDispatchedIssue).

import { readFileSync } from "node:fs";
import { repoPath, type GitHubClient } from "./github.ts";

export interface OrderIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

export interface OrderEvent {
  trigger: "label" | "dispatch";
  /** The label that was added; empty for a dispatch. */
  label: string;
  sender: string;
  issue: OrderIssue;
  repository: { fullName: string; owner: string; private: boolean };
}

/** A dispatch before its issue has been read from the API. */
export interface DispatchEvent {
  sender: string;
  issueNumber: number;
  repository: OrderEvent["repository"];
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`event payload: ${what} is missing`);
  return value;
}

function issueNumber(value: unknown, what: string): number {
  const number = typeof value === "string" && /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) throw new Error(`event payload: ${what} is missing`);
  return number;
}

function labelNames(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).map((label) => {
        if (typeof label === "string") return label;
        const name = (label as { name?: unknown }).name;
        return typeof name === "string" ? name : "";
      })
    : [];
}

function repository(p: Record<string, Record<string, unknown> | undefined>): OrderEvent["repository"] {
  if (p.repository === undefined) throw new Error("event payload: repository is missing");
  const isPrivate = p.repository.private;
  if (typeof isPrivate !== "boolean") throw new Error("event payload: repository.private is missing");
  return {
    fullName: str(p.repository.full_name, "repository.full_name"),
    owner: str((p.repository.owner as { login?: unknown } | undefined)?.login, "repository.owner.login"),
    private: isPrivate,
  };
}

export function parseIssueLabeledEvent(payload: unknown): OrderEvent {
  const p = payload as Record<string, Record<string, unknown> | undefined>;
  if (p.issue === undefined || p.label === undefined || p.repository === undefined) {
    throw new Error("event payload is not an issues.labeled event");
  }
  const issue = p.issue;
  if (issue.pull_request !== undefined) throw new Error("event payload: labeled item is a pull request, not an issue");
  return {
    trigger: "label",
    label: str(p.label.name, "label.name"),
    sender: str((p.sender as { login?: unknown } | undefined)?.login, "sender.login"),
    issue: {
      number: issueNumber(issue.number, "issue.number"),
      title: str(issue.title, "issue.title"),
      body: typeof issue.body === "string" ? issue.body : "",
      labels: labelNames(issue.labels),
    },
    repository: repository(p),
  };
}

export function parseDispatchEvent(payload: unknown): DispatchEvent {
  const p = payload as Record<string, Record<string, unknown> | undefined>;
  if (p.inputs === undefined) throw new Error("event payload is not a workflow_dispatch event");
  return {
    sender: str((p.sender as { login?: unknown } | undefined)?.login, "sender.login"),
    issueNumber: issueNumber(p.inputs.issue, "inputs.issue"),
    repository: repository(p),
  };
}

/** Read the dispatched issue from the API and complete the event. Pull requests are refused. */
export async function loadDispatchedIssue(client: GitHubClient, dispatch: DispatchEvent): Promise<OrderEvent> {
  const issue = await client.request<Record<string, unknown>>(
    "GET",
    `/repos/${repoPath(dispatch.repository.fullName)}/issues/${String(dispatch.issueNumber)}`,
  );
  if (issue.pull_request !== undefined) throw new Error(`#${String(dispatch.issueNumber)} is a pull request, not an order issue`);
  return {
    trigger: "dispatch",
    label: "",
    sender: dispatch.sender,
    issue: {
      number: dispatch.issueNumber,
      title: str(issue.title, "issue.title"),
      body: typeof issue.body === "string" ? issue.body : "",
      labels: labelNames(issue.labels),
    },
    repository: dispatch.repository,
  };
}

export function readEventFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
