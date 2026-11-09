# shadowarmy Behavior Contract

Updated November 8, 2026. This specification records the agreed product rules, implementation boundaries and regression requirements. Each section states its status. When a rule is implemented, mark it implemented and name the tests that cover it.

Milestone 0 added the deterministic building blocks for sections 4 and 5 as library code with unit tests. No workflow calls them yet, so no rule below is implemented end to end on GitHub.

Read [the root instructions](../AGENTS.md) before editing. Implementation work does not authorize changing a rule here. Resolve contradictions or missing decisions explicitly, record them in [decisions](decisions.md) and update affected docs and diagrams in the same pull request.

## 1. Principles

Agreed November 8, 2026.

- **One human.** The Monarch is the only human and the only authority. Agents propose and execute; the Monarch decides anything that is a product decision, irreversible, costly beyond the configured limits or a merge.
- **Clean projects.** A target repository receives only branches and pull requests. The Realm holds everything else.
- **Durable records.** Every order, plan, decision, pull request and failure is recorded on GitHub (issues, labels, comments, pull requests). A workflow run can die at any point without losing the order.
- **Exact versus judgment.** Deterministic scripts own state transitions, git, GitHub API calls, parsing, limits and retries. Agents own planning, code, review and testing. Neither does the other's job.
- **Honest outcomes.** The Monarch sees what happened, including failures and unverified work, with links to evidence. Silence means nothing changed; it never hides a failure.
- **Flat command.** At most one planning layer (the Marshal) sits between the Monarch and the agents doing the work.
- **Bounded cost.** Every agent run and every order has explicit limits.

## 2. Repositories

Agreed November 8, 2026.

- **Engine repository** (`shadowarmy`, public): reusable workflows, TypeScript scripts, role prompts, the Realm skeleton in `template/` and the CLI. Released with semantic version tags and a moving major tag (`v1`).
- **Realm** (one per Monarch, private by default): created by `npx shadowarmy init` from `template/`. It holds:
  - `.github/workflows/*.yml`: thin callers that declare triggers and call the engine's reusable workflows at a pinned major version with `secrets: inherit`.
  - `.github/ISSUE_TEMPLATE/`: the Order and New project forms.
  - `shadowarmy.yml`: configuration ([configuration](configuration.md)).
  - `rules/company.md`: the Monarch's standing engineering rules, given to every agent.
  - `projects/<owner>__<repo>.md`: optional per-project notes (stack, commands, conventions), given to agents working on that project. Agents may propose updates to these notes; the update is a pull request in the Realm, never a direct commit.
- **Target repository:** any repository the Monarch's GitHub credential can write to. It holds no shadowarmy files. Branch protection on its default branch is recommended and the `protect` CLI command offers to set it.
- A Realm must not be its own target. The engine refuses an order whose target equals the Realm.

## 3. Orders And Tasks

Agreed November 8, 2026.

- An **order** is a Realm issue created from the Order form (target repository and task text) or the New project form (idea text and optional repository name).
- A **task** is one unit of work that one Soldier completes with one pull request in one target repository.
- A **single-task order** is its own task; the order issue tracks it directly.
- A **multi-task order** gets a plan from the Marshal. After approval, each task becomes a child issue in the Realm labelled `task` and linked to the order (GitHub sub-issues when available, otherwise a "Part of #N" line and a task list in the order).
- In the first milestone every order is single-task; the Marshal arrives in milestone 4. From then on the Marshal decides whether an order is single-task or multi-task, except that a New project order is always planned.
- An order or task targets exactly one repository. Cross-repository work is split into one task per repository.

## 4. Lifecycle And Labels

Agreed November 8, 2026. Library implemented in milestone 0, not yet used by a workflow: the label set, the transition table and the single-state label writer are `src/labels.ts`, covered by `tests/labels.test.ts` (which also checks the table below against the code).

Labels are the source of truth for state. Exactly one state label is present on an order or task at any time; the engine's label writer enforces this by removing every other state label in the same API call that adds the new one.

| Label | Kind | Meaning |
| --- | --- | --- |
| `arise` | trigger | Added by the Monarch to start an order. The engine removes it immediately and sets a state. |
| `queued` | state | Waiting for capacity (concurrency or daily cap). |
| `planning` | state | The Marshal is writing a plan. |
| `in-progress` | state | A Soldier is working. |
| `in-review` | state | The Knight is reviewing, or a fix round is running. |
| `waiting-ci` | state | The pull request is waiting for the target repository's CI beyond the in-job wait. |
| `needs-decision` | state | The army needs the Monarch: a plan to approve, a question to answer or a limit reached. The status comment says exactly what. |
| `ready-to-merge` | state | Pull request open, Knight approved, CI green or absent. Waiting for the Monarch to merge. |
| `done` | state | All pull requests merged. Issue closed as completed. |
| `failed` | state | Stopped after an error or after limits ran out. Status comment links the failed run. `/retry` is allowed. |
| `dismissed` | state | Stopped by the Monarch. Issue closed as not planned. |
| `order`, `task`, `new-project` | kind | What the issue is. |

