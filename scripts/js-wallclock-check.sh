#!/usr/bin/env bash
# A JavaScript test that compares a performance.now()/Date.now() difference against a literal millisecond budget under
# 1000 measures the host as much as the code: `market/src/suggest-pool.test.js` did, and flaked twice on a busy deploy
# host while staying green through the regression it was written to catch (finding PKN-17). Every such line must be
# listed, with a reason, in scripts/js-wallclock-allowed.txt. docs/CI.md, "JavaScript tests".
#
#   scripts/js-wallclock-check.sh                check the repository of the current directory (exit 1 on an unlisted line)
#   scripts/js-wallclock-check.sh --base COMMIT  also fail when scripts/js-wallclock-allowed.txt has a `path:line` that
#                                                COMMIT's copy of the list does not have: the list is a count that may
#                                                only fall. A COMMIT with no list at all (this file's first use) counts
#                                                every line as already there.
#
# Grep-level on purpose: it reads one line, so an assert whose budget is a variable (the calibrated form) is not a
# wall-clock budget and is not asked for a reason. A line is reported when an `assert(` or `assert.ok(` line contains
# `now()` and a `<`/`<=` comparison against a number of milliseconds below 1000.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
allowed="$root/scripts/js-wallclock-allowed.txt"
test_re='\.test\.(js|mjs|cjs|jsx|ts|tsx)$'
tab=$'\t'

die() { echo "js-wallclock-check: $*" >&2; exit 1; }

base=''
if [[ ${1:-} == --base ]]; then
  [[ $# -eq 2 ]] || die "usage: --base COMMIT"
  git -C "$root" cat-file -e "$2" 2>/dev/null || die "--base: no such object: $2"
  base=$2
  shift 2
fi
[[ $# -eq 0 ]] || die "usage: [--base COMMIT]"

# The `path:line` of every wall-clock budget below 1000 ms, one per line.
scan_file() { # scan_file <path>
  local f=$1 hit lineno text lit num
  while IFS= read -r hit; do
    lineno=${hit%%:*}
    text=${hit#*:}
    while IFS= read -r lit; do
      [[ -n $lit ]] || continue
      num=$(tr -dc '0-9' <<<"$lit")
      [[ -n $num ]] || continue
      if ((10#$num < 1000)); then
        printf '%s:%s\n' "$f" "$lineno"
        break
      fi
    done < <(grep -oE '(<=|<)[[:space:]]*[0-9][0-9_]*' <<<"$text")
  done < <(grep -nE 'assert(\.ok)?\(' "$f" | grep -F 'now()' || true)
}

found=$(mktemp)
listed=$(mktemp)
baselist=$(mktemp)
trap 'rm -f "$found" "$listed" "$baselist"' EXIT

while IFS= read -r f; do
  scan_file "$f"
done < <(git -C "$root" ls-files | grep -E "$test_re" || true) >"$found"
total=$(wc -l <"$found")

# Read the list: `path:line<TAB>reason`, the reason at least 15 characters. A listed key that is not a violation any
# more is stale and must go, the same way the other lists of this repository retire the lines that protect nothing.
fail=0
if [[ -f $allowed ]]; then
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == '#'* ]] && continue
    key=${line%%"$tab"*}
    reason=${line#*"$tab"}
    if [[ ! $key =~ ^[^:]+:[0-9]+$ || -z $reason ]]; then
      echo "wall-clock list: a line needs path:line<TAB>reason: $line" >&2
      fail=1
      continue
    fi
    if [[ ${#reason} -lt 15 ]]; then
      echo "wall-clock list: $key needs a reason of at least 15 characters: $reason" >&2
      fail=1
    fi
    path=${key%:*}
    if [[ -z $(git -C "$root" ls-files -- "$path") ]]; then
      echo "wall-clock list: $path is not a tracked file any more (remove the line)" >&2
      fail=1
    elif ! grep -qxF -- "$key" "$found"; then
      echo "wall-clock list: $key is not a wall-clock budget any more (remove the line)" >&2
      fail=1
    fi
    printf '%s\n' "$key" >>"$listed"
  done <"$allowed"
fi

while IFS= read -r key; do
  grep -qxF -- "$key" "$listed" && continue
  echo "wall-clock budget under 1000 ms, not listed in scripts/js-wallclock-allowed.txt: $key $(sed -n "${key##*:}p" "$root/${key%:*}" | sed 's/^[[:space:]]*//')" >&2
  fail=1
done <"$found"

# The list is a count that may only fall. Adding a line excuses a new wall-clock budget, which is not a change a merge
# can make on its own: CI fails on every added line, and such a commit ships only with the owner's logged override of
# scripts/require-ci-green.sh. Removing a line is always fine.
if [[ -n $base ]]; then
  if git -C "$root" cat-file -e "$base:scripts/js-wallclock-allowed.txt" 2>/dev/null; then
    while IFS= read -r line || [[ -n $line ]]; do
      [[ -z $line || $line == '#'* ]] && continue
      printf '%s\n' "${line%%"$tab"*}" >>"$baselist"
    done < <(git -C "$root" show "$base:scripts/js-wallclock-allowed.txt")
    while IFS= read -r key; do
      grep -qxF -- "$key" "$baselist" && continue
      echo "wall-clock list: $key was not in the list at $base: an added line. CI fails on every added line; it ships only with the owner's logged override of scripts/require-ci-green.sh" >&2
      fail=1
    done <"$listed"
  else
    echo "js-wallclock-check: $base has no scripts/js-wallclock-allowed.txt, so every line counts as already there" >&2
  fi
fi

if [[ $fail -ne 0 ]]; then exit 1; fi
echo "js-wallclock-check: $total wall-clock budget(s) below 1000 ms, every one listed with a reason"
