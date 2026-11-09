// An in-memory GitHub for tests: implements the REST routes the engine uses
// on issues, comments, labels, workflow runs, repositories and pull requests.

import { GitHubError, type GitHubClient } from "../../src/github.ts";

export interface FakeComment {
  id: number;
  body: string;
  user: { login: string };
}

export interface FakeIssue {
  labels: string[];
  comments: FakeComment[];
}

export interface FakeJob {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
}

export interface FakePull {
  number: number;
  html_url: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  state: "open" | "closed";
}

export class FakeGitHub implements GitHubClient {
  issues = new Map<string, FakeIssue>();
  runs: { id: number; created_at: string; jobs: FakeJob[] }[] = [];
  repos = new Map<string, { private: boolean }>();
  pulls = new Map<string, FakePull[]>();
  calls: string[] = [];
  private nextId = 1000;

  issue(repo: string, number: number): FakeIssue {
    const key = `${repo}#${String(number)}`;
    let issue = this.issues.get(key);
    if (issue === undefined) {
      issue = { labels: [], comments: [] };
      this.issues.set(key, issue);
    }
    return issue;
  }

  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push(`${method} ${path}`);
    return Promise.resolve(this.route(method, path, body) as T);
  }

  paginate<T>(path: string): Promise<T[]> {
    this.calls.push(`GET* ${path}`);
    const result = this.route("GET", path, undefined);
    if (Array.isArray(result)) return Promise.resolve(result as T[]);
    const list = Object.values(result as Record<string, unknown>).find((value) => Array.isArray(value));
    return Promise.resolve((list ?? []) as T[]);
  }

  private route(method: string, path: string, body: unknown): unknown {
    const [pathname = "", query = ""] = path.split("?");
    const params = new URLSearchParams(query);
    let m: RegExpExecArray | null;

    if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/labels$/.exec(pathname))) {
      const issue = this.issue(decodeURIComponent(m[1] ?? ""), Number(m[2]));
      if (method === "GET") return issue.labels.map((name) => ({ name }));
      if (method === "PUT") {
        issue.labels = [...(body as { labels: string[] }).labels];
        return issue.labels.map((name) => ({ name }));
      }
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(pathname))) {
      const issue = this.issue(decodeURIComponent(m[1] ?? ""), Number(m[2]));
      if (method === "GET") return issue.comments;
      if (method === "POST") {
        const comment = { id: this.nextId++, body: (body as { body: string }).body, user: { login: "github-actions[bot]" } };
        issue.comments.push(comment);
        return comment;
      }
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/.exec(pathname)) && method === "PATCH") {
      for (const issue of this.issues.values()) {
        const comment = issue.comments.find((c) => c.id === Number(m?.[2]));
        if (comment) {
          comment.body = (body as { body: string }).body;
          return comment;
        }
      }
      throw new GitHubError(method, path, 404, "Not Found");
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs$/.exec(pathname)) && method === "GET") {
      const since = (params.get("created") ?? ">=1970-01-01T00:00:00Z").slice(2);
      return { workflow_runs: this.runs.filter((run) => run.created_at >= since).map((run) => ({ id: run.id })) };
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/jobs$/.exec(pathname)) && method === "GET") {
      return { jobs: this.runs.find((run) => run.id === Number(m?.[2]))?.jobs ?? [] };
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(pathname))) {
      const repo = decodeURIComponent(m[1] ?? "");
      const pulls = this.pulls.get(repo) ?? [];
      if (method === "GET") {
        const head = params.get("head") ?? "";
        return pulls.filter((pull) => pull.state === "open" && `${repo.split("/")[0] ?? ""}:${pull.head}` === head);
      }
      if (method === "POST") {
        const b = body as { title: string; body: string; head: string; base: string; draft: boolean };
        const number = pulls.length + 1;
        const pull: FakePull = { number, html_url: `https://github.com/${repo}/pull/${String(number)}`, state: "open", ...b };
        this.pulls.set(repo, [...pulls, pull]);
        return pull;
      }
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(pathname)) && method === "PATCH") {
      const pull = (this.pulls.get(decodeURIComponent(m[1] ?? "")) ?? []).find((p) => p.number === Number(m?.[2]));
      if (pull === undefined) throw new GitHubError(method, path, 404, "Not Found");
      Object.assign(pull, body);
      return pull;
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(pathname)) && method === "GET") {
      const repo = this.repos.get(decodeURIComponent(m[1] ?? ""));
      if (repo === undefined) throw new GitHubError(method, path, 404, "Not Found");
      return repo;
    }
    throw new GitHubError(method, path, 404, `fake GitHub has no route for ${method} ${path}`);
  }
}
