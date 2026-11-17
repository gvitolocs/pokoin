#!/usr/bin/env bash
# Run: bash scripts/require-ci-green.test.sh
# Runs scripts/require-ci-green.sh against a throwaway git repo and a fake `gh` that applies the script's own --jq
# filter (real jq) to JSON fixtures. scripts/testdata/check-runs/main-b757cc1a.json is a real GitHub answer; the
# other fixtures are edited copies of it. The repo's origin/main holds the very files the gate compares itself
# with, so the self-check passes for every case except the ones that edit a file on purpose (16).
# No network; everything lives in one temp dir.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
gate_real="$here/require-ci-green.sh"
gate="$gate_real"
real="$here/testdata/check-runs/main-b757cc1a.json"
t="$(mktemp -d)"
trap 'rm -rf "$t"' EXIT

fail() {
  echo "FAIL: $*" >&2
  if [ -f "$t/out" ]; then sed 's/^/  | /' "$t/out" >&2; fi
  exit 1
}
ok() { echo "ok: $*"; }

# core.hooksPath is forced empty: a host that sets it globally (scripts/setup-git-hooks.sh, or a CI lane that wraps
# this repository's own hooks) would run the canonical-checkout guard inside every throwaway fixture below and refuse
# its base commit, because a fresh `git init` is a main work tree.
gitq() { git -c user.name=t -c user.email=t@example.invalid -c core.hooksPath= "$@"; }

# throwaway repo: one commit with the two-name list, one without a list, one with a comments-only list, one with rust-gate only
# The gate compares this checkout's own scripts with origin/main before it does anything else, so the repo gets an
# origin remote holding the gate script, the required-check list and one caller; the working copies stay identical
# to it, except inside the self-check cases (16), which edit one file and put it back.
gitq init -q --bare "$t/origin.git"
gitq init -q "$t/repo"
gitq -C "$t/repo" symbolic-ref HEAD refs/heads/main
gitq -C "$t/repo" remote add origin "$t/origin.git"
mkdir -p "$t/repo/scripts"
cp "$gate_real" "$t/repo/scripts/require-ci-green.sh"
cat > "$t/repo/scripts/fake-caller.sh" << 'C'
#!/usr/bin/env bash
# stands for a deploy entry point given to --caller-script
echo fake-caller
C
printf '# header comment\nrust-gate\n\n  repo-gate  # trailing comment\n' > "$t/repo/scripts/ci-required-checks"
echo x > "$t/repo/f"
gitq -C "$t/repo" add -A
gitq -C "$t/repo" commit -q -m two-names
SHA_TWO="$(gitq -C "$t/repo" rev-parse HEAD)"
gitq -C "$t/repo" rm -q scripts/ci-required-checks
gitq -C "$t/repo" commit -q -m no-list
SHA_NONE="$(gitq -C "$t/repo" rev-parse HEAD)"
mkdir -p "$t/repo/scripts"
printf '# nothing here\n\n   \n' > "$t/repo/scripts/ci-required-checks"
gitq -C "$t/repo" add -A
gitq -C "$t/repo" commit -q -m comments-only
SHA_EMPTY="$(gitq -C "$t/repo" rev-parse HEAD)"
printf 'rust-gate\n' > "$t/repo/scripts/ci-required-checks"
gitq -C "$t/repo" add -A
gitq -C "$t/repo" commit -q -m rust-only
SHA_RUST="$(gitq -C "$t/repo" rev-parse HEAD)"
# the working tree back to the two-names state, and that state published as origin/main: from here on every file
# the gate compares is byte-identical to origin/main's, so the cases above behave exactly as they did before.
gitq -C "$t/repo" checkout -q "$SHA_TWO" -- scripts/ci-required-checks
gitq -C "$t/repo" commit -q -m back-to-two-names
gitq -C "$t/repo" push -q origin main
gate="$t/repo/scripts/require-ci-green.sh"
for f in require-ci-green.sh ci-required-checks fake-caller.sh; do
  cp "$t/repo/scripts/$f" "$t/pristine-$f"
done

# fake gh: appends its arguments to $FAKE_GH_CALLS, applies the --jq argument to a fixture with real jq.
cat > "$t/gh" << 'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_GH_CALLS"
n=$(wc -l < "$FAKE_GH_CALLS")
case "${FAKE_GH_MODE:-}" in
  failn) if [ "$n" -le "${FAKE_GH_FAILS:-0}" ]; then echo "gh: HTTP 502" >&2; exit 1; fi ;;
  exit1) echo "gh: HTTP 502" >&2; exit 1 ;;
  failn) if [ "$n" -le "${FAKE_GH_FAILS:-0}" ]; then echo "gh: HTTP 502" >&2; exit 1; fi ;;
  http404) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  http422)
    # the answer gh really gives for a sha it has never seen, with the sha of the endpoint it was asked about
    ep=
    for a in "$@"; do case "$a" in */check-runs*) ep="$a" ;; esac; done
    echo "gh: No commit found for SHA: $(printf '%s' "$ep" | sed 's|.*/commits/||; s|/.*||') (HTTP 422)" >&2
    exit 1 ;;
  garbage) echo "this is not a check run"; exit 0 ;;
  halfrow) printf '12345\tonly-two\n'; exit 0 ;;
