# Set Up A Realm By Hand

Updated November 9, 2026. Until the `init` CLI exists (milestone 5), a Realm is set up with these steps. They take about fifteen minutes. You need the GitHub CLI (`gh`), signed in as the account that will be the Monarch, and Claude Code (`claude`) for the subscription credential.

## 1. Create The Realm Repository

```sh
gh repo create realm --private --clone
cd realm
```

Keep the Realm private if any target repository is private. Anyone can download a public repository's workflow artifacts, which carry the target's source between jobs, so a public Realm refuses orders for private targets.

Copy everything inside the engine's `template/` folder into it (including the hidden `.github` folder), then commit and push:

```sh
cp -R /path/to/shadowarmy/template/. .
git add -A && git commit -m "Set up shadowarmy Realm" && git push
```

## 2. Configure It

Edit `shadowarmy.yml`:

- `monarch`: your GitHub login (it defaults to the Realm owner).
- `targets`: the repositories the army may work on, as `owner/name` or `owner/*`. The Realm itself is never a target.

Edit `rules/company.md` with your standing engineering rules, and optionally add `projects/<owner>__<repo>.md` notes per target. See [configuration](configuration.md) for every key and its limits.

`.github/workflows/order.yml` calls the engine at `@main` until the first release; from milestone 5 it pins the `v1` tag.

## 3. Create The Labels

```sh
gh label create arise          --color 5319e7 --description "Start this order"
gh label create queued         --color c5def5 --description "Waiting for capacity"
gh label create planning       --color bfd4f2 --description "Marshal is planning"
gh label create in-progress    --color 1d76db --description "A Soldier is working"
gh label create in-review      --color 0e8a16 --description "Knight review or fix round"
gh label create waiting-ci     --color fbca04 --description "Waiting for target CI"
gh label create needs-decision --color d93f0b --description "Needs the Monarch"
gh label create ready-to-merge --color 0e8a16 --description "Pull request ready for the Monarch"
gh label create done           --color cccccc --description "Merged"
gh label create failed         --color b60205 --description "Stopped; use /retry"
gh label create dismissed      --color cccccc --description "Stopped by the Monarch"
gh label create order          --color ededed --description "Order issue"
gh label create task           --color ededed --description "Task issue"
gh label create new-project    --color ededed --description "New project order"
```

## 4. Add The Secrets

**GitHub token.** Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) limited to your target repositories (not the Realm), with Contents: read and write, Pull requests: read and write, and Metadata: read. Store it without printing it:

```sh
gh secret set SHADOWARMY_GH_TOKEN
```

`gh` prompts for the value, so it never lands in your shell history.

**Claude credential.** Either use your Claude subscription:

```sh
claude setup-token          # prints a long-lived token for this purpose
gh secret set CLAUDE_CODE_OAUTH_TOKEN
```

or a pay-per-use API key: `gh secret set ANTHROPIC_API_KEY`. Use a credential dedicated to the Realm so you can revoke it on its own.

## 5. Place The First Order

1. Open a new issue with the **Order** form: the target repository and the task.
2. Add the `arise` label.
3. Watch the issue: the label moves to `in-progress`, then `ready-to-merge` with a link to the pull request, or `failed` / `needs-decision` with the reason. The status comment links the workflow run.
4. Review the pull request in the target repository and merge it yourself.

Only the Monarch's `arise` counts. Labels added by anyone else are ignored and leave the issue unchanged.

## Test Mode

A test Realm can replace the Soldier with a canned script by setting the repository variable `SHADOWARMY_FAKE_AGENT` to one of `add-file`, `edit-claude-md`, `no-changes`, `blocked` or `invalid-result` (see `scripts/fake-agent.sh` in the engine). Everything else (validation, diff guard, push, pull request, labels) runs for real. Leave it unset in a real Realm.
