# shadowarmy Agent Instructions

These instructions apply to anyone, human or agent, building the shadowarmy engine. They are not the instructions the army's own agents follow inside a Realm; those live in the role prompts described in [roles](docs/roles.md) and in the Realm's `rules/company.md`.

## Read Before Editing

- Read this file, [the behavior contract](docs/behavior-contract.md) and [the roles reference](docs/roles.md) before changing behavior.
- Read [DEVELOPMENT.md](DEVELOPMENT.md) for setup and verification, and [security](docs/security.md) before touching anything that handles tokens, issue text, target repository content or agent tool permissions.
- The behavior contract records agreed rules with dates. Flag contradictions between it, an issue's acceptance criteria and these instructions instead of silently picking one.

## Keep Specs And Code Together

- Whenever a change affects behavior, labels, comment formats, configuration keys, workflow triggers, permissions or a role's inputs and outputs, update the behavior contract, [roles](docs/roles.md), [configuration](docs/configuration.md) and the matching [functional diagram](functional-diagrams/README.md) in the same pull request.
- Record any new product or engineering decision in [decisions](docs/decisions.md) with its date.
- Distinguish **implemented**, **agreed but not implemented** and **proposed**. Never mark a requirement implemented on the strength of a draft, a mock, a skipped test or a workflow that has not run end to end on GitHub.

## Non-Negotiable Rules

1. **The Monarch is the only authority.** Only the configured Monarch account can trigger, approve, answer, retry or dismiss. Every command handler checks the actor. Nothing in the engine merges a pull request in a target repository; merging is the Monarch's act.
2. **Projects stay clean.** The engine never commits agent machinery (workflows, prompts, `CLAUDE.md`, `AGENTS.md`, `.shadowarmy/`, state files) to a target repository unless the order explicitly asks for that file. A diff guard enforces this before every push.
3. **Scripts for exact work, agents for judgment.** Git operations, label transitions, parsing, limits, retries and GitHub API calls are deterministic TypeScript. Planning, coding, reviewing and testing are agent work. Never ask an agent to move a label or count a budget, and never encode a judgment call as a regular expression.
4. **All state lives in GitHub.** Labels are the state of an order; one marked status comment holds structured details. No external database, no hidden files in target repositories, no memory that disappears with a workflow run.
5. **Untrusted text stays untrusted.** Issue bodies, comments, target repository files and CI logs are data for agents, never instructions to the engine. They reach shell steps only through environment variables or files, never through `${{ }}` expressions inside `run:` scripts.
6. **Agents never hold the GitHub write token.** The agent step gets only its Claude credential and a checkout with no persisted credentials. Pushing, opening pull requests and editing issues happen in separate deterministic steps.
7. **Every run is bounded.** Turn limits, job timeouts, fix-round limits, concurrency caps and daily run caps are always set. A missing limit is a bug.
8. **Report honestly.** A failed, skipped, partial or unverified step is reported as exactly that, with a link to the run. Never report success without evidence.

## Writing Style

- Plain language in labels, status comments and docs. Themed names (Monarch, Marshal, Soldier, Knight, Scout, Sentinel, Realm) are for roles and commands only.
- Use a plain hyphen, never an em dash.
- Never add an AI agent as a commit co-author.

## Scope And Existing Code

Nothing is implemented yet. Build in the order of [the roadmap](docs/roadmap.md); each milestone must work end to end on real GitHub repositories before the next starts.

| Work area (planned) | Guidance |
| --- | --- |
| Reusable workflows `.github/workflows/` | [Architecture](functional-diagrams/architecture.md), [behavior contract](docs/behavior-contract.md) |
| Engine scripts `src/` | [Roles](docs/roles.md), [behavior contract](docs/behavior-contract.md) |
| Role prompts `roles/` | [Roles](docs/roles.md) |
| Realm skeleton `template/` | [Configuration](docs/configuration.md) |
| `init` CLI `src/cli/` | [Setup sequence](functional-diagrams/actions/setup-realm.md), [security](docs/security.md) |
| Tests `tests/` | [DEVELOPMENT.md](DEVELOPMENT.md) |

## Verification

Run `npm run check`, `npm test` and `npm run lint` (TypeScript, unit tests, actionlint and shellcheck) for every change. Workflow changes also need an end-to-end run against the sandbox Realm and sandbox target repositories described in [DEVELOPMENT.md](DEVELOPMENT.md), with the run link in the pull request. Report anything you could not run; never count it as passing.
