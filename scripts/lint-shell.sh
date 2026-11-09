#!/usr/bin/env bash
# Run shellcheck on every shell script tracked by git (this file included,
# so the list is never empty). Workflow run: scripts are checked by actionlint,
# which calls shellcheck itself.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
mapfile -t files < <(git ls-files -- '*.sh')
shellcheck -- "${files[@]}"
echo "shellcheck: ${#files[@]} files checked."
