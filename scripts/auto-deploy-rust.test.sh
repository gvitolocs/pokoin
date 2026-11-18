#!/usr/bin/env bash
# Run: bash scripts/auto-deploy-rust.test.sh
# Runs scripts/auto-deploy-rust.sh against a throwaway git repo with fake build/deploy/sync commands and a health
# file. No network; everything lives in one temp dir.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/auto-deploy-rust.sh"
t="$(mktemp -d)"
trap 'rm -rf "$t"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

gitq() { git -c user.name=t -c user.email=t@example.invalid "$@"; }
gitq init -q --bare "$t/origin.git"
gitq clone -q "$t/origin.git" "$t/push" 2> /dev/null
mkdir -p "$t/push/pokoin-rust" "$t/push/scripts/sql"
echo base > "$t/push/pokoin-rust/lib.rs"
echo base > "$t/push/README.md"
echo base > "$t/push/scripts/sql/001_base.sql"
gitq -C "$t/push" add -A
gitq -C "$t/push" commit -q -m c0
gitq -C "$t/push" branch -M main
gitq -C "$t/push" push -q origin main
gitq clone -q "$t/origin.git" "$t/work" 2> /dev/null

commit() { # file... : change those files, commit, push, print the sha (runs in a subshell: no counter)
  local f n
  n=$(gitq -C "$t/push" rev-list --count HEAD)
  for f in "$@"; do mkdir -p "$t/push/$(dirname "$f")"; echo "change $n" > "$t/push/$f"; done
  gitq -C "$t/push" add -A
  gitq -C "$t/push" commit -q -m "c$n"
  gitq -C "$t/push" push -q origin main
  gitq -C "$t/push" rev-parse HEAD
}

# fakes: each appends to $t/calls; the deploy publishes the sha it was built from to the health file
cat > "$t/build" << 'FAKE'
#!/usr/bin/env bash
echo "build $1" >> "$T/calls"
echo "$1" > "$T/built"
if [ -e "$T/refuse" ]; then echo "require-free-space: only 3 GB free. Not starting the build."; exit 1; fi
[ ! -e "$T/fail-build" ] || { echo "cargo test failed"; exit 1; }
FAKE
cat > "$t/deploy" << 'FAKE'
#!/usr/bin/env bash
echo "deploy" >> "$T/calls"
cp "$T/built" "$T/health"
FAKE
cat > "$t/sync" << 'FAKE'
#!/usr/bin/env bash
echo "sync" >> "$T/calls"
cp "$T/built" "$T/overflow"
FAKE
cat > "$t/status" << 'FAKE'
#!/usr/bin/env bash
s=$(cat "$T/overflow"); h=$(cat "$T/health")
echo "rust release: releases/${s:0:12}, Pi: ${h:0:12}"
FAKE
chmod +x "$t/build" "$t/deploy" "$t/sync" "$t/status"

c0=$(gitq -C "$t/push" rev-parse HEAD)
echo "$c0" > "$t/health"
echo "$c0" > "$t/overflow"
: > "$t/calls"

run() { # args... : the script under test; sets rc and out
  rc=0
  out=$(T="$t" POKOIN_AUTODEPLOY_DIR="$t/state" POKOIN_AUTODEPLOY_REPO="$t/work" \
    BUILD_CMD="$t/build" DEPLOY_CMD="$t/deploy" DEPLOY_CWD="$t" SYNC_CMD="$t/sync" STATUS_CMD="$t/status" \
    HEALTH_URL="file://$t/health" HEALTH_WAIT_S=2 HEALTH_INTERVAL_S=1 bash "$script" "$@" 2>&1) || rc=$?
}
calls() { tr '\n' ',' < "$t/calls" | sed 's/,$//'; }
state_last() { awk -v s="$1" '$1 == s { l = $0 } END { print l }' "$t/state/state" 2> /dev/null || true; }
reset_calls() { : > "$t/calls"; }

# 1. pause stops it before anything else, even with new work waiting
sha=$(commit pokoin-rust/lib.rs)
mkdir -p "$t/state"
echo "owner is deploying by hand" > "$t/state/pause"
run
[ "$rc" = 0 ] || fail "pause: rc=$rc"
grep -q "paused" <<< "$out" || fail "pause: no message: $out"
grep -q "owner is deploying by hand" <<< "$out" || fail "pause: reason not printed"
[ ! -s "$t/calls" ] || fail "pause: ran $(calls)"
[ ! -e "$t/state/state" ] || fail "pause: wrote state"
run --status
grep -q "PAUSED" <<< "$out" || fail "status does not show the pause"
rm "$t/state/pause"
ok "pause file stops the run"

