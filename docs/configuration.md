# Configuration

Updated November 9, 2026. Status: the `shadowarmy.yml` schema, defaults and validation, the label definitions and the issue form parser are implemented (milestone 0) and used by the order workflow (milestone 1). The Realm skeleton is `template/`; [Realm setup](realm-setup.md) describes the manual setup. Keys and defaults here are the contract for `src/config.ts` and `src/schemas/config.ts`; `tests/config.test.ts` checks that the example below parses to exactly the defaults in code.

## `shadowarmy.yml`

Lives at the root of the Realm. Validated on every run; an invalid file fails the run with the exact key and reason, and nothing else happens.

```yaml
version: 1

# The only human authority. Defaults to the Realm owner.
monarch: your-github-login

# Repositories the army may work on. Orders for anything else are refused.
# Use "owner/*" to allow every repository of an owner.
targets:
  - your-github-login/*

approval:
  plan: multi-task          # always | multi-task | never (New project orders always need approval)

limits:
  max_turns: 150            # per agent run
  run_timeout_minutes: 45   # per job
  max_fix_rounds: 3         # per task, Knight + Scout + CI rounds combined
  max_concurrent_soldiers: 3
  max_runs_per_day: 30
  max_file_size_mb: 5       # diff guard

ci:
  wait_minutes_in_job: 15
  max_wait_minutes: 120
  log_excerpt_lines: 200

sentinel:
  interval_minutes: 15      # also set the cron in .github/workflows/sentinel.yml

roles:
  marshal: { model: opus }
  soldier: { model: sonnet }
  knight:  { model: opus }
  scout:   { enabled: false, model: sonnet }

git:
  author: "shadowarmy <shadowarmy@users.noreply.github.com>"

pr:
  draft: false              # open pull requests as drafts
  link_realm: false         # include a link to the Realm issue in PR bodies

timezone: UTC               # daily cap reset
```

Model names are passed through to Claude Code's `--model`; the defaults must be revisited when new models ship.

### Validation Rules