Transitions:

```text
arise -> queued | planning | in-progress
queued -> planning | in-progress
planning -> needs-decision (plan posted) | failed
needs-decision -> planning (after /answer to a Marshal question) | in-progress | queued (after /approve or /answer) | dismissed
in-progress -> in-review | needs-decision (Soldier blocked) | failed
in-review -> in-progress (fix round) | waiting-ci | ready-to-merge | needs-decision (fix rounds used up) | failed
waiting-ci -> in-review (CI failed, fix round) | ready-to-merge | needs-decision (CI wait limit)
ready-to-merge -> done (merged) | in-review (Monarch requested changes on the PR) | dismissed (PR closed unmerged)
failed -> queued | in-progress (after /retry)
any non-final state -> failed (a step failed, section 11)
any non-final state -> dismissed (after /dismiss)
```

"Any non-final state" includes a fresh order that only carries `arise`; `done` and `dismissed` are final. Moving to the state an issue already has is not a transition: the writer only removes a leftover `arise`. An issue that somehow carries two state labels can only be repaired by moving it to `failed` or `dismissed`.

A multi-task order's own state is derived by the Sentinel from its tasks: `in-progress` while any task is active, `needs-decision` while any task needs the Monarch, `ready-to-merge` when all open tasks are ready, `done` when all tasks are done, `failed` only when a task failed and nothing else is active.

## 5. The Status Comment

Agreed November 8, 2026. Library implemented in milestone 0, not yet used by a workflow: rendering, parsing and the state block schema are `src/statusComment.ts` and `src/schemas/state.ts`, covered by `tests/statusComment.test.ts`. Finding the comment and checking its author arrive with the first workflow (milestone 1).

- Each order and task has exactly one status comment, written by the engine and edited in place. It starts with `<!-- shadowarmy:status -->`.
- It ends with a machine block `<!-- shadowarmy:state {JSON} -->`. The JSON is validated against a schema on every read; an unreadable block is reported as `failed` with the reason, never guessed.
- State JSON fields (version 1), all required, `null` where not applicable: `version` (1), `kind` (`order`, `task`, `new-project`), `target` (`owner/repo`; null for a New project before its repository exists), `base` (branch; null means the default branch), `branch` (`shadowarmy/<issue>-<slug>`), `pr` (number), `round` (fix rounds used), `runs` (list of `{role, runId, conclusion}`; `conclusion` is a GitHub run conclusion or null while running), `ciWaitStartedAt` (ISO 8601 UTC with `Z`), `lastError` (at most 4000 characters), `parent` (order issue of a task), `dependsOn` (task issue numbers). Unknown fields are rejected.
- The state block is one line, the last line of the comment. `<`, `>` and `&` inside it are written as JSON `\u` escapes so no value can end the HTML comment early.
- Text in the human-readable part that may come from issues or agents is escaped: HTML special characters become entities, newlines in one-line fields collapse to spaces, `@mentions` are broken with a zero-width space, and long text is truncated. Links must be `https` URLs.
- Human-readable part: current state in one sentence, pull request link, what the army is doing or waiting for, and for `needs-decision` the exact question or approval needed and how to answer.
- Agents never write the status comment. They return result files; scripts render them.

## 6. Monarch Authority And Commands

Agreed November 8, 2026.

- The Monarch is the login in `monarch:` in `shadowarmy.yml`, defaulting to the Realm owner. Triggers and commands from any other account are ignored and logged in the run summary, never acted on.
- Labels: adding `arise` starts an order. Only label events whose `sender` is the Monarch count.
- Comment commands on an order or task issue, one per comment, at the start of a line:
  - `/approve`: approve the posted plan (or the pending repository creation for a New project).
  - `/answer <text>`: answer the question in `needs-decision`. The text is passed to the next agent run as Monarch input.
  - `/retry`: restart a `failed` order or task from its last safe point (see section 11).
  - `/dismiss`: stop the order or task. Running jobs are cancelled; branches and pull requests are left as they are and listed in the status comment for the Monarch to close.
  - `/status`: re-render the status comment from current GitHub state.
- Plan approval policy (`approval.plan`): `always`, `multi-task` (default) or `never`. New project orders always require approval.
- Merging is never automated. The engine has no code path that merges a pull request in a target repository. Auto-merge is out of scope.
- A pull request review by the Monarch requesting changes, or a Monarch comment on the pull request starting with `/fix`, starts a fix round with that feedback as input (milestone 3).

## 7. Clean Project Rule

Agreed November 8, 2026.