esac
filter=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--jq" ]; then filter="$a"; fi
  prev="$a"
done
f="$FAKE_GH_FIXTURE"
if [ "$n" -gt 1 ] && [ -n "${FAKE_GH_FIXTURE2:-}" ]; then f="$FAKE_GH_FIXTURE2"; fi
jq -r "$filter" "$f"
FAKE
# fake ops command: records its stdin
cat > "$t/ops" << 'FAKE'
#!/usr/bin/env bash
cat > "$OPS_IN"
FAKE
cat > "$t/ops-fail" << 'FAKE'
#!/usr/bin/env bash
cat > /dev/null
exit 1
FAKE
chmod +x "$t/gh" "$t/ops" "$t/ops-fail"

# fixtures: edited copies of the real answer (rust-gate is success there; repo-gate does not exist yet)
# `green` stands for every required check green, so it carries a success run for each name of the real list the
# real answer lacks; the throwaway repo above requires only rust-gate and repo-gate, so js-gate never decides a case.
add_run() { # id name status conclusion slug
  jq --argjson id "$1" --arg name "$2" --arg status "$3" --arg c "$4" --arg slug "$5" \
    '.check_runs += [{id:$id,name:$name,status:$status,conclusion:(if $c=="null" then null else $c end),app:{slug:$slug}}]'
}
fx() { cat > "$t/fx-$1.json"; }
jq . "$real" > /dev/null || fail "the real fixture is not JSON"
jq -e '[.check_runs[]|select(.name=="rust-gate" and .conclusion=="success")]|length==1' "$real" > /dev/null \
  || fail "the real fixture should have rust-gate success"
add_run 200000000001 repo-gate completed success github-actions < "$real" | add_run 200000000003 js-gate completed success github-actions | fx green
add_run 200000000001 repo-gate completed failure github-actions < "$real" | fx repofail
add_run 200000000001 repo-gate in_progress null github-actions < "$real" | fx running
# old failure + newer success: rust-gate failure id 50, success id 100 (the real run, renumbered)
jq '(.check_runs[]|select(.name=="rust-gate")|.id) = 100' "$real" | add_run 50 rust-gate completed failure github-actions | add_run 200000000001 repo-gate completed success github-actions | fx oldfail-newok
# old success + newer failure: success id 100, failure id 300
jq '(.check_runs[]|select(.name=="rust-gate")|.id) = 100' "$real" | add_run 300 rust-gate completed failure github-actions | add_run 200000000001 repo-gate completed success github-actions | fx oldok-newfail
# a foreign app with the right name and success while the github-actions one failed
add_run 200000000001 repo-gate completed failure github-actions < "$real" | add_run 200000000009 repo-gate completed success some-other-app | fx foreign-and-fail
# only a foreign repo-gate
add_run 200000000009 repo-gate completed success some-other-app < "$real" | fx foreign-only
for c in cancelled skipped timed_out neutral action_required stale; do
  add_run 200000000001 repo-gate completed "$c" github-actions < "$real" | fx "concl-$c"
done

calls="$t/calls"
export FAKE_GH_CALLS="$calls" OPS_IN="$t/ops-in"
export POKOIN_CI_POLL_S=0.2 POKOIN_CI_WAIT_S=2 POKOIN_CI_MISSING_GRACE_S=1
LOGF="$t/ci.log"
export POKOIN_CI_LOG="$LOGF"
unset POKOIN_CI_OVERRIDE LANE_WORKER POKOIN_OPS_RECORD_CMD FAKE_GH_MODE FAKE_GH_FIXTURE2 || true

# Case 17 aims the gate at canonical checkouts of its own. Every other case must say nothing about them, so
# POKOIN_CANONICAL_CHECKOUT is aimed at a clean throwaway repository here: on a host whose real integration checkout
# is dirty, the other cases would otherwise each carry a warning block.
gitq init -q "$t/canon-silent"
printf 'x\n' > "$t/canon-silent/f.txt"
gitq -C "$t/canon-silent" add f.txt
gitq -C "$t/canon-silent" commit -q -m base
export POKOIN_CANONICAL_CHECKOUT="$t/canon-silent"

rc=0
run_gate() { # args...: runs the gate with the fake gh, output in $t/out, exit code in $rc
  rm -f "$calls" "$t/ops-in"
  : > "$calls"
  rc=0
  env GH="${GH_OVERRIDE:-$t/gh}" bash "$gate" --repo-dir "$t/repo" "$@" > "$t/out" 2>&1 || rc=$?
}
want_rc() { [ "$rc" = "$1" ] || fail "$2: expected exit $1, got $rc"; }
has() { grep -qF -- "$1" "$t/out" || fail "$2: output lacks '$1'"; }
hasnt() { if grep -qF -- "$1" "$t/out"; then fail "$2: output has '$1'"; fi; }
NOTE="An agent never sets it (worker environments do not pass it): if you are an agent, stop and report."

# 1. every required check green
FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 0 "1 green"
has "rust-gate success (run 134049989018)" "1"
has "repo-gate success (run 200000000001)" "1"
has "green: rust-gate repo-gate" "1"
ok "1: all required checks success -> 0"

