# Set Up A Realm

Milestone 5 (`init` CLI). Until then the same steps are done by hand following [Realm setup](../../docs/realm-setup.md).

```mermaid
sequenceDiagram
  actor Monarch
  participant CLI as npx shadowarmy init
  participant GH as GitHub API (gh auth of Monarch)
  participant Realm as New Realm repo
  participant Claude as claude setup-token

  Monarch->>CLI: Run init
  CLI->>GH: Check gh auth and login
  alt not authenticated
    CLI-->>Monarch: Ask to run gh auth login, stop
  end
  CLI-->>Monarch: Ask Realm name (default realm), confirm private
  CLI->>GH: Create private repository
  CLI->>Realm: Push template/ (caller workflows pinned to engine @v1, issue forms, shadowarmy.yml with monarch = login, rules/company.md)
  CLI->>GH: Create labels
  CLI-->>Monarch: Ask which target repositories to allow (writes targets in shadowarmy.yml)
  CLI-->>Monarch: Open fine-grained token page with the required permissions listed
  Monarch->>CLI: Paste token (hidden input)
  CLI->>GH: Store SHADOWARMY_GH_TOKEN as Realm secret
  CLI-->>Monarch: Choose Claude credential (subscription token or API key)
  opt subscription token
    CLI->>Claude: Run claude setup-token
    Claude-->>CLI: Token
  end
  CLI->>GH: Store CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY as Realm secret
  CLI->>CLI: Run doctor (secrets present, token can reach each target, config valid)
  opt Monarch accepts
    CLI->>GH: Offer branch protection on each target (protect)
  end
  CLI-->>Monarch: Realm URL and how to place the first order
```

Secrets are never printed, logged or written to disk by the CLI.
