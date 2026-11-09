# Development

Updated November 8, 2026 (milestone 0). The commands below work today; the sandbox and Realm sections apply from milestone 1.

## Prerequisites

- Node 22.18 or later and npm. Tests and dev scripts run TypeScript directly with Node's built-in type stripping, so there is no separate TypeScript runner. CI uses the latest Node 22 (`.nvmrc`).
- GitHub CLI (`gh`), authenticated
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`), signed in
- `actionlint` and `shellcheck` on PATH (for `npm run lint`). CI installs actionlint from a checksum-verified release and uses the shellcheck that ships with the runner; locally, install both from their release pages or your package manager.
- Two GitHub accounts for permission tests: the Monarch account and a second "outsider" account

## Commands

```sh
npm ci
npm run check     # TypeScript type check (src, tests, scripts), no emit
npm test          # node:test unit tests in tests/**/*.test.ts
npm run lint      # eslint + actionlint + no ${{ }} in run: scripts + shellcheck
npm run build     # compile src/ to dist/ (used by workflows and the CLI)
```

`npm run lint` runs, in order: `lint:eslint` (typed `typescript-eslint` strict rules), `lint:workflows` (actionlint, then `scripts/check-workflow-expressions.ts`, which fails on any `${{ }}` inside a `run:` script) and `lint:shell` (shellcheck on every tracked `*.sh`).

The engine CI (`.github/workflows/ci.yml`) runs check, test, lint and build on every pull request and on pushes to `main`.

### Writing Code

- Use only erasable TypeScript syntax (no enums, namespaces or constructor parameter properties) and import local files with their `.ts` extension; `tsc` rewrites them to `.js` in `dist/`.
- JSON Schemas live in `src/schemas/` as TypeScript modules and are compiled with Ajv through `src/schema.ts`, which turns errors into `key.path: reason` lines.
- Tests that compare code with docs (`tests/config.test.ts`, `tests/labels.test.ts`, `tests/statusComment.test.ts`) read the configuration example, the labels table, the transition table and the state block example straight from the markdown. When you change one side, change the other.

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
| Workflow lint | actionlint, plus `scripts/check-workflow-expressions.ts`, which fails on any `${{ }}` expression inside a `run:` script ([decision 16](docs/decisions.md)) | Script injection safety |
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
