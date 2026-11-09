# Security

Updated November 9, 2026. Status: agreed. Implemented in milestone 1: the actor check on `arise`, the diff guard, the job split that keeps the GitHub write token out of the agent's job entirely ([decision 23](decisions.md)), the agent job with `permissions: {}` and only the Claude credential, `persist-credentials: false` checkouts, `--safe-mode` so target repository configuration does not load into the agent, schema validation and size caps on `result.json`, push only to `shadowarmy/*` branches with a lease, git authentication through environment variables instead of command lines or `.git/config`, redaction of the Claude credential from the uploaded agent summary, and the status comment author check. Implemented in milestone 0: the custom workflow lint that rejects `${{ }}` in `run:` scripts (`scripts/check-workflow-expressions.ts`, run by engine CI), full-SHA pinning of third-party actions in the engine CI, schema validation of the state block with length caps, and escaping of untrusted text in status comments. Every other safeguard below is a requirement for the milestone that introduces the affected component.

shadowarmy runs AI agents with write access to code, unattended, on text that may come from other people. The design assumes agents can be confused or manipulated and limits what a confused agent can do.

## Assets

- The Monarch's GitHub credential (`SHADOWARMY_GH_TOKEN`): write access to target repositories.
- The Monarch's Claude credential: spending and account access.
- Target repository code and default branches.
- The Realm: rules, notes and order history (private).

## Trust Boundaries

| Source | Trusted? | Handling |
| --- | --- | --- |
| Engine code at a pinned tag | Yes | Realm callers pin a major version; releases are reviewed |
| `shadowarmy.yml`, `rules/`, `projects/` in the Realm | Yes, Monarch-authored | Changes arrive by Monarch commits or Monarch-merged Realm pull requests |
| Labels and commands from the Monarch | Yes | Actor checked on every event |
| Events from any other account | No | Ignored and logged |
| Order issue text | Monarch-authored, still treated as data | Never interpolated into shell; passed by file |
| Target repository files, issues, PR comments by others | No | Data for agents only |
| CI logs | No | Excerpted, passed by file |
| Agent outputs | No | Schema-validated; scripts act only on validated fields |

## Threats And Required Safeguards

| Threat | Safeguard |
| --- | --- |
| Someone else triggers the army (on a public Realm or by being added as a collaborator) | Realm private by default; actor check against `monarch` on every trigger and command; non-Monarch events change nothing |
| Script injection through issue titles or bodies in workflow `run:` steps | No `${{ github.event.* }}` inside `run:`; event data reaches scripts through `env:` or the event payload file only; actionlint and a custom lint rule in CI |
| Prompt injection from target repository content tells the agent to leak secrets or damage code | Agent step has no GitHub token; checkout with `persist-credentials: false`; Claude credential is the only secret in its environment; diff guard; Knight review; Monarch merge |
| Agent exfiltrates the Claude credential | Accepted residual risk on an unrestricted runner network; mitigated by using a dedicated token the Monarch can revoke, documented in setup; the Claude credential never reaches target repositories |
| Agent pushes to a default branch or rewrites history | Agents cannot push; the push script only pushes `shadowarmy/*` branches and never force-pushes branches it did not create; branch protection recommended |
| Malicious dependency or build script in a target repository runs during Soldier or Scout checks | Runs only on disposable runners with no GitHub write credential; the Monarch chooses targets (`targets:` allowlist) |
| Agent adds workflow files that run with the target's secrets | Diff guard blocks `.github/workflows/` changes unless explicitly ordered; Knight flags them; Monarch merges |
| Runaway cost | Turn limits, job timeouts, fix-round caps, concurrency caps, daily run cap |
| Stale or over-scoped GitHub token | Fine-grained token limited to chosen repositories; expiry warning; GitHub App option later |
| Realm state tampering | State lives in labels and engine-authored comments; the state block is schema-validated and only engine-authored comments are read (author check) |

## Why The Agent Gets Its Own Job

Within one job every step runs as the same user on the same machine. A process the agent starts and leaves running could read the environment of a later step (for example the push step's token) from `/proc`, or change the engine's files before a later step runs them. Keeping the token out of the agent's own steps is not enough either: GitHub sends every secret a job references to that job's runner process, and on hosted runners the `runner` user has passwordless `sudo`, so the agent could read any such secret from the runner process memory. The order workflow therefore runs the agent in its own job on its own runner, and that job never receives `SHADOWARMY_GH_TOKEN` at all:

- `gate` fetches the base branch of the target with `SHADOWARMY_GH_TOKEN` (an HTTP header passed through the environment, so nothing is written to `.git/config`), packs the checkout into the Soldier inputs and records the base commit as a job output. No agent runs there.
- `soldier` holds only the Claude credential. It unpacks the checkout the gate job made; the workflow never references `SHADOWARMY_GH_TOKEN` in this job. Its `GITHUB_TOKEN` has no permissions.
- `deliver` runs on a fresh runner, re-validates everything the soldier job uploaded, fetches the base commit the gate job recorded and applies the patch there, so the diff guard sees exactly what will be pushed.

## Rules For Implementers

- Never reference `SHADOWARMY_GH_TOKEN` in a job that runs an agent. Fetch the target in a job without an agent and hand the checkout over as an artifact.
- Use `actions/checkout` with `persist-credentials: false` for every checkout, and authenticate script git commands through environment variables only.
- Pass the GitHub write token only to the steps that fetch, push or open pull requests, as a step-level `env`.
- Mask any value derived from a secret with `::add-mask::` before logging.
- Read the comment author before trusting any comment, including status comments (must be the Actions bot of the Realm).
- Pin third-party actions to full commit SHAs.
- Treat every agent output as untrusted input: validate with a schema, cap lengths, and escape before rendering into comments.

## Reporting Vulnerabilities

Until a security policy exists, report privately to the maintainer through GitHub's private vulnerability reporting on the engine repository.