# 2. one failure
FAKE_GH_FIXTURE="$t/fx-repofail.json" run_gate "$SHA_TWO"
want_rc 1 "2 failure"
has "REFUSED" "2"
has "repo-gate finished as failure (run 200000000001)" "2"
has "$NOTE" "2"
ok "2: one failure -> 1, names the check"

# 3. a required check absent past the grace (rust-gate only exists; repo-gate never appears)
FAKE_GH_FIXTURE="$real" POKOIN_CI_WAIT_S=10 run_gate "$SHA_TWO"
want_rc 1 "3 absent"
has "no repo-gate check run on ${SHA_TWO:0:12}" "3"
ok "3: absent past the grace -> 1"

# 4. in_progress, then success on the second poll
FAKE_GH_FIXTURE="$t/fx-running.json" FAKE_GH_FIXTURE2="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 0 "4 waits"
has "waiting" "4"
has "repo-gate (in_progress)" "4"
[ "$(wc -l < "$calls")" -ge 2 ] || fail "4: gh was called only once"
ok "4: in_progress then success -> waits, 0"

# 5. in_progress until the wait limit
FAKE_GH_FIXTURE="$t/fx-running.json" POKOIN_CI_WAIT_S=1 run_gate "$SHA_TWO"
want_rc 1 "5 wait limit"
has "still not green after" "5"
ok "5: in_progress until POKOIN_CI_WAIT_S -> 1"

# 6. the newest run decides
FAKE_GH_FIXTURE="$t/fx-oldok-newfail.json" run_gate "$SHA_TWO"
want_rc 1 "6a"
has "rust-gate finished as failure (run 300)" "6a"
FAKE_GH_FIXTURE="$t/fx-oldfail-newok.json" run_gate "$SHA_TWO"
want_rc 0 "6b"
has "rust-gate success (run 100)" "6b"
ok "6: old success + newer failure -> 1; old failure + newer success -> 0"

# 7. another app's check run does not count
FAKE_GH_FIXTURE="$t/fx-foreign-and-fail.json" run_gate "$SHA_TWO"
want_rc 1 "7a"
has "repo-gate finished as failure (run 200000000001)" "7a"
FAKE_GH_FIXTURE="$t/fx-foreign-only.json" POKOIN_CI_WAIT_S=10 run_gate "$SHA_TWO"
want_rc 1 "7b"
has "no repo-gate check run" "7b"
ok "7: a foreign app's success never counts"

# 8. every conclusion that is not success
for c in cancelled skipped timed_out neutral action_required stale; do
  FAKE_GH_FIXTURE="$t/fx-concl-$c.json" run_gate "$SHA_TWO"
  want_rc 1 "8 $c"
  has "repo-gate finished as $c" "8 $c"
done
ok "8: cancelled, skipped, timed_out, neutral, action_required, stale -> 1"

# 9. gh fails, gh prints garbage, gh prints a short row
calls_n() { wc -l < "$calls" | tr -d ' '; }
FAKE_GH_MODE=exit1 FAKE_GH_FIXTURE="$t/fx-green.json" POKOIN_CI_API_RETRIES=3 POKOIN_CI_WAIT_S=1000 run_gate "$SHA_TWO"
want_rc 1 "9a gh exits 1"
has "could not be read" "9a"
[ "$(calls_n)" = 3 ] || fail "9a: expected exactly 3 gh calls, got $(calls_n)"
FAKE_GH_MODE=garbage FAKE_GH_FIXTURE="$t/fx-green.json" POKOIN_CI_API_RETRIES=3 POKOIN_CI_WAIT_S=1000 run_gate "$SHA_TWO"
want_rc 1 "9b garbage"
has "could not be read" "9b"
[ "$(calls_n)" = 3 ] || fail "9b: expected exactly 3 gh calls, got $(calls_n)"
FAKE_GH_MODE=halfrow FAKE_GH_FIXTURE="$t/fx-green.json" POKOIN_CI_API_RETRIES=3 POKOIN_CI_WAIT_S=1000 run_gate "$SHA_TWO"
want_rc 1 "9c half row"
ok "9: gh error, garbage and a short row -> 1 after the retry count, never 0"

# 9d. the default retry count is 5, well before a large wait limit
s0=$SECONDS
FAKE_GH_MODE=exit1 FAKE_GH_FIXTURE="$t/fx-green.json" POKOIN_CI_WAIT_S=1000 run_gate "$SHA_TWO"
want_rc 1 "9d default retries"
[ "$(calls_n)" = 5 ] || fail "9d: expected exactly 5 gh calls, got $(calls_n)"
[ $((SECONDS - s0)) -lt 10 ] || fail "9d: it waited for the wait limit"
# 9e. fail, fail, then a good answer -> 0 (a readable answer resets the count)
FAKE_GH_MODE=failn FAKE_GH_FAILS=2 FAKE_GH_FIXTURE="$t/fx-green.json" POKOIN_CI_API_RETRIES=3 POKOIN_CI_WAIT_S=1000 run_gate "$SHA_TWO"
want_rc 0 "9e fail, fail, ok"
# 9f. --no-wait refuses on the first unreadable answer
FAKE_GH_MODE=exit1 FAKE_GH_FIXTURE="$t/fx-green.json" run_gate --no-wait "$SHA_TWO"
want_rc 1 "9f no-wait"
[ "$(calls_n)" = 1 ] || fail "9f: expected 1 gh call, got $(calls_n)"
ok "9: default 5 retries, fail-fail-then-good gives 0, --no-wait refuses on the first unreadable answer"

