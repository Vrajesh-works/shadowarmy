# Monarch Commands

Milestone 3.

```mermaid
sequenceDiagram
  actor Monarch
  participant Realm as Realm issue
  participant CMD as command.yml (runner)
  participant WF as order.yml or plan.yml

  Monarch->>Realm: Comment starting with /approve, /answer, /retry, /dismiss or /status
  Realm->>CMD: issue_comment created
  CMD->>CMD: Check comment author is monarch
  alt not monarch or not a command
    CMD->>CMD: Ignore (logged in run summary)
  else /approve
    alt state is needs-decision with a pending plan or repo creation
      CMD->>WF: Dispatch approved step (create tasks or create repo)
    else nothing to approve
      CMD->>Realm: Reply "nothing waiting for approval"
    end
  else /answer text
    CMD->>Realm: Record answer in state block (answers list)
    CMD->>WF: Dispatch the role that asked (Marshal or Soldier) with answers.md
  else /retry
    alt state is failed
      CMD->>WF: Dispatch from last safe point (fix round if branch and PR exist, else fresh Soldier)
    else
      CMD->>Realm: Reply "only failed work can be retried"
    end
  else /dismiss
    CMD->>CMD: Cancel running runs in the issue's concurrency group
    CMD->>Realm: dismissed, close as not planned, list branches and PRs left open
  else /status
    CMD->>Realm: Re-render status comment from current GitHub state
  end
```

Pull request feedback: a Monarch review with "request changes", or a Monarch PR comment starting with `/fix`, is picked up by the Sentinel on its next patrol and starts a fix round with that text as feedback.