- The diff guard runs before every push. It rejects the push and fails the task when the diff adds or modifies any of: `.shadowarmy/`, `.github/workflows/` (unless the order text explicitly asks for CI changes), `CLAUDE.md`, `AGENTS.md`, `.claude/`, files containing the status or state markers, or any file over the configured size limit (default 5 MB).
- Exception: the order text explicitly asks to create or edit one of those paths, and the Marshal's plan or the order names the path. The exception is recorded in the status comment.
- Agents write their outputs (result files, plans, reviews) under `$RUNNER_TEMP/shadowarmy/`, outside the checkout.
- Branch names in target repositories: `shadowarmy/<realm-issue-number>-<slug>`. The engine only ever pushes to branches with this prefix and never to a default or protected branch.
- Commits use the identity in `git.author` (default `shadowarmy <shadowarmy@users.noreply.github.com>`). No AI co-author trailers. Commit messages describe the change, not the tool.
- Pull request bodies are plain: summary, how it was verified, known limitations, and one line `Ordered from a shadowarmy Realm (issue #N).` The Realm link appears only if the target repository is private or the Monarch enables `pr.link_realm`.

## 8. Soldier Runs

Agreed November 8, 2026. See [roles](roles.md#soldier) for the prompt contract.

- One Soldier run implements one task in a fresh checkout of the target repository at the head of its default branch (or the existing task branch on fix rounds).
- The checkout uses `persist-credentials: false`. The agent step's environment contains only its Claude credential, the task files and the toolchain. It has no GitHub token.
- Inputs: company rules, project notes, the task text, Monarch answers, and on fix rounds the Knight's findings, CI failure excerpts and Monarch change requests.
- The Soldier must reproduce a bug before fixing it when the task is a bug fix, and must run the project's existing checks (tests, lint, build) that it can discover. It records what it ran and the results.
- Output: `result.json` with `status` (`done`, `blocked`, `failed`), `title`, `summary`, `verification` (commands and outcomes), `limitations`, and for `blocked` a `question`.
- `done` with no file changes is treated as `failed` ("no changes produced"). `blocked` moves to `needs-decision` with the question.
- Limits: `limits.max_turns` per run and `limits.run_timeout_minutes` per job.

## 9. Knight Review And Fix Rounds

Agreed November 8, 2026.

- Every pull request is reviewed by a Knight before it can reach `ready-to-merge`. The Knight runs in a separate agent session that never saw the Soldier's conversation.
- Inputs: order and task text, company rules, project notes, the full diff, the Soldier's `result.json`, CI results when available.
- Output: `review.json` with `verdict` (`approve`, `changes`), `findings` (severity `blocker`, `major`, `minor`; file; line; problem; suggested fix) and `scope` (`ok` or a note when the diff does more or less than asked).
- `changes` starts a fix round: a new Soldier run on the same branch with the findings. Only `blocker` and `major` findings require a fix round; `minor` findings are listed in the pull request body.
- The Knight posts its review as a pull request review in the target repository (comment type, never "approve" in GitHub's sense, so it never satisfies branch protection on its own).
- Fix rounds are limited by `limits.max_fix_rounds` (default 3). When they run out, the task moves to `needs-decision` with the remaining findings.

## 10. Target Repository CI

Agreed November 8, 2026.

- After each push, the engine waits for the pull request's checks inside the job for up to `ci.wait_minutes_in_job` (default 15).
- Still pending: the task moves to `waiting-ci` and the job ends. The Sentinel checks again on each patrol until `ci.max_wait_minutes` (default 120), then moves to `needs-decision`.
- Failing required checks start a fix round with the failing check names and a log excerpt (last `ci.log_excerpt_lines` lines, default 200, secrets masked by GitHub).
- A target repository without CI is allowed. The status comment states "no CI in target repository; verification is the Soldier's and Scout's reported checks only".

## 11. Failure, Retry And Recovery

Agreed November 8, 2026.

- Any step failure moves the task to `failed` with the step name, a short reason and the run link. Agent output that does not parse is a failure, not a guess.
- `/retry` restarts from the last safe point recorded in the state block: if a branch and pull request exist, it starts a fix round with the previous failure as input; otherwise it starts a fresh Soldier run.
- Workflow concurrency group per issue (`shadowarmy-<issue>`), `cancel-in-progress: false`, so two events for one order never run in parallel.
- The Sentinel treats a task as stuck when its state is `in-progress` or `in-review` and no run for its concurrency group is queued or running. It retries once automatically (recorded in the status comment) and then marks it `failed`.
- A run cancelled by `/dismiss` is not a failure.

## 12. Marshal Planning And Team Size

Agreed November 8, 2026. Arrives in milestone 4.

- The Marshal reads the order, company rules, project notes and a read-only checkout of the target repository, and writes `plan.json` plus a human-readable plan.
- `plan.json`: `summary`, `tasks` (each with `id`, `title`, `description`, `acceptance` criteria, `dependsOn` list, `estimate` in `small`, `medium`, `large`), `risks`, `questions`.
- If the plan has questions, the order moves to `needs-decision` and the Marshal reruns with the answers.
- Team size is the number of tasks whose dependencies are satisfied, capped by `limits.max_concurrent_soldiers` (default 3). Tasks with unmet dependencies wait in `queued`; the Sentinel or the completion of a dependency dispatches them.
- A dependency is satisfied when the dependency's pull request is merged, not merely ready.
- The Marshal never writes code and never opens pull requests.

## 13. Scout Testing

Agreed November 8, 2026. Arrives in milestone 6.

- The Scout runs after the Knight approves and before `ready-to-merge`, when `roles.scout` is enabled.
- It builds and runs the project from the pull request branch, exercises the changed behavior end to end (CLI commands, HTTP requests, or a headless browser for web apps) and writes `scout.json` with `verdict` (`pass`, `fail`), the steps it ran, evidence (outputs, screenshots uploaded as workflow artifacts) and bugs found.
- `fail` starts a fix round with the Scout's bugs. Scout rounds count toward `limits.max_fix_rounds`.

## 14. Sentinel Patrol

Agreed November 8, 2026. Arrives in milestone 3.

- Scheduled every `sentinel.interval_minutes` (default 15; GitHub's minimum is 5) and runnable on demand (`workflow_dispatch`).
- Each patrol, in order: reconcile pull requests (merged makes the task `done`, closed unmerged makes it `dismissed`, new Monarch change requests start fix rounds); resume `waiting-ci`; detect stuck tasks (section 11); dispatch `queued` tasks within capacity and the daily cap; derive multi-task order states; update the Realm report.
- The **Realm report** is one pinned Realm issue titled "Realm report", edited in place: active orders, items needing the Monarch (with links), ready pull requests, failures, runs used today against the cap.
- The Sentinel itself uses no agent. It is entirely deterministic.
- Missed or delayed ticks must be harmless: every patrol step is idempotent and reads current GitHub state.

## 15. New Project Orders

Agreed November 8, 2026. Arrives in milestone 5.

- The Marshal proposes a repository name, visibility, language and stack, a first-version scope and a plan.
- After `/approve`, a deterministic step creates the repository with a README-only initial commit (so later work arrives as pull requests), sets branch protection when possible, and registers a project notes file in the Realm through a Realm pull request.
- Creation needs a credential that can create repositories; if the configured credential cannot, the order moves to `needs-decision` asking the Monarch to create an empty repository and reply `/answer owner/name`.

## 16. Limits And Cost

Agreed November 8, 2026.

- Required limits with defaults: `max_turns` 150, `run_timeout_minutes` 45, `max_fix_rounds` 3, `max_concurrent_soldiers` 3, `max_runs_per_day` 30, `ci.max_wait_minutes` 120.
- A run is any workflow job that starts an agent. The daily count resets at 00:00 in `timezone` (default UTC).
- Reaching the daily cap moves new work to `queued` and reports it in the Realm report. Work in progress continues to its next safe point.
- Limits can only be raised by editing `shadowarmy.yml` in the Realm; no command raises them.

## 17. Out Of Scope

Agreed November 8, 2026.

- Automatic merging, deployments to production, payments, domain purchases and app store releases.
- A hosted shadowarmy service or GitHub App operated by the project.
- Non-GitHub forges.
- Agents other than Claude Code (may be revisited).
- The departments in [company vision](company-vision.md).

## Regression Requirements

When implemented, each of these needs an automated test (unit or end-to-end) named in this section:

- Commands and `arise` from a non-Monarch account change nothing.
- Exactly one state label after every transition, including concurrent events. Unit: `tests/labels.test.ts` ("leaves exactly one state label after every allowed transition", "keeps one state label when two events race on the same issue"). End to end: pending (milestone 1).
- The diff guard rejects every forbidden path and accepts an explicit, recorded exception.
- The agent step's environment contains no GitHub token, and the checkout has no persisted credentials.
- Issue text containing shell metacharacters and `${{ }}` sequences never executes. Unit: `tests/issueForm.test.ts` ("keeps shell metacharacters, expressions and fake markers as inert data"); workflow lint: `scripts/check-workflow-expressions.ts` fails CI on any `${{ }}` inside a `run:` script (`tests/workflowExpressions.test.ts`). End to end: pending (milestone 1).
- An unparsable agent result file produces `failed`, not `done`.
- `/retry` after a failure with an existing pull request reuses the branch.
- Fix rounds stop at the limit and produce `needs-decision`.
- The Sentinel turns a merged pull request into `done` and a closed one into `dismissed`.
- No engine code path merges a target pull request.