# 9g. finding gh: a missing binary refuses at once; HOME/.local/bin/gh is used when gh is not on PATH
s0=$SECONDS
GH_OVERRIDE=/nonexistent/gh FAKE_GH_FIXTURE="$t/fx-green.json" POKOIN_CI_WAIT_S=1000 run_gate "$SHA_TWO"
want_rc 1 "9g missing gh"
[ $((SECONDS - s0)) -lt 2 ] || fail "9g: the missing gh was waited on"
has "cannot find the gh binary (GH=/nonexistent/gh)" "9g"
mkdir -p "$t/home/.local/bin" "$t/toolbin"
cp "$t/gh" "$t/home/.local/bin/gh"
for tool in git jq date sleep dirname mkdir tr printf cat id hostname wc sed awk bash env; do
  p="$(command -v "$tool" || true)"
  if [ -n "$p" ] && [ "${p#/}" != "$p" ]; then ln -sf "$p" "$t/toolbin/$tool"; fi
done
rc=0
rm -f "$calls"
: > "$calls"
env -u GH HOME="$t/home" PATH="$t/toolbin" FAKE_GH_FIXTURE="$t/fx-green.json" bash "$gate" --repo-dir "$t/repo" "$SHA_TWO" > "$t/out" 2>&1 || rc=$?
want_rc 0 "9h HOME/.local/bin/gh"
[ "$(calls_n)" -ge 1 ] || fail "9h: the fake gh in HOME/.local/bin was not called"
rm -f "$t/home/.local/bin/gh"
rc=0
env -u GH HOME="$t/home" PATH="$t/toolbin" FAKE_GH_FIXTURE="$t/fx-green.json" bash "$gate" --repo-dir "$t/repo" "$SHA_TWO" > "$t/out" 2>&1 || rc=$?
want_rc 1 "9i no gh anywhere"
has "cannot find the gh binary (gh not on PATH;" "9i"
ok "9: missing gh refuses at once; \$HOME/.local/bin/gh is used when gh is not on PATH"

# 9j. GitHub has never seen the commit: gh api answers 404 or 422 for its check-runs URL. Retrying cannot make such an
#     answer readable, so the gate refuses at once and says what is wrong (the commit is local only) instead of
#     reporting an unreadable API. Any other failure keeps retrying (9a, 9d, 9e).
NOTPUSHED="GitHub has no commit ${SHA_TWO:0:12}: it was never pushed. Push a branch and open a pull request."
for mode in http404 http422; do
  s0=$SECONDS
  FAKE_GH_MODE=$mode FAKE_GH_FIXTURE="$t/fx-green.json" POKOIN_CI_API_RETRIES=5 POKOIN_CI_WAIT_S=1000 run_gate "$SHA_TWO"
  want_rc 1 "9j $mode"
  [ "$(calls_n)" = 1 ] || fail "9j $mode: expected exactly 1 gh call, got $(calls_n)"
  has "$NOTPUSHED" "9j $mode"
  hasnt "could not be read" "9j $mode"
  hasnt "waiting" "9j $mode"
  [ $((SECONDS - s0)) -lt 10 ] || fail "9j $mode: it waited instead of refusing at once"
done
# a 4xx on the same commit is not a green answer: nothing about the checks is claimed, and no advice to re-run a
# workflow is given for a commit that has never been on GitHub
hasnt "success (run" "9j 404"
hasnt "re-run the failed workflow" "9j 404"
# and a readable answer for that very commit is still green, so the refusal came from the HTTP code alone
FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 0 "9j readable answer again"
unset FAKE_GH_MODE
export POKOIN_CI_POLL_S=0.2 POKOIN_CI_WAIT_S=2 POKOIN_CI_MISSING_GRACE_S=1
ok "9j: gh api HTTP 404 and HTTP 422 -> 1 at once, one call only, 'GitHub has no commit <sha12>'"

# 10. list absent, list with only comments
FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_NONE"
want_rc 1 "10a no list"
has "no required-check list" "10a"
[ ! -s "$calls" ] || fail "10a: gh was called without a list"
FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_EMPTY"
want_rc 1 "10b empty list"
has "no required-check list" "10b"
ok "10: list file absent or comments only -> 1"