- Required: `version` (must be `1`) and `targets` (at least one entry, no duplicates). Everything else has a default. A key with an empty value (`max_turns:`) means the default.
- Unknown keys are errors, so typos never silently fall back to a default.
- All problems are reported at once, one line each, as `key.path: reason` (for example `limits.max_turns: must be integer`). Invalid YAML and duplicate keys are reported the same way.
- `monarch` is a GitHub login. `targets` entries are `owner/name` or `owner/*`; matching is case-insensitive, and the Realm itself is never an allowed target even when a wildcard covers it.
- Ranges: `max_turns` 1-1000, `run_timeout_minutes` 1-360 (GitHub's job limit), `max_fix_rounds` 0-20, `max_concurrent_soldiers` 1-20, `max_runs_per_day` 1-1000, `max_file_size_mb` 1-100, `ci.wait_minutes_in_job` 0-359, `ci.max_wait_minutes` 1-10080, `ci.log_excerpt_lines` 1-5000, `sentinel.interval_minutes` 5-1440.
- `ci.wait_minutes_in_job` must be less than `limits.run_timeout_minutes`, and `ci.max_wait_minutes` at least `ci.wait_minutes_in_job`.
- Model names are letters, digits and `. _ : [ ] -`. `git.author` is `Name <email>`. `timezone` is an IANA time zone name.

## Secrets (Realm repository secrets)

| Secret | Required | Purpose |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | one of these two | Claude credential from `claude setup-token` (uses the Monarch's Claude plan) |
| `ANTHROPIC_API_KEY` | one of these two | Pay-per-use Claude API key |
| `SHADOWARMY_GH_TOKEN` | yes | GitHub credential with write access to target repositories |

`SHADOWARMY_GH_TOKEN`, first version: a fine-grained personal access token limited to the chosen target repositories, with:

| Permission | Access | Why |
| --- | --- | --- |
| Contents | Read and write | Push task branches |
| Pull requests | Read and write | Open, update and review pull requests |
| Metadata | Read | Required by GitHub |
| Checks, Commit statuses, Actions | Read | Wait for and read target CI |
| Administration | Read and write | Only if New project orders should create repositories (to be verified) |

Fine-grained tokens expire. The Sentinel warns in the Realm report 7 days before expiry when the expiry is known.

Later version: a GitHub App the Monarch creates from a manifest during `init`, installed on chosen repositories, with tokens minted per run. This removes long-lived tokens but cannot create repositories on a personal account.

The Realm's own `GITHUB_TOKEN` is used for everything inside the Realm (labels, comments, issues). The order caller workflow grants it `contents: read` (read `shadowarmy.yml`, rules and notes), `issues: write` (labels and status comment) and `actions: read` (count today's agent runs for the daily cap). Later workflows that open Realm pull requests add `pull-requests: write`.

## Variables (Realm repository variables)

| Variable | Purpose |
| --- | --- |
| `SHADOWARMY_FAKE_AGENT` | Test Realms only. Replaces the Soldier with a canned scenario from `scripts/fake-agent.sh` (`add-file`, `edit-claude-md`, `no-changes`, `blocked`, `invalid-result`) so the rest of the pipeline can be tested repeatably. Unknown values fail the order. Leave unset in a real Realm. |

## Labels

Created by `init` and re-created by `npx shadowarmy doctor --fix`.

| Label | Color | Description |
| --- | --- | --- |
| `arise` | `5319e7` | Start this order |
| `queued` | `c5def5` | Waiting for capacity |
| `planning` | `bfd4f2` | Marshal is planning |
| `in-progress` | `1d76db` | A Soldier is working |
| `in-review` | `0e8a16` | Knight review or fix round |
| `waiting-ci` | `fbca04` | Waiting for target CI |
| `needs-decision` | `d93f0b` | Needs the Monarch |
| `ready-to-merge` | `0e8a16` | Pull request ready for the Monarch |
| `done` | `cccccc` | Merged |
| `failed` | `b60205` | Stopped; use /retry |
| `dismissed` | `cccccc` | Stopped by the Monarch |
| `order` | `ededed` | Order issue |
| `task` | `ededed` | Task issue |
| `new-project` | `ededed` | New project order |

## Issue Forms

`template/.github/ISSUE_TEMPLATE/order.yml`:

| Field id | Label | Type | Required | Notes |
| --- | --- | --- | --- | --- |
| `target` | Target repository | input | yes | `owner/name`; validated against `targets` |
| `task` | Task | textarea | yes | Plain-language task and what done looks like |
| `base` | Base branch | input | no | Base branch; defaults to the target's default branch |

`template/.github/ISSUE_TEMPLATE/new-project.yml`:

| Field id | Label | Type | Required | Notes |
| --- | --- | --- | --- | --- |
| `idea` | Idea | textarea | yes | What to build and for whom |
| `name` | Repository name | input | no | Preferred repository name |
| `visibility` | Visibility | dropdown | yes | `private` (default) or `public` |

GitHub renders issue form answers as markdown sections (`### Target repository` followed by the value). The labels above are part of the contract: the templates in `template/` must use them exactly, in this order. The parser (`src/issueForm.ts`) reads sections by their labels, trims whitespace, accepts CRLF line endings, treats `_No response_` as empty and validates every value. A body that does not match the form is reported as `failed` with the reason.

- Input and dropdown answers must be a single line. A textarea answer may contain anything, including lines that look like section headings: the real next heading is the last one that still lets the rest of the form parse, so pasted text cannot override a later field.
- `base` must be a safe branch name: git's rules plus a conservative character set (letters, digits, `.`, `_`, `/`, `+`, `-`). `name` must be a valid repository name.
- Bodies over 65536 characters (GitHub's limit) are rejected.

## Caller Workflows In The Realm

Thin files that only declare triggers and permissions. Example `template/.github/workflows/order.yml`:

```yaml
name: shadowarmy order
on:
  issues:
    types: [labeled]
permissions:
  contents: read
  issues: write
  actions: read
concurrency:
  group: shadowarmy-${{ github.event.issue.number }}
  cancel-in-progress: false
jobs:
  order:
    if: github.event.label.name == 'arise'
    uses: Vrajesh-works/shadowarmy/.github/workflows/order.yml@main
    secrets: inherit
```

The engine's reusable workflow re-checks the sender against `monarch` itself; the `if:` above is only a cheap filter. The caller uses `@main` until the first release, then the `v1` tag ([decision 25](decisions.md)).
