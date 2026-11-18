#!/usr/bin/env bash
# Runs one job of .github/workflows/js-ci.yml: scripts/js-run-group.sh GROUP. docs/CI.md.
# The line of GROUP in scripts/js-test-groups.txt gives the working directory and the command; the tracked test files
# (scripts/js-test-inventory.sh --files GROUP) are appended to the command, relative to the working directory.
set -euo pipefail
set -f # the globs of the groups file are words, never expanded by the shell
[[ $# -eq 1 ]] || { echo "usage: $0 GROUP" >&2; exit 2; }
root=$(git rev-parse --show-toplevel)
group=$1
line=$(awk -F'\t' -v g="$group" '$1 == g { print; exit }' "$root/scripts/js-test-groups.txt")
[[ -n $line ]] || { echo "no group named $group" >&2; exit 2; }
IFS=$'\t' read -r _ wd cmd _ <<<"$line"
mapfile -t files < <(bash "$root/scripts/js-test-inventory.sh" --files "$group")
[[ ${#files[@]} -gt 0 ]] || { echo "group $group matches no test file" >&2; exit 1; }
rel=()
for f in "${files[@]}"; do
  if [[ $wd == . ]]; then rel+=("$f"); else rel+=("${f#"$wd"/}"); fi
done
cd "$root/$wd"
echo "js-run-group: $group: ${#rel[@]} files in $wd: $cmd"
# shellcheck disable=SC2086 # the command is a space separated word list
exec $cmd "${rel[@]}"
