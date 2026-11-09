// GitHub operations on a Realm issue: labels and the one status comment.
// Only comments written by the Realm's Actions bot are trusted as status
// comments (docs/security.md); anyone can paste the marker into a comment.

import { repoPath, type GitHubClient } from "./github.ts";
import { setState, type IssueLabelsApi, type StateLabel, type TransitionResult } from "./labels.ts";
import {
  isStatusComment,
  parseStatusComment,
  renderStatusComment,
  type StateBlock,
  type StatusView,
} from "./statusComment.ts";

/** The login GitHub shows for comments made with a repository's GITHUB_TOKEN. */
export const ACTIONS_BOT = "github-actions[bot]";

interface CommentJson {
  id: number;
  body?: string | null;
  user?: { login?: string } | null;
}

export interface StatusCommentRef {
  id: number;
  body: string;
}

export class RealmIssue {
  readonly client: GitHubClient;
  readonly repo: string;
  readonly number: number;

  constructor(client: GitHubClient, repo: string, number: number) {
    this.client = client;
    this.repo = repo;
    this.number = number;
  }

  private get base(): string {
    return `/repos/${repoPath(this.repo)}/issues/${String(this.number)}`;
  }

  labelsApi(): IssueLabelsApi {
    return {
      listLabels: async () => {
        const labels = await this.client.paginate<{ name: string }>(`${this.base}/labels`);
        return labels.map((label) => label.name);
      },
      replaceLabels: async (_issue, labels) => {
        await this.client.request("PUT", `${this.base}/labels`, { labels });
      },
    };
  }

  setState(to: StateLabel, options: { derived?: boolean } = {}): Promise<TransitionResult> {
    return setState(this.labelsApi(), this.number, to, options);
  }

  async listLabels(): Promise<string[]> {
    return this.labelsApi().listLabels(this.number);
  }

  /** The engine-authored status comment, if one exists. */
  async findStatusComment(): Promise<StatusCommentRef | null> {
    const comments = await this.client.paginate<CommentJson>(`${this.base}/comments`, 30);
    for (const comment of comments) {
      const body = comment.body ?? "";
      if (comment.user?.login === ACTIONS_BOT && isStatusComment(body)) return { id: comment.id, body };
    }
    return null;
  }

  /** The current state block, or null when there is no status comment yet. Throws when it is unreadable. */
  async readState(): Promise<StateBlock | null> {
    const comment = await this.findStatusComment();
    if (comment === null) return null;
    const parsed = parseStatusComment(comment.body);
    if (!parsed.ok) throw new Error(`the status comment is unreadable: ${parsed.reason}`);
    return parsed.state;
  }

  /** Create or edit the status comment in place. */
  async writeStatus(view: StatusView, state: StateBlock): Promise<void> {
    const body = renderStatusComment(view, state);
    const existing = await this.findStatusComment();
    if (existing === null) {
      await this.client.request("POST", `${this.base}/comments`, { body });
    } else {
      await this.client.request("PATCH", `/repos/${repoPath(this.repo)}/issues/comments/${String(existing.id)}`, { body });
    }
  }
}