# 2. dry-run runs nothing and writes no state (it does not fetch, so fetch first)
gitq -C "$t/work" fetch -q origin
run --dry-run
[ "$rc" = 0 ] || fail "dry-run rc=$rc"
grep -q "decision: deploy" <<< "$out" || fail "dry-run plan: $out"
grep -q "pokoin-rust/lib.rs" <<< "$out" || fail "dry-run lists no changed path: $out"
[ ! -s "$t/calls" ] || fail "dry-run ran $(calls)"
[ ! -e "$t/state/state" ] || fail "dry-run wrote state"
ok "--dry-run prints the plan and runs nothing"

# 3. success: the three commands in order, then done
run
[ "$rc" = 0 ] || fail "success rc=$rc: $out"
[ "$(calls)" = "build $sha,deploy,sync" ] || fail "success order: $(calls)"
[ "$(state_last "$sha")" = "$sha done" ] || fail "success state: $(state_last "$sha")"
ok "success: build, deploy, sync in order, state done"
reset_calls

# 4. only a README change: skipped, nothing runs
sha=$(commit README.md)
run
[ "$rc" = 0 ] || fail "skip rc=$rc"
[ ! -s "$t/calls" ] || fail "skip ran $(calls)"
[[ "$(state_last "$sha")" == "$sha skipped"* ]] || fail "skip state: $(state_last "$sha")"
ok "no pokoin-rust change: skipped"

# 5. a scripts/sql change next to a Rust change: migration-pending, exit 3, no build
sql_sha=$(commit pokoin-rust/lib.rs scripts/sql/002_new.sql)
run
[ "$rc" = 3 ] || fail "migration rc=$rc: $out"
[ ! -s "$t/calls" ] || fail "migration ran $(calls)"
[ "$(state_last "$sql_sha")" = "$sql_sha failed migration-pending" ] || fail "migration state: $(state_last "$sql_sha")"
grep -q "scripts/sql/002_new.sql" <<< "$out" || fail "migration: files not listed: $out"
ok "scripts/sql change: failed migration-pending, exit 3, no build"

# 6. a failed sha is not retried
run
[ "$rc" = 0 ] || fail "no-retry rc=$rc"
[ ! -s "$t/calls" ] || fail "failed sha retried: $(calls)"
ok "a failed sha is not retried"

# 7. --ack-migrations allows exactly that sha
run --ack-migrations "$sql_sha"
[ "$rc" = 0 ] || fail "ack rc=$rc: $out"
run
[ "$rc" = 0 ] || fail "acked deploy rc=$rc: $out"
[ "$(calls)" = "build $sql_sha,deploy,sync" ] || fail "acked deploy: $(calls)"
[ "$(state_last "$sql_sha")" = "$sql_sha done" ] || fail "acked state: $(state_last "$sql_sha")"
reset_calls
other=$(commit pokoin-rust/lib.rs scripts/sql/003_other.sql)
run
[ "$rc" = 3 ] || fail "ack of another sha must not allow this one: rc=$rc"
[ ! -s "$t/calls" ] || fail "ack leaked to $other: $(calls)"
ok "--ack-migrations allows only that sha"

# 8. a failing build: failed build, deploy never called
# (the owner applied 003 and deployed $other by hand: the Pi now runs it, which moves the baseline)
echo "$other" > "$t/health"
echo "$other" > "$t/overflow"
touch "$t/fail-build"
bad=$(commit pokoin-rust/lib.rs)
run
[ "$rc" = 1 ] || fail "failing build rc=$rc: $out"
[ "$(calls)" = "build $bad" ] || fail "failing build ran $(calls)"
[ "$(state_last "$bad")" = "$bad failed build" ] || fail "failing build state: $(state_last "$bad")"
run
[ "$(calls)" = "build $bad" ] || fail "failed build was retried: $(calls)"
rm "$t/fail-build"
reset_calls
ok "failing build: failed, deploy not called, not retried"

