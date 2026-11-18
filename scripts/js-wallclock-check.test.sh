#!/usr/bin/env bash
# Proves scripts/js-wallclock-check.sh on a throwaway repository: an unlisted budget fails, a listed one passes, the
# list's own rules fail (short reason, stale line, untracked path), a budget of 1000 ms or more is not a finding, a
# budget that is a variable is not a finding, and with --base that the list grew by a line.
# Run: bash scripts/js-wallclock-check.test.sh
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script="$here/js-wallclock-check.sh"
work=$(mktemp -d "${TMPDIR:-/tmp}/js-wallclock-test.XXXXXX")
trap 'rm -rf "$work"' EXIT

tab=$'\t'
n=0; failed=0
expect() { # expect <exit code wanted> <name> <stderr pattern or ''> [check args…]
  local want=$1 name=$2 pat=$3 err rc=0
  shift 3
  err=$(cd "$work" && bash "$script" "$@" 2>&1 >/dev/null) || rc=$?
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
mkdir -p scripts a
: >scripts/js-wallclock-allowed.txt
touch a/none.test.js
git add -A

expect 0 "a repository with no wall-clock budget passes" ""

# performance.now() against a literal below 1000 in an assert.ok.
cat >a/one.test.js <<'EOF'
import assert from 'node:assert/strict';
const started = performance.now();
assert.ok(performance.now() - started < 20, 'a speed budget');
EOF
git add -A
expect 1 "an unlisted performance.now budget fails and is named" "a/one.test.js:3"

printf 'a/one.test.js:3%sthe race marker of a fake timer, not a speed budget\n' "$tab" >scripts/js-wallclock-allowed.txt
git add -A
expect 0 "a listed budget passes" ""

printf 'a/one.test.js:3%stoo short\n' "$tab" >scripts/js-wallclock-allowed.txt
expect 1 "a reason under 15 characters fails" "at least 15 characters"

printf 'a/one.test.js:9%san honest reason, long enough\n' "$tab" >scripts/js-wallclock-allowed.txt
expect 1 "a list line for a line that is not a budget fails" "not a wall-clock budget any more"

printf 'a/gone.test.js:3%san honest reason, long enough\n' "$tab" >scripts/js-wallclock-allowed.txt
expect 1 "a list line for a file that is not tracked fails" "not a tracked file"

printf 'a/one.test.js%snot a path:line\n' "$tab" >scripts/js-wallclock-allowed.txt
expect 1 "a list line without path:line fails" "path:line"

printf 'a/one.test.js:3%san honest reason, long enough\n' "$tab" >scripts/js-wallclock-allowed.txt

# One second or more is the ceiling this rule hands to the code itself, not to the list.
cat >a/big.test.js <<'EOF'
import assert from 'node:assert/strict';
const started = performance.now();
assert.ok(performance.now() - started < 1500, 'a whole second');
assert(Date.now() - started <= 5_000);
EOF
git add -A
expect 0 "a budget of 1000 ms or more is not a finding" ""

# Date.now() in a bare assert(), and a budget that is a variable (the calibrated form).
cat >a/date.test.js <<'EOF'
import assert from 'node:assert/strict';
const started = Date.now();
assert(Date.now() - started <= 300, 'a slow store lost the race');
EOF
cat >a/variable.test.js <<'EOF'
import assert from 'node:assert/strict';
const budgetMs = 48;
assert.ok(localMs <= budgetMs && localMs < CEILING_MS, 'calibrated, so the host is not the finding');
EOF
git add -A
expect 1 "a Date.now budget in a bare assert fails" "a/date.test.js:3"

# Listed, so the cases after it are about their own line only.
printf 'a/one.test.js:3%sa fake timer marker, not a speed budget\na/date.test.js:3%sa slow fake store lost the race\n' "$tab" "$tab" >scripts/js-wallclock-allowed.txt
expect 0 "an assert of a budget variable is not a wall-clock budget" ""

# Only test files are read.
cat >a/helper.js <<'EOF'
import assert from 'node:assert/strict';
const started = performance.now();
assert.ok(performance.now() - started < 20, 'not a test file');
EOF
git add -A
expect 0 "a non-test file is not scanned" ""

# --base: the list is a count that may only fall. Its own repository, because these cases need a history.
# `-c core.hooksPath=` because a host may inject one through GIT_CONFIG_KEY_0/VALUE_0 (the Paseo lane does), and this
# throwaway repository is not the checkout that hook is there to protect.
fresh=$work/list-count
mkdir -p "$fresh/scripts" "$fresh/a"
(
  cd "$fresh"
  git init -q .
  git config user.email t@example.invalid; git config user.name t
  cat >a/one.test.js <<'EOF'
import assert from 'node:assert/strict';
const started = performance.now();
assert.ok(performance.now() - started < 20, 'a speed budget');
EOF
  cat >a/two.test.js <<'EOF'
import assert from 'node:assert/strict';
const started = Date.now();
assert.ok(Date.now() - started < 40, 'another speed budget');
EOF
  git add -A
  git -c core.hooksPath= commit -qm "two budgets, no list file"
) >/dev/null 2>&1

list() { printf 'a/one.test.js:3%san honest reason, long enough\na/two.test.js:3%san honest reason, long enough\n' "$tab" "$tab" >"$fresh/scripts/js-wallclock-allowed.txt"; }
CHECK() { # CHECK <exit> <name> <pattern> <args…>
  local want=$1 name=$2 pat=$3 err rc=0
  shift 3
  err=$(cd "$fresh" && bash "$script" "$@" 2>&1 >/dev/null) || rc=$?
  n=$((n + 1))
  if [[ $rc -ne $want ]] || { [[ -n $pat ]] && ! grep -qF -- "$pat" <<<"$err"; }; then
    echo "FAIL $name: exit $rc (wanted $want), stderr: $err" >&2
    failed=$((failed + 1))
  else
    echo "ok $name"
  fi
}

list
git -C "$fresh" add -A
CHECK 0 "no list at the base, so every line counts as already there" "" --base HEAD

git -C "$fresh" -c core.hooksPath= commit -qm "both lines listed"
git -C "$fresh" rm -q a/two.test.js
printf 'a/one.test.js:3%san honest reason, long enough\n' "$tab" >"$fresh/scripts/js-wallclock-allowed.txt"
git -C "$fresh" add -A && git -C "$fresh" -c core.hooksPath= commit -qm "one line retired"
CHECK 0 "a removed list line is always fine" "" --base HEAD~1

list
git -C "$fresh" add -A && git -C "$fresh" -c core.hooksPath= commit -qm "the line comes back"
CHECK 1 "an added list line against a base that lacks it fails" "was not in the list at" --base HEAD~1

echo "$((n - failed))/$n passed"
[[ $failed -eq 0 ]]
