# Contributing

Contributions should keep the Monarch the only authority, keep target repositories clean and keep every run bounded and honest. Read [AGENTS.md](AGENTS.md) first.

## Pick An Issue

Choose an unassigned issue with a clear scope and comment that you would like to take it. If the issue is ambiguous, ask for the missing rule before changing behavior. For larger work, summarize your approach in the issue before writing code. Keep unrelated refactors in their own pull requests.

## Before You Submit

```sh
npm run check
npm test
npm run lint
```

If your change touches a workflow, the status comment, labels, configuration or a role prompt, also run it end to end on a sandbox Realm ([DEVELOPMENT.md](DEVELOPMENT.md#sandbox-repositories)) and link the run in your pull request. Update the behavior contract, roles, configuration and functional diagrams in the same pull request.

Never include real tokens, private repository names, real customer code or unredacted agent transcripts.

## Pull Requests

Create a branch, push it, and open a pull request against `main`. Use a short title that names the behavior changed. Fill in the template:

```md
## Summary
-

## Validation
- Commands run and results:
- End-to-end run links (sandbox Realm):

## Spec and Diagram Updates
-

## Security Notes
- Tokens, untrusted input or agent permissions touched? How are they handled?

## AI Assistance
-
```

Expect review on authority checks, clean-project guarantees, limits, untrusted input handling, test coverage and documentation accuracy.

## AI Usage

AI assistance is welcome. You remain responsible for the change:

- Read and understand everything you submit.
- Validate it yourself, including end-to-end runs for workflow changes.
- Remove speculative changes outside the issue.
- Check for leaked secrets and private identifiers.
- Mention material AI assistance in the pull request. Do not add AI agents as commit co-authors.