# 9. a build the disk guard refuses is stalled and retried on the next trigger
touch "$t/refuse"
low=$(commit pokoin-rust/lib.rs)
run
[ "$rc" = 0 ] || fail "stalled rc=$rc: $out"
[[ "$(state_last "$low")" == "$low stalled"* ]] || fail "stalled state: $(state_last "$low")"
[ "$(calls)" = "build $low" ] || fail "stalled ran $(calls)"
rm "$t/refuse"
reset_calls
run
[ "$(calls)" = "build $low,deploy,sync" ] || fail "stalled sha not retried: $(calls)"
[ "$(state_last "$low")" = "$low done" ] || fail "retry state: $(state_last "$low")"
reset_calls
ok "disk-refused build: stalled, retried next trigger"

# 10. a second concurrent run exits without running
new=$(commit pokoin-rust/lib.rs)
exec 8> "$t/state/lock"
flock -n 8 || fail "test could not take the lock"
run
exec 8>&-
[ "$rc" = 0 ] || fail "concurrent rc=$rc"
grep -q "another run is going" <<< "$out" || fail "concurrent message: $out"
[ ! -s "$t/calls" ] || fail "concurrent ran $(calls)"
[ -z "$(state_last "$new")" ] || fail "concurrent wrote state"
ok "a second concurrent run exits without running"

# 11. verification: a deploy that never changes the health release fails at verify
cat > "$t/deploy" << 'FAKE'
#!/usr/bin/env bash
echo "deploy" >> "$T/calls"
FAKE
run
[ "$rc" = 1 ] || fail "verify rc=$rc: $out"
[ "$(state_last "$new")" = "$new failed verify" ] || fail "verify state: $(state_last "$new")"
ok "release header that never matches: failed verify"

# 12. no planning repo configured: exit 2, the clone command is printed, nothing runs, no state is created
reset_calls
rm -rf "$t/state2"
rc=0
out=$(T="$t" POKOIN_AUTODEPLOY_DIR="$t/state2" POKOIN_AUTODEPLOY_REPO="$t/no-such-clone" BUILD_CMD="$t/build" \
  DEPLOY_CMD="$t/deploy" DEPLOY_CWD="$t" SYNC_CMD="$t/sync" STATUS_CMD="$t/status" bash "$script" 2>&1) || rc=$?
[ "$rc" = 2 ] || fail "missing repo rc=$rc: $out"
grep -q "git clone .* $t/no-such-clone" <<< "$out" || fail "missing repo: no clone command: $out"
[ ! -e "$t/no-such-clone" ] || fail "missing repo: created the directory"
[ ! -s "$t/calls" ] || fail "missing repo ran $(calls)"
[ ! -e "$t/state2" ] || fail "missing repo created state"
ok "missing planning repo: exit 2 with the git clone command, nothing run"

# 13. executed from a path outside any git repo: needs the env, and then works
mkdir "$t/outside"
cp "$script" "$t/outside/pokoin-auto-deploy-rust"
rc=0
out=$(env -u POKOIN_AUTODEPLOY_REPO T="$t" POKOIN_AUTODEPLOY_DIR="$t/state2" BUILD_CMD="$t/build" DEPLOY_CMD="$t/deploy" \
  DEPLOY_CWD="$t" SYNC_CMD="$t/sync" STATUS_CMD="$t/status" bash "$t/outside/pokoin-auto-deploy-rust" 2>&1) || rc=$?
[ "$rc" = 2 ] || fail "outside repo without env rc=$rc: $out"
grep -q "POKOIN_AUTODEPLOY_REPO" <<< "$out" || fail "outside repo: no hint: $out"
[ ! -s "$t/calls" ] || fail "outside repo without env ran $(calls)"
[ ! -e "$t/state2" ] || fail "outside repo without env created state"
rc=0
out=$(T="$t" POKOIN_AUTODEPLOY_DIR="$t/state2" POKOIN_AUTODEPLOY_REPO="$t/work" HEALTH_URL="file://$t/health" \
  bash "$t/outside/pokoin-auto-deploy-rust" --dry-run 2>&1) || rc=$?
[ "$rc" = 0 ] || fail "outside repo with env rc=$rc: $out"
grep -q "decision:" <<< "$out" || fail "outside repo with env: no plan: $out"
ok "script runs from outside any git repo when the planning repo is given"

echo "all auto-deploy-rust tests passed"
