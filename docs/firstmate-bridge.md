# firstmate Bridge

Updated November 8, 2026. Status: proposed, after milestone 3.

[firstmate](https://github.com/kunchenguid/firstmate) is a local supervisor: one Claude session on the Monarch's machine that delegates work to worker agents in tmux and supervises them live. shadowarmy is its cloud counterpart: it keeps working when the machine is off. The bridge lets both share one task list.

## Idea

- firstmate stores its backlog through a configurable backend (`config/backlog-backend` in a firstmate home).
- A **GitHub Issues backend** for firstmate would read and write the same Realm issues and labels shadowarmy uses.
- At the desk, firstmate supervises tasks locally. When the Monarch leaves, tasks labelled `arise` are picked up by the Realm. When the Monarch returns, firstmate sees everything the army did, because it is all on the same issues.

## Rules

- One owner per task at a time: a task in `in-progress` by shadowarmy is not dispatched by firstmate, and the reverse. The ownership marker lives in the state block (`owner: "realm" | "firstmate"`).
- Labels and the status comment format in [the behavior contract](behavior-contract.md) are the shared contract; firstmate's backend must not invent new states.

## Upstream Contribution Process

firstmate requires human pull requests to go through `no-mistakes` (see its `CONTRIBUTING.md`). Steps:

1. Open an issue on firstmate proposing the GitHub Issues backlog backend, linking to working shadowarmy as evidence.
2. Wait for the maintainer's agreement on scope.
3. Implement in a fork, push through `no-mistakes init --fork-url ...`, and let it open the pull request.

Keep the contribution small and independent of shadowarmy: it must be useful to firstmate users who never install shadowarmy.
