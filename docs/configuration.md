# Configuration

Updated November 8, 2026. Status: agreed, not implemented. Keys and defaults here are the contract for `src/config.ts` and its schema.

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

The Realm's own `GITHUB_TOKEN` is used for everything inside the Realm (labels, comments, issues). Caller workflows grant it `issues: write`, `contents: read` and `pull-requests: write`.

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

| Field id | Type | Required | Notes |
| --- | --- | --- | --- |
| `target` | input | yes | `owner/name`; validated against `targets` |
| `task` | textarea | yes | Plain-language task and what done looks like |
| `base` | input | no | Base branch; defaults to the target's default branch |

`template/.github/ISSUE_TEMPLATE/new-project.yml`:

| Field id | Type | Required | Notes |
| --- | --- | --- | --- |
| `idea` | textarea | yes | What to build and for whom |
| `name` | input | no | Preferred repository name |
| `visibility` | dropdown | yes | `private` (default) or `public` |

GitHub renders issue form answers as markdown sections (`### Target repository` followed by the value). The parser reads sections by their labels, trims whitespace, treats `_No response_` as empty and validates every value. A body that does not match the form is reported as `failed` with the reason.

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
  pull-requests: write
concurrency:
  group: shadowarmy-${{ github.event.issue.number }}
  cancel-in-progress: false
jobs:
  order:
    if: github.event.label.name == 'arise'
    uses: shadowarmy/shadowarmy/.github/workflows/order.yml@v1
    secrets: inherit
```

The engine's reusable workflow re-checks the sender against `monarch` itself; the `if:` above is only a cheap filter. The engine path (`shadowarmy/shadowarmy`) is a placeholder until the repository exists.