# 11. override: <full sha>:<reason>, a log line AND an ops record, never in a lane worker
GOODREASON="owner approved hotfix for checkout"
export POKOIN_OPS_RECORD_CMD="$t/ops"
rm -f "$LOGF"
POKOIN_CI_OVERRIDE="$SHA_TWO:$GOODREASON" POKOIN_CI_CALLER=test-caller FAKE_GH_FIXTURE="$t/fx-repofail.json" run_gate "$SHA_TWO"
want_rc 0 "11a override"
has "NOT checked" "11a"
[ ! -s "$calls" ] || fail "11a: gh was called during an override"
grep -qP '\toverride\t' "$LOGF" || fail "11a: the log has no override line"
grep -qF "$GOODREASON" "$LOGF" || fail "11a: the log lacks the reason"
[ -s "$t/ops-in" ] || fail "11a: the fake ops command got no input"
jq -e '.kind=="incident" and .project=="pokoin" and (.title|startswith("CI gate overridden for '"${SHA_TWO:0:12}"' by test-caller")) and (.body|contains("'"$SHA_TWO"'")) and (.body|contains("The required CI checks were not verified for this commit."))' "$t/ops-in" > /dev/null \
  || fail "11a: the ops record is not the expected JSON: $(cat "$t/ops-in")"
ok "11a: exact id + reason + working ops command -> 0, gh not called, log and ops record written"

POKOIN_CI_OVERRIDE="$SHA_TWO" FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 1 "11b no reason"
has "$NOTE" "11b"
POKOIN_CI_OVERRIDE="$SHA_TWO:short" FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 1 "11c short reason"
POKOIN_CI_OVERRIDE="$SHA_TWO:a reason with a \"quote\" in it" FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 1 "11d quote in reason"
POKOIN_CI_OVERRIDE="${SHA_TWO:0:12}:$GOODREASON" FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 1 "11e short sha"
POKOIN_CI_OVERRIDE="${SHA_NONE}:$GOODREASON" FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 1 "11f wrong sha"
has "full 40-hex" "11f"
has "$NOTE" "11f"
POKOIN_OPS_RECORD_CMD="$t/ops-fail" POKOIN_CI_OVERRIDE="$SHA_TWO:$GOODREASON" FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 1 "11g ops fails"
has "ops record could not be written" "11g"
echo plain > "$t/afile"
POKOIN_CI_LOG="$t/afile/sub/ci.log" POKOIN_CI_OVERRIDE="$SHA_TWO:$GOODREASON" FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 1 "11h log not writable"
has "log line could not be written" "11h"
[ ! -s "$t/ops-in" ] || fail "11h: the ops record was written although the log failed"
LANE_WORKER=1 POKOIN_CI_OVERRIDE="$SHA_TWO:$GOODREASON" FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 1 "11i lane worker"
has "lane worker" "11i"
has "$NOTE" "11i"
unset POKOIN_OPS_RECORD_CMD
ok "11: override without a reason, short reason, quote, short or wrong id, failing ops command, unwritable log, lane worker -> 1"

# 12. --no-wait: a running check is a refusal at once, without sleeping
s0=$SECONDS
FAKE_GH_FIXTURE="$t/fx-running.json" POKOIN_CI_POLL_S=30 POKOIN_CI_WAIT_S=100 run_gate --no-wait "$SHA_TWO"
[ $((SECONDS - s0)) -lt 5 ] || fail "12: --no-wait slept"
want_rc 1 "12 no-wait"
has "--no-wait" "12"
FAKE_GH_FIXTURE="$real" POKOIN_CI_POLL_S=30 POKOIN_CI_MISSING_GRACE_S=1000 run_gate --no-wait "$SHA_TWO"
want_rc 1 "12b no-wait missing"
has "no repo-gate check run" "12b"
ok "12: --no-wait refuses at once, missing runs included"

# 13. the log: one line for a green run, one for a refused run
rm -f "$LOGF"
FAKE_GH_FIXTURE="$t/fx-green.json" POKOIN_CI_CALLER=caller-a run_gate "$SHA_TWO"
FAKE_GH_FIXTURE="$t/fx-repofail.json" POKOIN_CI_CALLER=caller-b run_gate "$SHA_TWO"
[ "$(wc -l < "$LOGF")" = 2 ] || fail "13: expected 2 log lines, got $(wc -l < "$LOGF")"
l1="$(sed -n 1p "$LOGF")"
l2="$(sed -n 2p "$LOGF")"
[ "$(printf '%s' "$l1" | awk -F'\t' '{print NF}')" = 5 ] || fail "13: line 1 is not 5 tab-separated fields: $l1"
[ "$(printf '%s' "$l1" | awk -F'\t' '{print $2 "|" $3 "|" $5}')" = "$SHA_TWO|green|caller-a" ] || fail "13: bad green line: $l1"
[ "$(printf '%s' "$l2" | awk -F'\t' '{print $2 "|" $3 "|" $5}')" = "$SHA_TWO|refused|caller-b" ] || fail "13: bad refused line: $l2"
ok "13: the log gets one line per run that ends"

# 14. the repository's own list
grep -qx 'rust-gate' "$here/ci-required-checks" || fail "14: scripts/ci-required-checks lacks rust-gate"
grep -qx 'repo-gate' "$here/ci-required-checks" || fail "14: scripts/ci-required-checks lacks repo-gate"
grep -qx 'secret-gate' "$here/ci-required-checks" || fail "14: scripts/ci-required-checks lacks secret-gate"
grep -qx 'js-gate' "$here/ci-required-checks" || fail "14: scripts/ci-required-checks lacks js-gate"
ok "14: scripts/ci-required-checks names rust-gate, repo-gate, secret-gate and js-gate"

