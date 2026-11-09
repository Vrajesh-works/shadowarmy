#!/usr/bin/env bash
# A stand-in for the Soldier, used only when a test Realm sets the repository
# variable SHADOWARMY_FAKE_AGENT to one of the scenarios below. It edits the
# checkout in the current directory and writes result.json the way the real
# Soldier would, so the rest of the pipeline (validation, diff guard, push,
# pull request, labels) runs for real without spending agent turns.
set -euo pipefail

scenario="${1:?scenario required}"
out="${SHADOWARMY_OUT:?SHADOWARMY_OUT is not set}"
mkdir -p "$out"

result() {
  # $1 status, $2 title, $3 summary, $4 question (JSON value)
  cat > "$out/result.json" <<JSON
{
  "status": "$1",
  "title": "$2",
  "summary": "$3",
  "verification": [{ "command": "true", "outcome": "pass", "notes": "fake agent" }],
  "limitations": ["Produced by the fake agent scenario $scenario."],
  "question": $4,
  "injectionNoticed": false
}
JSON
}

case "$scenario" in
  add-file)
    printf 'Written by the shadowarmy fake agent.\n' > shadowarmy-fake-agent.txt
    result "done" "Add fake agent marker file" "Adds shadowarmy-fake-agent.txt." null
    ;;
  edit-claude-md)
    printf '\nRun the tests before every change.\n' >> CLAUDE.md
    result "done" "Update contributor notes" "Edits CLAUDE.md although the order did not ask for it." null
    ;;
  no-changes)
    result "done" "Nothing to change" "Reports done without changing any file." null
    ;;
  blocked)
    result blocked "Need a decision" "Stops to ask the owner." '"Should the feature be on by default? Reply /answer yes or /answer no."'
    ;;
  invalid-result)
    printf 'this is not json\n' > "$out/result.json"
    ;;
  *)
    echo "unknown fake agent scenario: $scenario" >&2
    exit 2
    ;;
esac
