// Reads the GitHub event that started a workflow run. The payload is
// untrusted text from GitHub; only the fields the engine needs are taken,
// and each is type-checked.

import { readFileSync } from "node:fs";

export interface IssueLabeledEvent {
  label: string;
  sender: string;
  issue: { number: number; title: string; body: string; labels: string[] };
  repository: { fullName: string; owner: string; private: boolean };
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`event payload: ${what} is missing`);
  return value;
}

export function parseIssueLabeledEvent(payload: unknown): IssueLabeledEvent {
  const p = payload as Record<string, Record<string, unknown> | undefined>;
  if (p.issue === undefined || p.label === undefined || p.repository === undefined) {
    throw new Error("event payload is not an issues.labeled event");
  }
  const issue = p.issue;
  const number = issue.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) throw new Error("event payload: issue.number is missing");
  const labels = Array.isArray(issue.labels)
    ? (issue.labels as unknown[]).map((label) => {
        if (typeof label === "string") return label;
        const name = (label as { name?: unknown }).name;
        return typeof name === "string" ? name : "";
      })
    : [];
  if (issue.pull_request !== undefined) throw new Error("event payload: labeled item is a pull request, not an issue");
  const isPrivate = p.repository.private;
  if (typeof isPrivate !== "boolean") throw new Error("event payload: repository.private is missing");
  return {
    label: str(p.label.name, "label.name"),
    sender: str((p.sender as { login?: unknown } | undefined)?.login, "sender.login"),
    issue: {
      number,
      title: str(issue.title, "issue.title"),
      body: typeof issue.body === "string" ? issue.body : "",
      labels,
    },
    repository: {
      fullName: str(p.repository.full_name, "repository.full_name"),
      owner: str((p.repository.owner as { login?: unknown } | undefined)?.login, "repository.owner.login"),
      private: isPrivate,
    },
  };
}

export function readEventFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
