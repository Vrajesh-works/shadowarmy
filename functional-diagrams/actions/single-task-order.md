# Single-Task Order

Milestone 1, implemented in `.github/workflows/order.yml` and `src/order/` (without the Knight; the Knight is added in milestone 2, see [review and fix loop](review-and-fix-loop.md)). Each box on the runner side is a separate job on its own runner, so the agent never shares a machine with the GitHub write token.

```mermaid
sequenceDiagram
  actor Monarch
  participant Realm as Realm issue
  participant Gate as gate job (Realm token)
  participant Soldier as soldier job (Claude credential only)
  participant Deliver as deliver job (Realm token + SHADOWARMY_GH_TOKEN)
  participant Target as Target repository

  Monarch->>Realm: Create issue with Order form
  Monarch->>Realm: Add label arise
  Realm->>Gate: issues labeled event (caller filters on arise)
  Gate->>Gate: Load shadowarmy.yml, check sender is monarch
  alt sender is not monarch
    Gate->>Gate: Log in run summary and stop (no change)
  else config invalid, form invalid, target not allowed or secrets missing
    Gate->>Realm: failed + status comment with reason and run link
  else daily cap reached
    Gate->>Realm: queued + status comment
  else order already past the Soldier (for example ready-to-merge)
    Gate->>Realm: Remove arise only
  else accepted
    Gate->>Realm: Remove arise, set in-progress, write status comment
    Gate->>Gate: Parse issue form (event payload file, never shell interpolation)
    Gate->>Soldier: Input files as an artifact (prompt, company, project, order, task, answers)
    Soldier->>Target: Checkout base (persist-credentials false)
    Soldier->>Soldier: claude --safe-mode -p soldier prompt (or fake agent in test Realms)
    Soldier->>Soldier: Change code, run project checks, write result.json
    Soldier->>Deliver: result.json, changes.patch, job status (untrusted artifact)
    Deliver->>Deliver: Validate result.json against schema
    alt missing, invalid or failed
      Deliver->>Realm: failed + reason + run link
    else blocked
      Deliver->>Realm: needs-decision + Soldier question
    else done
      Deliver->>Target: Fetch base commit, apply patch
      Deliver->>Deliver: Diff guard
      alt no changes or forbidden path
        Deliver->>Realm: failed + offending paths
      else clean
        Deliver->>Target: Commit as git.author, push shadowarmy/N-slug with lease
        Deliver->>Target: Open or update pull request (summary, verification, limitations)
        Deliver->>Realm: ready-to-merge + PR link
      end
    end
  end
  opt a job crashed before reporting
    Deliver->>Realm: report-failure job sets failed + run link
  end
```
