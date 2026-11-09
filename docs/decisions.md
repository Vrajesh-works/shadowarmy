# Decisions

Dated log of product and engineering decisions. Add new entries at the bottom. When a decision is replaced, keep the old entry and mark it "Replaced by #N".

| # | Date | Decision | Why |
| --- | --- | --- | --- |
| 1 | 2026-11-08 | The project is named `shadowarmy`. | Plain English, free on npm at the time of checking, fits "an army that grows on command". `strawhats` was rejected because it is a specific trademarked franchise name. |
| 2 | 2026-11-08 | Role names: Monarch (human), Marshal, Soldier, Knight, Scout, Sentinel; the control repository is the Realm. Labels and docs stay plain. | Themed but generic words; no character names or artwork from any franchise. |
| 3 | 2026-11-08 | Build a standalone project inspired by firstmate instead of adding a GitHub Actions runtime to firstmate. | firstmate's core is a live supervisor driving interactive terminal sessions; Actions runs are not interactive. A small, separate upstream contribution (GitHub Issues backlog) is planned instead. See [firstmate bridge](firstmate-bridge.md). |
| 4 | 2026-11-08 | All agent machinery lives in a separate Realm repository; target repositories stay clean. | Users asked that built projects contain no agent details. Mirrors firstmate's separate home. |
| 5 | 2026-11-08 | Realms are created by `init` from a `template/` folder and call the engine's reusable workflows at a pinned major version, instead of forking the engine. | Forks of public repositories cannot be private and have Actions disabled by default; reusable workflows let every Realm receive fixes by version. |
| 6 | 2026-11-08 | Agents are Claude Code run headless in workflow steps; git, pushes, pull requests and labels are deterministic scripts. `anthropics/claude-code-action` is not the core runtime. | Cross-repository work and exact state handling need deterministic control, and the agent step must not hold the GitHub write token. The action is built around acting on the triggering repository. Revisit if it gains a suitable mode. |
| 7 | 2026-11-08 | All state lives on GitHub: one state label per issue plus one engine-authored status comment with a schema-validated state block. | Survives any run dying; visible from the GitHub mobile app; no service to host. |
| 8 | 2026-11-08 | Target repository events are observed by a scheduled Sentinel, not by workflows inside target repositories. | Keeps targets clean. Cost: reactions take minutes. |
| 9 | 2026-11-08 | No automatic merging, ever. | The Monarch is the only authority over what lands. |
| 10 | 2026-11-08 | Engine scripts are TypeScript on Node 22. | The CLI ships through npm, so Node is required anyway; one language for scripts and CLI. |
| 11 | 2026-11-08 | Users bring their own Claude credential and GitHub token; no hosted shadowarmy service. | Ownership, cost and trust: no server holding write access to other people's code. |
