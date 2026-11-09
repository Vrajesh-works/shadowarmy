# Review And Fix Loop

Milestone 2, implemented in `.github/workflows/order.yml`, `src/order/judge.ts`, `src/order/gate.ts` and `src/feedback.ts`. Each round is one workflow run. The judge job starts the next round by dispatching a new run of the Realm's order workflow; the per-issue concurrency group queues it behind the current run. The fix round's gate rebuilds the Soldier's feedback from GitHub, so no round depends on runner storage from another ([decision 30](../../docs/decisions.md)).

```mermaid
sequenceDiagram
  participant Gate as gate job
  participant Soldier as soldier job (Claude only)
  participant Deliver as deliver job
  participant Knight as knight job (Claude only)
  participant Judge as judge job
  participant Target as Target repository
  participant Realm as Realm issue

  Note over Gate,Realm: Round 0 starts from arise (see single-task order). A fix round starts from a dispatch.
  opt fix round (workflow_dispatch from the judge, or the Monarch)
    Gate->>Gate: Sender is the Monarch or github-actions[bot]; issue is in-progress with a PR and round >= 1
    Gate->>Target: Read PR head; Knight's latest review of that commit (author = engine account, valid review block); failed checks and log excerpts
    Gate->>Gate: feedback.md (blocker and major findings, failing checks)
    Gate->>Target: Fetch the task branch head (SHADOWARMY_GH_TOKEN)
    Gate->>Realm: Status: fix round N of max
  end
  Gate->>Soldier: Inputs + packed checkout (+ feedback.md in a fix round)
  Soldier-->>Deliver: result.json, changes.patch (untrusted)
  Deliver->>Deliver: Validate, apply on the round's start commit, diff guard
  Deliver->>Target: Push (fix round: fast-forward with a lease on the start commit), open or update PR
  Deliver->>Realm: in-review
  Deliver->>Knight: Packed branch, diff from the first round's base commit, soldier-result.json
  Knight-->>Judge: review.json (untrusted)
  Judge->>Judge: Validate schema and that the verdict matches the findings
  Judge->>Target: Post a comment-type PR review on the head commit, with a review block
  alt changes requested
    alt rounds left
      Judge->>Realm: in-progress, round += 1, remaining findings
      Judge->>Realm: workflow_dispatch (issue number): the next run is the fix round
    else rounds used up
      Judge->>Realm: needs-decision + remaining findings
    end
  else approved
    Judge->>Target: Wait for checks of the head commit (up to ci.max_wait_minutes, at most 300)
    alt failing
      Judge->>Realm: Fix round as above, or needs-decision when rounds are used up
    else still pending at the limit
      Judge->>Realm: needs-decision (the Sentinel takes over long waits from milestone 3)
    else green, or no CI after 2 minutes
      Judge->>Target: PR body with minor findings
      Judge->>Realm: ready-to-merge + PR link
    end
  end
```
