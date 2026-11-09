# Merge And Close

Milestone 3. Merging is always the Monarch's act; no engine code path merges.

```mermaid
sequenceDiagram
  actor Monarch
  participant Target as Target repository
  participant S as sentinel.yml
  participant Realm as Realm

  Monarch->>Target: Review and merge the pull request
  Note over Target: Branch protection (recommended) requires the Monarch's approval.<br/>Knight reviews are comments and never satisfy it
  S->>Target: Next patrol reads PR state = merged
  S->>Realm: Task done, issue closed as completed
  alt task belongs to a multi-task order
    S->>Realm: Dispatch tasks whose dependencies are now merged
    alt all tasks done
      S->>Realm: Order done, closed as completed
    end
  end
  S->>Realm: Update Realm report
```

Task branches are left for the target repository's own branch-deletion setting; the engine does not delete branches.
