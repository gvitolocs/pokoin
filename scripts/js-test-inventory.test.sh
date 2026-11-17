#!/usr/bin/env bash
# Proves scripts/js-test-inventory.sh on a throwaway repository: a covered file passes, an uncovered one fails, a listed
# one passes, a stale list line fails (and a few neighbours), and with --base that the list grew by a line.
# Run: bash scripts/js-test-inventory.test.sh
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script="$here/js-test-inventory.sh"
work=$(mktemp -d "${TMPDIR:-/tmp}/js-inventory-test.XXXXXX")
trap 'rm -rf "$work"' EXIT

tab=$'\t'
n=0; failed=0
expect() { # expect <exit code wanted> <name> <stderr pattern or ''> [inventory args…]
  local want=$1 name=$2 pat=$3 err rc=0
  shift 3
  err=$(cd "${RUNDIR:-$work}" && bash "$script" "$@" 2>&1 >/dev/null) || rc=$?
  n=$((n + 1))
  if [[ $rc -ne $want ]] || { [[ -n $pat ]] && ! grep -qF -- "$pat" <<<"$err"; }; then
    echo "FAIL $name: exit $rc (wanted $want), stderr: $err" >&2
    failed=$((failed + 1))
  else
    echo "ok $name"
  fi
}

cd "$work"
git init -q .
git config user.email t@example.invalid; git config user.name t
mkdir -p scripts a/src a/src/deep b
printf 'g1%sa%snode --test%sa/src/*.test.js\n' "$tab" "$tab" "$tab" >scripts/js-test-groups.txt
: >scripts/js-tests-not-in-gate.txt
touch a/src/one.test.js a/src/deep/two.test.mjs a/src/not-a-test.js
git add -A

expect 1 "nested file not matched by a single * glob" "a/src/deep/two.test.mjs"
printf 'g1%sa%snode --test%sa/src/**/*.test.* !a/src/skip.test.js\n' "$tab" "$tab" "$tab" >scripts/js-test-groups.txt
git add -A
expect 0 "covered files pass (** matches zero or more directories)" ""

touch b/orphan.test.ts; git add -A
expect 1 "an uncovered test file fails and is named" "b/orphan.test.ts"

printf 'b/orphan.test.ts%sneeds a browser farm\n' "$tab" >scripts/js-tests-not-in-gate.txt
expect 0 "a listed file passes" ""

printf 'b/orphan.test.ts%sneeds a browser farm\nb/gone.test.ts%sneeds a database\n' "$tab" "$tab" >scripts/js-tests-not-in-gate.txt
expect 1 "a stale list line (file does not exist) fails" "b/gone.test.ts"

printf 'b/orphan.test.ts\n' >scripts/js-tests-not-in-gate.txt
expect 1 "a list line without a reason fails" "path<TAB>reason"

printf 'b/orphan.test.ts%sx\na/src/one.test.js%sredundant\n' "$tab" "$tab" >scripts/js-tests-not-in-gate.txt
expect 1 "a listed file that a job already runs fails" "already run by a gate job"

printf '%s\n' "b/orphan.test.ts${tab}x" >scripts/js-tests-not-in-gate.txt
printf 'g1%sa%snode --test%sa/src/*.test.js nothing/*.test.js\ng2%sa%snode --test%snothing/*.test.js\n' "$tab" "$tab" "$tab" "$tab" "$tab" "$tab" >scripts/js-test-groups.txt
expect 1 "a group that matches no file fails" "group g2 matches no tracked file"

printf 'g1%sa%snode --test%sa/src/**/*.test.* !a/src/skip.test.js\n' "$tab" "$tab" "$tab" >scripts/js-test-groups.txt
files=$(bash "$script" --files g1)
n=$((n + 1))
if [[ $files == $'a/src/deep/two.test.mjs\na/src/one.test.js' ]]; then echo "ok --files lists the group files"; else echo "FAIL --files: $files" >&2; failed=$((failed + 1)); fi

# --base: the not-in-gate list is a count that may only fall. Its own repository, because these cases need a history.
fresh=$work/list-count
mkdir -p "$fresh/scripts" "$fresh/a" "$fresh/b"
(
  cd "$fresh"
  git init -q .
  git config user.email t@example.invalid; git config user.name t
  printf 'g1%sa%snode --test%sa/*.test.js\n' "$tab" "$tab" "$tab" >scripts/js-test-groups.txt
  touch a/one.test.js
  git add -A
  git commit -qm "groups file, no list file"
) >/dev/null 2>&1
RUNDIR=$fresh

# The two listed files are under b/, outside the a/*.test.js glob: a listed file that a job already runs is a different error.
touch "$fresh/b/farm.test.js"
printf 'b/farm.test.js%sneeds a browser farm\n' "$tab" >"$fresh/scripts/js-tests-not-in-gate.txt"
git -C "$fresh" add -A
expect 0 "no list at the base, so every line counts as already there" "" --base HEAD

git -C "$fresh" commit -qm "one line"
touch "$fresh/b/model.test.js"
printf 'b/model.test.js%sneeds the pinned toolchain\n' "$tab" >>"$fresh/scripts/js-tests-not-in-gate.txt"
git -C "$fresh" add -A
git -C "$fresh" commit -qm "second line"
expect 1 "an added list line against a base that lacks it fails" "taken out of the gate" --base HEAD~1

git -C "$fresh" rm -q b/model.test.js
printf 'b/farm.test.js%sneeds a browser farm\n' "$tab" >"$fresh/scripts/js-tests-not-in-gate.txt"
git -C "$fresh" add -A
expect 0 "a removed list line is always fine" "" --base HEAD
RUNDIR=

echo "$((n - failed))/$n passed"
[[ $failed -eq 0 ]]
