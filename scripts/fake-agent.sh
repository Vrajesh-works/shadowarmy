#!/usr/bin/env bash
# A stand-in for the Soldier, used only when a test Realm sets the repository
# variable SHADOWARMY_FAKE_AGENT to one of the scenarios below. It edits the
# checkout in the current directory and writes result.json the way the real
# Soldier would, so the rest of the pipeline (validation, diff guard, push,
# pull request, Knight review, fix rounds, labels) runs for real.
#
# The round number comes from $SHADOWARMY_IN/round (0 when absent). Scenarios
# play the first round only and exit 3 in fix rounds, which tells the
# workflow to run the real Soldier instead; stubborn-bug plays every round.
set -euo pipefail

scenario="${1:?scenario required}"
out="${SHADOWARMY_OUT:?SHADOWARMY_OUT is not set}"
round=0
if [ -n "${SHADOWARMY_IN:-}" ] && [ -f "$SHADOWARMY_IN/round" ]; then
  round="$(tr -dc '0-9' < "$SHADOWARMY_IN/round")"
  round="${round:-0}"
fi
mkdir -p "$out"

# Exit code that hands this round to the real Soldier.
readonly DELEGATE=3

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

# A farewell() that misses the comma and the exclamation mark the task asks for,
# for orders that ask for: farewell(name) returning exactly "Goodbye, <name>!".
write_buggy_farewell() {
  mkdir -p src
  cat >> src/greet.js <<'JS'

/** Returns a farewell for `name`. */
export function farewell(name) {
  return "Goodbye " + name;
}
JS
}

case "$scenario" in
  add-file)
    [ "$round" = 0 ] || exit "$DELEGATE"
    printf 'Written by the shadowarmy fake agent.\n' > shadowarmy-fake-agent.txt
    result "done" "Add fake agent marker file" "Adds shadowarmy-fake-agent.txt." null
    ;;
  edit-claude-md)
    [ "$round" = 0 ] || exit "$DELEGATE"
    printf '\nRun the tests before every change.\n' >> CLAUDE.md
    result "done" "Update contributor notes" "Edits CLAUDE.md although the order did not ask for it." null
    ;;
  no-changes)
    [ "$round" = 0 ] || exit "$DELEGATE"
    result "done" "Nothing to change" "Reports done without changing any file." null
    ;;
  blocked)
    [ "$round" = 0 ] || exit "$DELEGATE"
    result blocked "Need a decision" "Stops to ask the owner." '"Should the feature be on by default? Reply /answer yes or /answer no."'
    ;;
  invalid-result)
    [ "$round" = 0 ] || exit "$DELEGATE"
    printf 'this is not json\n' > "$out/result.json"
    ;;
  seed-bug)
    [ "$round" = 0 ] || exit "$DELEGATE"
    write_buggy_farewell
    result "done" "Add farewell function" "Adds farewell(name) to src/greet.js." null
    ;;
  stubborn-bug)
    if [ "$round" = 0 ]; then
      write_buggy_farewell
    else
      mkdir -p src
      printf '// fix attempt %s (the fake agent never fixes the bug)\n' "$round" >> src/greet.js
    fi
    result "done" "Add farewell function" "Adds farewell(name) to src/greet.js." null
    ;;
  *)
    echo "unknown fake agent scenario: $scenario" >&2
    exit 2
    ;;
esac