# 15. the real answer, with rust-gate as the only required name
FAKE_GH_FIXTURE="$real" run_gate "$SHA_RUST"
want_rc 0 "15 real fixture"
has "rust-gate success (run 134049989018)" "15"
ok "15: the real GitHub answer, required rust-gate only -> 0"

# 16. the self-check: this checkout's gate script, the list next to it and every --caller-script must be
#     origin/main's, or nothing ships. None of these cases may reach GitHub, and the override may not skip them.
GATE_COPY="$gate"
LIST_COPY="$t/repo/scripts/ci-required-checks"
CALLER_COPY="$t/repo/scripts/fake-caller.sh"
NOT_ON_MAIN="this checkout's deploy scripts are not origin/main's"
rm -f "$LOGF"
printf '# edited\n' >> "$GATE_COPY"
POKOIN_CI_CALLER=caller-16 FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 1 "16a the gate script edited locally"
has "$NOT_ON_MAIN" "16a"
has "require-ci-green.sh" "16a"
has "This check has no override." "16a"
[ ! -s "$calls" ] || fail "16a: gh was called although the gate script is not origin/main's"
[ "$(wc -l < "$LOGF")" = 1 ] || fail "16a: expected one log line, got $(cat "$LOGF")"
[ "$(awk -F'\t' '{print $3 "|" $5}' "$LOGF")" = "refused|caller-16" ] || fail "16a: the log line is not the refusal: $(cat "$LOGF")"
cp "$t/pristine-require-ci-green.sh" "$GATE_COPY"
FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 0 "16a restored"
ok "16a: the gate's own file edited by one byte -> 1 before any gh call, logged as refused; put back -> 0"

printf 'made-up-gate\n' >> "$LIST_COPY"
FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 1 "16b the list edited locally"
has "$NOT_ON_MAIN" "16b"
has "ci-required-checks" "16b"
[ ! -s "$calls" ] || fail "16b: gh was called although the list is not origin/main's"
cp "$t/pristine-ci-required-checks" "$LIST_COPY"
FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 0 "16b restored"
ok "16b: the required-check list edited by one line -> 1, gh never called; put back -> 0"

printf '# edited\n' >> "$CALLER_COPY"
FAKE_GH_FIXTURE="$t/fx-green.json" run_gate --caller-script "$CALLER_COPY" "$SHA_TWO"
want_rc 1 "16c a caller script that differs"
has "$NOT_ON_MAIN" "16c"
has "fake-caller.sh" "16c"
[ ! -s "$calls" ] || fail "16c: gh was called although a caller script is not origin/main's"
cp "$t/pristine-fake-caller.sh" "$CALLER_COPY"
FAKE_GH_FIXTURE="$t/fx-green.json" run_gate --caller-script "$CALLER_COPY" "$SHA_TWO"
want_rc 0 "16c an identical caller script"
ok "16c: a --caller-script that differs -> 1; identical -> 0"

cp "$t/pristine-fake-caller.sh" "$t/repo/scripts/never-committed.sh"
FAKE_GH_FIXTURE="$t/fx-green.json" run_gate --caller-script "$t/repo/scripts/never-committed.sh" "$SHA_TWO"
want_rc 1 "16d a caller path origin/main does not have"
has "$NOT_ON_MAIN" "16d"
has "origin/main has no scripts/never-committed.sh" "16d"
[ ! -s "$calls" ] || fail "16d: gh was called for a caller origin/main does not have"
rm -f "$t/repo/scripts/never-committed.sh"
ok "16d: a --caller-script path origin/main does not have -> 1"

printf '# edited\n' >> "$GATE_COPY"
POKOIN_CI_OVERRIDE="$SHA_TWO:$GOODREASON" POKOIN_OPS_RECORD_CMD="$t/ops" FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 1 "16e the override does not skip the self-check"
has "$NOT_ON_MAIN" "16e"
hasnt "override accepted" "16e"
[ ! -s "$t/ops-in" ] || fail "16e: the ops record was written although the self-check refused"
[ ! -s "$calls" ] || fail "16e: gh was called"
cp "$t/pristine-require-ci-green.sh" "$GATE_COPY"
ok "16e: a correct override does not get past a differing script: 1, no ops record, no gh"

gitq init -q "$t/repo2"
mkdir -p "$t/repo2/scripts"
cp "$t/pristine-fake-caller.sh" "$t/repo2/scripts/fake-caller.sh"
gitq -C "$t/repo2" add -A
gitq -C "$t/repo2" commit -q -m other-repository
FAKE_GH_FIXTURE="$t/fx-green.json" run_gate --caller-script "$t/repo2/scripts/fake-caller.sh" "$SHA_TWO"
want_rc 1 "16f a caller script from another repository"
has "$NOT_ON_MAIN" "16f"
has "another repository" "16f"
[ ! -s "$calls" ] || fail "16f: gh was called for a caller of another repository"
cp "$t/pristine-fake-caller.sh" "$t/norepo-caller.sh"
FAKE_GH_FIXTURE="$t/fx-green.json" run_gate --caller-script "$t/norepo-caller.sh" "$SHA_TWO"
want_rc 1 "16g a caller script outside every repository"
has "$NOT_ON_MAIN" "16g"
ok "16f/g: a caller script that is not part of the repository being shipped -> 1"

