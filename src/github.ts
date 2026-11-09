// A small GitHub REST client on top of fetch. Engine scripts are the only code
// that talks to GitHub; agents never do. Every request is bounded: a timeout
// per attempt and a fixed number of retries for transient server errors on
// idempotent methods (never POST).

export class GitHubError extends Error {
  override name = "GitHubError";
  readonly status: number;
  readonly method: string;
  readonly path: string;
  constructor(method: string, path: string, status: number, detail: string) {
    super(`GitHub API ${method} ${path} failed with HTTP ${String(status)}: ${detail}`);
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

export interface GitHubClient {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** Follow `Link: rel="next"` pages of a list endpoint, up to `maxPages`. */
  paginate<T>(path: string, maxPages?: number): Promise<T[]>;
}

export interface ClientOptions {
  token: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const TRANSIENT = new Set([500, 502, 503, 504]);
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "PATCH", "DELETE"]);

export function createClient(options: ClientOptions): GitHubClient {
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retries = options.retries ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function send(method: string, url: string, body: unknown): Promise<Response> {
    let lastError: unknown;
    const attempts = IDEMPOTENT.has(method) ? retries : 0;
    for (let attempt = 0; attempt <= attempts; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
      try {
        const response = await doFetch(url, {
          method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${options.token}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "shadowarmy-engine",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!TRANSIENT.has(response.status) || attempt === attempts) return response;
        lastError = new Error(`HTTP ${String(response.status)}`);
      } catch (error) {
        lastError = error;
        if (attempt === attempts) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function parse<T>(method: string, path: string, response: Response): Promise<T> {
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 500);
      try {
        const message = (JSON.parse(text) as { message?: unknown }).message;
        if (typeof message === "string") detail = message;
      } catch {
        // Not JSON; keep the raw text.
      }
      throw new GitHubError(method, path, response.status, detail);
    }
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      return parse<T>(method, path, await send(method, `${apiUrl}${path}`, body));
    },
    async paginate<T>(path: string, maxPages = 10): Promise<T[]> {
      const items: T[] = [];
      let url: string | null = `${apiUrl}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
      for (let page = 0; url !== null && page < maxPages; page++) {
        const response = await send("GET", url, undefined);
        const data = await parse<unknown>("GET", path, response);
        // Some list endpoints wrap the items, for example { total_count, workflow_runs: [...] }.
        const list = Array.isArray(data)
          ? data
          : (Object.values(data as Record<string, unknown>).find((value) => Array.isArray(value)) ?? []);
        items.push(...(list as T[]));
        url = nextLink(response.headers.get("link"));
      }
      return items;
    },
  };
}

function nextLink(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/** Encode a value for a path segment, keeping `/` in `owner/repo`. */
export function repoPath(fullName: string): string {
  return fullName.split("/").map(encodeURIComponent).join("/");
}
