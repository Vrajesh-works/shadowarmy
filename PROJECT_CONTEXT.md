# shadowarmy Project Context

This file is the high-level context companion for planning and implementation work.

Maintenance note: whenever the architecture, an order's lifecycle, a label, a comment format or a role's contract changes, update the matching file in `functional-diagrams/` and `docs/` in the same change.

## Documentation Map

- [Behavior contract](docs/behavior-contract.md): agreed rules
- [Roles](docs/roles.md): each agent's contract
- [Configuration](docs/configuration.md): Realm config, secrets, labels, issue forms
- [Security](docs/security.md): threat model
- [Roadmap](docs/roadmap.md): milestones and acceptance criteria
- [Decisions](docs/decisions.md): dated decision log
- [Functional diagrams](functional-diagrams/README.md): architecture and per-action sequences
- [Development guide](DEVELOPMENT.md) and [contributing guide](CONTRIBUTING.md)

## Current Context Summary

shadowarmy is in early build (November 8, 2026). Milestone 0 is in place: a Node 22 TypeScript project with the `shadowarmy.yml` schema, the issue form parser, the label transition table and writer, the status comment renderer and parser, unit tests and engine CI. No workflow runs an order yet. The agreed design:

- **Product:** an AI software team with exactly one human, the Monarch. The Monarch writes orders as GitHub issues; agents plan, implement, review and test the work and deliver it as pull requests in the Monarch's project repositories.
- **Two kinds of repository:**
  - The **engine** (this repository, public): reusable GitHub Actions workflows, TypeScript scripts, role prompts, the Realm skeleton and the `init` CLI.
  - A **Realm** (one per user, private): created by `npx shadowarmy init`. It holds thin workflow files that call the engine's reusable workflows at a pinned version, the configuration `shadowarmy.yml`, the Monarch's standing rules, per-project notes and the order board (issues).
- **Target repositories** (the user's projects) receive only branches and pull requests. They contain no shadowarmy files.
- **Runtime:** GitHub Actions on `ubuntu-latest`. Agents are Claude Code running headless (`claude -p`). Deterministic steps are Node 22 TypeScript scripts.
- **Credentials:** the user's own Claude credential (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or `ANTHROPIC_API_KEY`) and a GitHub credential that can write to the chosen target repositories (a fine-grained personal access token first, a GitHub App later).
- **State:** labels on Realm issues are the order state. One sticky status comment per order carries structured details in a hidden marker. Nothing is stored outside GitHub.
- **Supervision:** event-driven inside a workflow run (Soldier, Knight and fix rounds run as one pipeline), plus the Sentinel, a scheduled workflow that handles everything that happens outside a run: merged or closed pull requests, stuck work, CI that takes too long, dispatching queued tasks and the status report.

## Components (planned)

| Component | Kind | Purpose |
| --- | --- | --- |
| `order.yml` | Reusable workflow | Runs one order or task: parse, Soldier, push, PR, Knight, fix rounds, CI wait, report |
| `plan.yml` | Reusable workflow | Runs the Marshal for multi-task orders and new projects; posts the plan |
| `command.yml` | Reusable workflow | Handles Monarch slash commands in comments (`/approve`, `/retry`, `/dismiss`, `/answer`) |
| `sentinel.yml` | Reusable workflow | Scheduled patrol and dispatcher |
| `src/` | TypeScript | Parsing, state, labels, git, PR, diff guard, limits, report rendering |
| `roles/` | Markdown prompts | Marshal, Soldier, Knight, Scout instructions |
| `template/` | Realm skeleton | Thin caller workflows, issue forms, default config and rules |
| `src/cli/` | CLI | `init`, `doctor`, `protect` |

## External Dependencies

- GitHub Actions (runners, schedules, concurrency, reusable workflows) and the GitHub REST and GraphQL APIs through `gh` and Octokit.
- Claude Code CLI (`@anthropic-ai/claude-code`), run headless.
- Optional per project: whatever toolchain the target repository needs (Node, Python, Go). The Soldier and Scout install it inside the run.

## Open Questions And Risks

These need a spike or a decision before or during the milestone that depends on them:

- **Repository creation for new projects.** Confirm whether a fine-grained personal access token can create repositories on a personal account and with which permission. A GitHub App installation token cannot create repositories on a personal account. Fallback: the Monarch creates an empty repository and the order targets it. (Milestone 5.)
- **Reusable workflow source.** Confirm how a called reusable workflow checks out the engine's scripts at the same version it was called with. Current plan: an `engine_ref` input that defaults to the pinned tag. (Milestone 1.)
- **Claude credential terms.** Confirm that the chosen credential type is permitted for unattended CI use on the user's own repositories and document both options. (Milestone 1.)
- **Scheduled workflow reliability.** GitHub may delay scheduled runs under load, and disables schedules in public repositories after 60 days without activity. The Sentinel must tolerate missed ticks. (Milestone 3.)
- **Actions minutes.** Waiting for target CI inside a job spends minutes. Long waits must hand off to the Sentinel. (Milestone 2.)
- **Parallel merge conflicts.** Parallel Soldiers on overlapping code create conflicts. The Marshal's task split and a rebase-and-retry path must keep this rare. (Milestone 4.)
- **Prompt injection from target repositories.** Repository files and CI logs are untrusted. See [security](docs/security.md).

## Parked Ideas

The wider "AI company" vision (product, design, DevOps, docs, launch and support departments) is recorded in [company vision](docs/company-vision.md). It is not part of the current scope.