# --no-wait without --caller-script (how a pre-push hook will call it) compares only the gate and the list
printf '# edited\n' >> "$CALLER_COPY"
FAKE_GH_FIXTURE="$t/fx-repofail.json" run_gate --no-wait "$SHA_TWO"
want_rc 1 "16h --no-wait without a caller script"
has "repo-gate finished as failure" "16h"
hasnt "$NOT_ON_MAIN" "16h"
cp "$t/pristine-fake-caller.sh" "$CALLER_COPY"
ok "16h: --no-wait without --caller-script refuses on CI, not on the untouched caller file"

# --self-check-only answers the comparison and nothing else: no commit, no gh, no log line
rm -f "$LOGF"
: > "$calls"
rc=0
GH="$t/gh" bash "$GATE_COPY" --self-check-only --repo-dir "$t/repo" --caller-script "$CALLER_COPY" > "$t/out" 2>&1 || rc=$?
want_rc 0 "16i --self-check-only identical"
[ ! -s "$calls" ] || fail "16i: gh was called in --self-check-only mode"
[ ! -e "$LOGF" ] || fail "16i: --self-check-only wrote a log line: $(cat "$LOGF")"
printf '# edited\n' >> "$GATE_COPY"
rc=0
GH="$t/gh" bash "$GATE_COPY" --self-check-only --repo-dir "$t/repo" --caller-script "$CALLER_COPY" > "$t/out" 2>&1 || rc=$?
want_rc 1 "16j --self-check-only differing"
has "$NOT_ON_MAIN" "16j"
hasnt "REFUSED" "16j"
[ ! -s "$calls" ] || fail "16j: gh was called in --self-check-only mode"
[ ! -e "$LOGF" ] || fail "16j: --self-check-only wrote a log line: $(cat "$LOGF")"
cp "$t/pristine-require-ci-green.sh" "$GATE_COPY"
ok "16i/j: --self-check-only gives 0 for identical files and 1 for a differing one, with no gh call, no log line and no commit"

# 16k. the environment a git hook really runs in: git exports GIT_DIR (absolute) and GIT_PREFIX when it calls a hook,
#      and .githooks/pre-push calls the gate with the current directory inside scripts/. With GIT_DIR set and no
#      GIT_WORK_TREE git takes the current directory as the top of the work tree, so the self-check's relative
#      `rev-parse --show-toplevel` answered <top level>/scripts, the compared path lost its scripts/ prefix, and the
#      gate refused its own file as "origin/main has no require-ci-green.sh" — every guarded push died there before
#      it asked GitHub anything (PKN-15). On an untouched tree it must pass.
rc=0
: > "$calls"
rm -f "$LOGF"
( cd "$t/repo/scripts" \
  && env GIT_DIR="$t/repo/.git" GIT_PREFIX=scripts/ GH="$t/gh" FAKE_GH_FIXTURE="$t/fx-green.json" \
       bash "$GATE_COPY" --repo-dir "$t/repo" --self-check-only > "$t/out" 2>&1 ) || rc=$?
want_rc 0 "16k GIT_DIR exported, cwd inside scripts/"
hasnt "has no require-ci-green.sh" "16k GIT_DIR exported, cwd inside scripts/"
hasnt "$NOT_ON_MAIN" "16k GIT_DIR exported, cwd inside scripts/"
[ ! -s "$calls" ] || fail "16k: gh was called in --self-check-only mode"
[ ! -e "$LOGF" ] || fail "16k: --self-check-only wrote a log line: $(cat "$LOGF")"
ok "16k: called as a hook calls it (GIT_DIR exported, cwd inside scripts/), an untouched tree passes its self-check -> 0"

# 17. the canonical checkout warning. The deploy entry points all run from the canonical integration checkout, so
#     uncommitted work there — left by a generator or by another agent — blocks its next fast-forward. The gate lists
#     it and nothing else changes: the result code is the CI answer, the log gains no line, and no file content is
#     printed. POKOIN_CANONICAL_CHECKOUT names the directory (the callers do not set it; see 17i for the fallback).
CANON_TEXT="the canonical checkout has uncommitted changes"
canon_new() { # canon_new <name>: a clean throwaway repository at $t/canon-<name>, its path in $CANON
  CANON="$t/canon-$1"
  gitq init -q "$CANON"
  printf 'tracked line\n' > "$CANON/f.txt"
  gitq -C "$CANON" add f.txt
  gitq -C "$CANON" commit -q -m base
}

# 17a. a clean canonical checkout says nothing
canon_new clean
POKOIN_CANONICAL_CHECKOUT="$CANON" FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 0 "17a clean"
hasnt "canonical checkout" "17a clean"

# 17b. a dirty one lists its entries and still ships, because the CI answer is green
canon_new dirty
printf 'written there by mistake\n' >> "$CANON/f.txt"
printf 'THE-CONTENT-OF-THE-DIRTY-FILE\n' > "$CANON/note.txt"
rm -f "$LOGF"
POKOIN_CANONICAL_CHECKOUT="$CANON" FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 0 "17b dirty"
has "$CANON_TEXT" "17b dirty"
has "$CANON" "17b dirty: names the directory"
has " M f.txt" "17b dirty"
has "?? note.txt" "17b dirty"
hasnt "THE-CONTENT-OF-THE-DIRTY-FILE" "17b dirty: printed the content of a file"
[ "$(wc -l < "$LOGF")" = 1 ] || fail "17b dirty: the warning changed the log: $(cat "$LOGF")"

