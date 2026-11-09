# Development

Status: planned setup for when code exists (November 8, 2026). Update this file as soon as the first code lands.

## Prerequisites

- Node 22 and npm
- GitHub CLI (`gh`), authenticated
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`), signed in
- `actionlint` and `shellcheck` on PATH (for `npm run lint`)
- Two GitHub accounts for permission tests: the Monarch account and a second "outsider" account

## Commands

```sh
npm ci
npm run check     # TypeScript, no emit
npm test          # node:test unit tests
npm run lint      # eslint + actionlint + shellcheck
npm run build     # compile src/ to dist/ (used by workflows and the CLI)
```

## Sandbox Repositories

Workflows can only be proven on GitHub. Keep three repositories on the Monarch account for end-to-end testing:

| Repository | Visibility | Purpose |
| --- | --- | --- |
| `shadowarmy-sandbox-realm` | private | A Realm whose caller workflows point at your engine branch (`uses: <you>/shadowarmy/.github/workflows/order.yml@<branch>`) |
| `shadowarmy-sandbox-node` | private | Small Node project with tests and a CI workflow, including one test you can switch to failing on purpose (to exercise CI fix rounds) |
| `shadowarmy-sandbox-empty` | private | Repository with only a README, for "no CI" and New project paths |

Rules for sandbox runs:

- Use synthetic code and data only. Never point a sandbox Realm at a real project while developing the engine.
- Use a dedicated Claude credential and a fine-grained GitHub token limited to the sandbox targets. Revoke them if they are ever printed.
- Set low limits in the sandbox `shadowarmy.yml` (`max_turns: 40`, `max_runs_per_day: 10`).

## Manual Realm Setup (Until `init` Exists)

1. Create the private sandbox Realm repository.
2. Copy `template/` into it and edit `shadowarmy.yml` (`monarch`, `targets`).
3. Point the caller workflows at your engine branch.
4. Create the labels listed in [configuration](docs/configuration.md#labels) (`gh label create ... --repo`).
5. Add secrets: `gh secret set SHADOWARMY_GH_TOKEN --repo <realm>` and `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <realm>` (or `ANTHROPIC_API_KEY`).
6. Open an Order issue targeting `shadowarmy-sandbox-node` and add `arise`.

## Testing Strategy

| Layer | How | Covers |
| --- | --- | --- |
| Unit | `node:test` with fixtures in `tests/fixtures/` | Config validation, issue form parsing, label transitions, state block, diff guard, limits, command parsing, report rendering |
| Contract | JSON Schema tests with valid and invalid agent outputs | Every role output schema |
| Workflow lint | actionlint, plus a check that no `run:` step contains `${{ github.event` | Script injection safety |
| End to end | Real runs on the sandbox Realm, recorded in the PR | Every acceptance criterion in [the roadmap](docs/roadmap.md) |

Agents are not mocked in end-to-end tests. For unit tests of the orchestration around agents, a fake agent script writes canned output files, selected by an environment variable that only test workflows set.

## Debugging A Run

- The status comment links every run. Open the run, then the `work` job.
- Agent transcripts are uploaded as a run artifact (`agent-<role>-<round>`) with secrets masked. Download with `gh run download <run-id> --repo <realm>`.
- Re-run a single order with `/retry` instead of re-running the workflow from the Actions UI, so the state block stays consistent.
- `npx shadowarmy doctor` checks secrets, labels, config and token access.

## Releasing

- Merge to `main` with green CI and at least one recorded end-to-end run for workflow changes.
- Tag `vX.Y.Z` and move the major tag (`v1`). Realms pinned to `@v1` pick it up on their next run.
- Publish the CLI to npm from the same tag.
- Breaking changes to labels, the state block or `shadowarmy.yml` require a new major version and a migration note.
