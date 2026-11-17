#!/usr/bin/env bash
# Every tracked JavaScript test file must be run by a job of .github/workflows/js-ci.yml or be listed, with a reason, in
# scripts/js-tests-not-in-gate.txt. docs/CI.md.
#
#   scripts/js-test-inventory.sh                check the repository of the current directory (exit 1 on a gap)
#   scripts/js-test-inventory.sh --files GROUP  print the tracked files of one group of scripts/js-test-groups.txt
#   scripts/js-test-inventory.sh --base COMMIT  also fail when the not-in-gate list has a path that COMMIT's copy of the
#                                               list does not have: the list is a count that may only fall. A COMMIT with
#                                               no list at all (this file's first use) counts every line as already there.
#
# The groups file is the one place where the file globs of the jobs are written; scripts/js-run-group.sh runs a job
# from the same line. Format: group<TAB>working directory<TAB>command<TAB>file globs (see the header of that file).
set -euo pipefail
set -f # the globs of the groups file are words, never expanded by the shell

root=$(git rev-parse --show-toplevel)
groups="$root/scripts/js-test-groups.txt"
notin="$root/scripts/js-tests-not-in-gate.txt"
test_re='\.test\.(js|mjs|cjs|jsx|ts|tsx)$'

die() { echo "js-test-inventory: $*" >&2; exit 1; }

# Glob to anchored regex: ** crosses slashes (and **/ may match nothing), * stops at a slash.
glob_re() {
  local g=$1
  g=${g//./\\.}
  g=${g//+/\\+}
  g=${g//\*\*\//$'\001'}
  g=${g//\*\*/$'\002'}
  g=${g//\*/[^/]*}
  g=${g//$'\001'/(.*/)?}
  g=${g//$'\002'/.*}
  printf '^%s$' "$g"
}

# Tracked files matching the globs given as arguments ("!glob" excludes).
match_files() {
  local g inc=() exc=() f hit
  for g in "$@"; do
    if [[ $g == '!'* ]]; then exc+=("$(glob_re "${g:1}")"); else inc+=("$(glob_re "$g")"); fi
  done
  while IFS= read -r f; do
    hit=0
    for g in "${inc[@]}"; do [[ $f =~ $g ]] && { hit=1; break; }; done
    [[ $hit -eq 1 ]] || continue
    for g in "${exc[@]}"; do [[ $f =~ $g ]] && { hit=0; break; }; done
    [[ $hit -eq 1 ]] && printf '%s\n' "$f"
  done < <(git -C "$root" ls-files)
  return 0
}

[[ -f $groups ]] || die "missing $groups"

# Reads the groups file into parallel arrays g_name[] and g_globs[].
g_name=(); g_globs=()
tab=$'\t'
while IFS= read -r line || [[ -n $line ]]; do
  [[ -z $line || $line == '#'* ]] && continue
  IFS=$'\t' read -r name wd cmd globs extra <<<"$line"
  if [[ -z ${name:-} || -z ${wd:-} || -z ${cmd:-} || -z ${globs:-} || -n ${extra:-} ]]; then
    die "$groups: a line needs exactly four tab separated fields: $line"
  fi
  g_name+=("$name"); g_globs+=("$globs")
done <"$groups"
[[ ${#g_name[@]} -gt 0 ]] || die "$groups lists no group"

if [[ ${1:-} == --files ]]; then
  [[ $# -eq 2 ]] || die "usage: --files GROUP"
  for i in "${!g_name[@]}"; do
    if [[ ${g_name[$i]} == "$2" ]]; then
      # shellcheck disable=SC2086 # the globs are space separated words
      match_files ${g_globs[$i]}
      exit 0
    fi
  done
  die "no group named $2 in $groups"
fi
base=''
if [[ ${1:-} == --base ]]; then
  [[ $# -eq 2 ]] || die "usage: --base COMMIT"
  git -C "$root" cat-file -e "$2" 2>/dev/null || die "--base: no such object: $2"
  base=$2
  shift 2
fi
[[ $# -eq 0 ]] || die "usage: [--files GROUP | --base COMMIT]"

fail=0
covered=$(mktemp)
trap 'rm -f "$covered"' EXIT
for i in "${!g_name[@]}"; do
  # shellcheck disable=SC2086
  files=$(match_files ${g_globs[$i]})
  if [[ -z $files ]]; then
    echo "group ${g_name[$i]} matches no tracked file: ${g_globs[$i]}" >&2
    fail=1
  fi
  printf '%s\n' "$files" >>"$covered"
done

listed=$(mktemp)
trap 'rm -f "$covered" "$listed"' EXIT
if [[ -f $notin ]]; then
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == '#'* ]] && continue
    path=${line%%"$tab"*}
    reason=${line#*"$tab"}
    if [[ $line != *"$tab"* || -z $path || -z ${reason//[[:space:]]/} ]]; then
      echo "not-in-gate list: a line needs path<TAB>reason: $line" >&2
      fail=1
      continue
    fi
    if [[ -z $(git -C "$root" ls-files -- "$path") ]]; then
      echo "not-in-gate list: $path is not a tracked file any more (remove the line)" >&2
      fail=1
    elif grep -qxF -- "$path" "$covered"; then
      echo "not-in-gate list: $path is already run by a gate job (remove the line)" >&2
      fail=1
    fi
    printf '%s\n' "$path" >>"$listed"
  done <"$notin"
fi

# The list is a count that may only fall. Adding a line takes a test file out of the gate, which is not a change a
# merge can make on its own: CI fails on every added line, and such a commit ships only with the owner's logged
# override of scripts/require-ci-green.sh. Removing a line is always fine.
if [[ -n $base ]]; then
  if git -C "$root" cat-file -e "$base:scripts/js-tests-not-in-gate.txt" 2>/dev/null; then
    baselist=$(mktemp)
    trap 'rm -f "$covered" "$listed" "$baselist"' EXIT
    while IFS= read -r line || [[ -n $line ]]; do
      [[ -z $line || $line == '#'* ]] && continue
      printf '%s\n' "${line%%"$tab"*}" >>"$baselist"
    done < <(git -C "$root" show "$base:scripts/js-tests-not-in-gate.txt")
    while IFS= read -r path; do
      grep -qxF -- "$path" "$baselist" && continue
      echo "not-in-gate list: $path was taken out of the gate at $base: an added line. CI fails on every added line; it ships only with the owner's logged override of scripts/require-ci-green.sh" >&2
      fail=1
    done <"$listed"
  else
    echo "js-test-inventory: $base has no scripts/js-tests-not-in-gate.txt, so every line counts as already there" >&2
  fi
fi

total=0; missing=()
while IFS= read -r f; do
  total=$((total + 1))
  grep -qxF -- "$f" "$covered" && continue
  grep -qxF -- "$f" "$listed" && continue
  missing+=("$f")
done < <(git -C "$root" ls-files | grep -E "$test_re" || true)

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "test files that no gate job runs and that are not listed in scripts/js-tests-not-in-gate.txt:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  fail=1
fi
if [[ $fail -ne 0 ]]; then exit 1; fi
echo "js-test-inventory: $total test files, all run by a gate job or listed with a reason"