# 17c. the one entry every work station has, on its own, says nothing. server/ holds a committed file: with nothing
#      else in it tracked, git collapses the entry to `?? server/` and the point of the case would be lost.
canon_new nm
mkdir -p "$CANON/server"
printf 'kept\n' > "$CANON/server/app.js"
gitq -C "$CANON" add server/app.js
gitq -C "$CANON" commit -q -m server
mkdir -p "$CANON/server/node_modules"
printf 'dep\n' > "$CANON/server/node_modules/pkg.js"
gitq -C "$CANON" status --porcelain > "$t/nm-status"
[ "$(cat "$t/nm-status")" = '?? server/node_modules/' ] \
  || fail "17c: the fixture does not hold exactly the known entry: $(cat "$t/nm-status")"
POKOIN_CANONICAL_CHECKOUT="$CANON" FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 0 "17c server/node_modules alone"
hasnt "canonical checkout" "17c server/node_modules alone"

# 17d. the known entry does not hide the others
canon_new nm-plus
mkdir -p "$CANON/server"
printf 'kept\n' > "$CANON/server/app.js"
gitq -C "$CANON" add server/app.js
gitq -C "$CANON" commit -q -m server
mkdir -p "$CANON/server/node_modules"
printf 'dep\n' > "$CANON/server/node_modules/pkg.js"
printf 'written there by mistake\n' >> "$CANON/f.txt"
POKOIN_CANONICAL_CHECKOUT="$CANON" FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 0 "17d server/node_modules plus a real change"
has "$CANON_TEXT" "17d"
has " M f.txt" "17d"
hasnt "?? server/node_modules/" "17d: listed the known entry"

# 17e. at most 15 entries are listed; the rest is counted, not printed
canon_new many
for i in $(seq 1 20); do : > "$CANON/u$i.txt"; done
POKOIN_CANONICAL_CHECKOUT="$CANON" FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 0 "17e 20 entries"
listed="$(grep -c 'WARNING   ?? u' "$t/out")"
[ "$listed" = 15 ] || fail "17e: expected 15 listed entries, got $listed"
has "and 5 more" "17e"

# 17f. a directory that is not a repository, and one that does not exist: nothing said, nothing refused
mkdir -p "$t/canon-broken/.git"
POKOIN_CANONICAL_CHECKOUT="$t/canon-broken" FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 0 "17f not a repository"
hasnt "canonical checkout" "17f not a repository"
POKOIN_CANONICAL_CHECKOUT="$t/canon-absent" FAKE_GH_FIXTURE="$t/fx-green.json" run_gate "$SHA_TWO"
want_rc 0 "17f absent directory"
hasnt "canonical checkout" "17f absent directory"

# 17g. the warning does not soften a refusal: red CI still exits 1, warning first
POKOIN_CANONICAL_CHECKOUT="$t/canon-dirty" FAKE_GH_FIXTURE="$t/fx-repofail.json" run_gate "$SHA_TWO"
want_rc 1 "17g dirty and red"
has "$CANON_TEXT" "17g"
has "repo-gate finished as failure" "17g"

# 17h. --self-check-only answers the comparison and nothing else: no warning, even from a dirty canonical checkout
rc=0
: > "$calls"
rm -f "$LOGF"
GH="$t/gh" POKOIN_CANONICAL_CHECKOUT="$t/canon-dirty" bash "$GATE_COPY" --self-check-only --repo-dir "$t/repo" > "$t/out" 2>&1 || rc=$?
want_rc 0 "17h --self-check-only stays out of it"
hasnt "canonical checkout" "17h"
[ ! -s "$calls" ] || fail "17h: gh was called in --self-check-only mode"
[ ! -e "$LOGF" ] || fail "17h: --self-check-only wrote a log line: $(cat "$LOGF")"

# 17i. with the variable unset the gate falls back to its own default path; wherever that is on this host, naming a
#      directory is a warning only and never changes the answer
rc=0
env -u POKOIN_CANONICAL_CHECKOUT GH="$t/gh" FAKE_GH_FIXTURE="$t/fx-green.json" \
  bash "$gate" --repo-dir "$t/repo" "$SHA_TWO" > "$t/out" 2>&1 || rc=$?
want_rc 0 "17i default path"
unset CANON
export POKOIN_CANONICAL_CHECKOUT="$t/canon-silent"
ok "17: a dirty canonical checkout is listed (up to 15 entries), the known server/node_modules entry alone is not, and the result code never changes"

# usage and unresolvable commit
rc=0
bash "$gate" > "$t/out" 2>&1 || rc=$?
want_rc 2 "usage"
rc=0
GH="$t/gh" bash "$gate" --repo-dir "$t/repo" not-a-commit > "$t/out" 2>&1 || rc=$?
want_rc 2 "bad commit"
ok "usage error and unknown commit -> 2"

echo "all require-ci-green tests passed"
