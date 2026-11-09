# Glossary

| Term | Plain meaning |
| --- | --- |
| Monarch | The one human who owns the Realm and is the only authority |
| Realm | The private control repository that holds the army: workflows, config, rules, notes and the order board |
| Engine | The public `shadowarmy` repository with reusable workflows, scripts, prompts and the CLI |
| Target repository | A project repository the army works on; it receives only branches and pull requests |
| Order | A Realm issue asking for work |
| Task | One unit of work done by one Soldier with one pull request |
| Plan | The Marshal's split of an order into tasks, approved by the Monarch |
| Marshal | Planning agent |
| Soldier | Developer agent |
| Knight | Reviewer agent |
| Scout | QA agent that tests the running software |
| Sentinel | Scheduled, deterministic supervisor workflow (no agent) |
| Fix round | One more Soldier run on the same branch to address review, test or CI findings |
| Status comment | The single engine-written comment on each order or task that shows its state |
| State block | Hidden JSON at the end of the status comment with structured state |
| Realm report | Pinned Realm issue summarising all work and what needs the Monarch |
| Diff guard | Pre-push check that keeps agent files out of target repositories |
| `arise` | Label that starts an order |
