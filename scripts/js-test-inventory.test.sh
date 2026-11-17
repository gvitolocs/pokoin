#!/usr/bin/env bash
# Proves scripts/js-test-inventory.sh on a throwaway repository: a covered file passes, an uncovered one fails, a listed
# one passes, a stale list line fails (and a few neighbours). Run: bash scripts/js-test-inventory.test.sh
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script="$here/js-test-inventory.sh"
work=$(mktemp -d "${TMPDIR:-/tmp}/js-inventory-test.XXXXXX")
trap 'rm -rf "$work"' EXIT

tab=$'\t'
n=0; failed=0
expect() { # expect <exit code wanted> <name> <stderr pattern or ''>
  local want=$1 name=$2 pat=$3 rc=0 err
  err=$(cd "$work" && bash "$script" 2>&1 >/dev/null) || rc=$?
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

echo "$((n - failed))/$n passed"
[[ $failed -eq 0 ]]
