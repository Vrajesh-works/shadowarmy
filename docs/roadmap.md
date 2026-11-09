# Roadmap

Updated November 8, 2026. Each milestone is done only when its acceptance criteria pass end to end on real GitHub repositories (the sandbox Realm and sandbox targets in [DEVELOPMENT.md](../DEVELOPMENT.md)), with run links recorded in the milestone's pull request. Do not start a milestone before the previous one is done.

## Milestone 0: Repository Foundation

Goal: an engine repository a contributor can build and test.

Status: implemented; done once the engine CI run for its pull request is green on GitHub (run link recorded in that pull request).

- TypeScript project (Node 22), `npm run check`, `npm test` (node:test), `npm run lint` (eslint, actionlint, shellcheck).
- `src/config.ts` with the `shadowarmy.yml` schema and defaults; `src/issueForm.ts` parser; `src/labels.ts` single-state label writer; `src/statusComment.ts` render and parse with the state block schema.
- Engine CI workflow running the checks on pull requests.

Acceptance:
- Unit tests cover config validation errors, issue form parsing (including `_No response_`, extra whitespace and malicious content), the label transition table and state block round trips.

## Milestone 1: First Order (Soldier Only)

Goal: an order in a Realm becomes a pull request in a clean target repository.

- Reusable `order.yml`: actor check, parse order, set `in-progress`, check out target without persisted credentials, run the Soldier, validate `result.json`, diff guard, commit, push `shadowarmy/*` branch, open pull request, set `ready-to-merge`, render status comment. Failures set `failed` with the run link.
- Realm `template/` with the caller workflow, Order form, default config and `rules/company.md`.
- Manual Realm setup documented (no CLI yet).
- Spikes resolved and recorded in [decisions](decisions.md): Claude Code headless flags, credential option, engine checkout ref inside a reusable workflow.

Status: done (spikes are decisions 20-22). Acceptance runs on the sandbox Realm (private; links work for its owner), November 9, 2026:

- Monarch `arise` produces a pull request in a clean target with the requested change: [run](https://github.com/Vrajesh-works/shadowarmy-sandbox-realm/actions/runs/42652430753), [pull request](https://github.com/Vrajesh-works/shadowarmy-sandbox-node/pull/2) (real Soldier; only `src/greet.js` and `test/greet.test.js` changed; target CI green).
- `arise` from a second account does nothing: [run](https://github.com/Vrajesh-works/shadowarmy-sandbox-realm/actions/runs/42658276654) (added by VNasit; the gate logged "not the Monarch" and changed nothing).
- An impossible order ends in `failed` with a readable reason: [run](https://github.com/Vrajesh-works/shadowarmy-sandbox-realm/actions/runs/42652908633) (real Soldier explained that the target has no checkout service).
- An unrequested `CLAUDE.md` edit is rejected by the diff guard: [run](https://github.com/Vrajesh-works/shadowarmy-sandbox-realm/actions/runs/42652193294) (fake agent scenario `edit-claude-md`; nothing pushed).
- Also run: pipeline smoke test [run](https://github.com/Vrajesh-works/shadowarmy-sandbox-realm/actions/runs/42651942297), and an injection-laden order with an unparsable result [run](https://github.com/Vrajesh-works/shadowarmy-sandbox-realm/actions/runs/42659729393).

Acceptance:
- Monarch adds `arise` to an order on the sandbox Realm; a pull request appears in the sandbox target with the requested change; the target repository contains no shadowarmy files.
- `arise` added by a second account does nothing.
- An order whose task cannot be done ends in `failed` with a readable reason.
- An order whose Soldier edits `CLAUDE.md` without being asked is rejected by the diff guard.

## Milestone 2: Knight, Fix Rounds And Target CI

Goal: no pull request reaches the Monarch without an independent review and green CI.

- Knight run after each push; review posted to the pull request.
- Fix rounds with the Knight's blocker and major findings; round limit; `needs-decision` when exhausted.
- CI wait in job; `waiting-ci` hand-off (Sentinel picks it up in milestone 3, so until then the run waits up to `ci.max_wait_minutes` in job).
- Fix rounds from failing CI with log excerpts.

Status: implemented (decisions 30-37); done once the acceptance runs below are recorded on the sandbox Realm in the milestone's pull request.

Acceptance:
- A seeded order that produces a known bug gets a Knight finding and is fixed in a later round.
- A target with a failing test reaches `ready-to-merge` only after a fix round makes it pass.
- Round limit reached produces `needs-decision` with remaining findings.

## Milestone 3: Commands And Sentinel

Goal: the Monarch can steer, and work never silently stalls.

- `command.yml`: `/answer`, `/retry`, `/dismiss`, `/status`, `/fix` with actor checks.
- `sentinel.yml`: reconcile merged and closed pull requests, resume `waiting-ci`, stuck detection with one automatic retry, daily cap, Realm report issue.
- Monarch change requests on a pull request start fix rounds.

Acceptance:
- Merging the pull request marks the order `done` and closes the issue within one patrol.
- Killing a run mid-Soldier leads to one automatic retry, then `failed` if it dies again.
- `/dismiss` cancels a running order and lists the branch and pull request left behind.
- The Realm report shows correct counts after a mixed set of orders.

## Milestone 4: Marshal And Parallel Soldiers

Goal: the team grows with the work.

- `plan.yml`: Marshal run, `plan.json` validation, plan rendering, `needs-decision` for approval and questions.
- `/approve` creates task issues and dispatches tasks within `max_concurrent_soldiers` and dependencies.
- Multi-task order state derived by the Sentinel.
- Rebase-and-retry when a task branch conflicts after a sibling merges.

Acceptance:
- An order split into three independent tasks runs three Soldiers in parallel and produces three pull requests.
- A dependent task starts only after its dependency's pull request merges.
- With `max_concurrent_soldiers: 2`, the third task waits in `queued` and starts when a slot frees.

## Milestone 5: Setup CLI And New Projects

Goal: anyone can install shadowarmy in minutes and start a project from an idea.

- `npx shadowarmy init`: checks `gh` auth, creates the private Realm from `template/`, creates labels, guides creation of the GitHub token and Claude credential and stores them as Realm secrets, runs `doctor`.
- `npx shadowarmy doctor [--fix]`: verifies secrets exist, labels, config validity, token access to each target.
- `npx shadowarmy protect owner/repo`: offers branch protection for a target.
- New project order flow, with the repository-creation spike resolved.
- Published to npm; engine `v1` tag.

Acceptance:
- A fresh GitHub account goes from nothing to a merged first pull request by following the README only.
- A New project order produces a new repository with a README-only first commit and the first feature as a pull request.

## Milestone 6: Scout

Goal: changes are verified in running software, not just by tests.

- Scout run with toolchain detection, headless browser support and evidence artifacts.
- Scout failures start fix rounds.

Acceptance:
- A web app order where unit tests pass but the page is broken is caught by the Scout.

## Later

- GitHub App credentials created from a manifest during `init`.
- The [firstmate bridge](firstmate-bridge.md).
- Per-order budget in tokens or dollars when usage data is available.
- Ideas in [company vision](company-vision.md).
