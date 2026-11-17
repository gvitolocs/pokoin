#!/usr/bin/env bash
# Run: bash scripts/deploy-gate-callers.test.sh
# Proves each deploy and publish entry point refuses BEFORE it ships when CI is red, and goes past the gate when CI is
# green. Uses copies of the real scripts in a throwaway bare origin + clone, a fake `gh` (JSON fixtures), and fake
# wrangler, vercel, ssh, scp and file that only append to a calls file. No network; everything lives in one temp dir.
#
# Where a script stops (green CI):
#   publish-web.sh               runs to the end (build and node steps are stubs, wrangler is fake)
#   deploy-pokoin-rust.sh        runs to the end (fake ssh, scp, file)
#   deploy-web.sh                stops at its first Vercel call: the fake vercel fails, so it dies at the alias lookup
#   build-pokoin-rust-release.sh stops after it created its checkout: HOME has no ~/.cargo/env, so cargo never runs
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
real="$here/testdata/check-runs/main-b757cc1a.json"
t="$(mktemp -d)"
trap 'rm -rf "$t"' EXIT

fail() {
  echo "FAIL: $*" >&2
  if [ -f "$t/out" ]; then sed 's/^/  | /' "$t/out" >&2; fi
  exit 1
}
ok() { echo "ok: $*"; }
gitq() { git -c user.name=t -c user.email=t@example.invalid "$@"; }

# ---- structural check: every entry point calls the gate ------------------------------------------------------
for f in publish-web.sh deploy-web.sh deploy-pokoin-rust.sh build-pokoin-rust-release.sh; do
  grep -q 'require-ci-green\.sh' "$here/$f" || fail "scripts/$f has no call to require-ci-green.sh"
done
ok "structure: all four entry points call require-ci-green.sh"

# ---- fixtures ----------------------------------------------------------------------------------------------
add_repo_gate() { jq --arg c "$1" '.check_runs += [{id:200000000001,name:"repo-gate",status:"completed",conclusion:$c,app:{slug:"github-actions"}},{id:200000000002,name:"secret-gate",status:"completed",conclusion:"success",app:{slug:"github-actions"}}]' "$real"; }
add_repo_gate success > "$t/fx-green.json"
add_repo_gate failure > "$t/fx-red.json"

# ---- throwaway origin + clone with copies of the real scripts -----------------------------------------------
gitq init -q --bare "$t/origin.git"
gitq clone -q "$t/origin.git" "$t/clone" 2> /dev/null
mkdir -p "$t/clone/scripts"
for f in publish-web.sh deploy-web.sh deploy-pokoin-rust.sh build-pokoin-rust-release.sh require-ci-green.sh require-free-space.sh ci-required-checks; do
  cp "$here/$f" "$t/clone/scripts/$f"
done
# stubs for what the scripts run next
cat > "$t/clone/scripts/build-web.sh" << 'STUB'
#!/usr/bin/env bash
echo "build-web" >> "$CALLS"
mkdir -p dist-web
STUB
chmod +x "$t/clone/scripts/build-web.sh"
echo 'process.exit(0)' > "$t/clone/scripts/carry-web-release-chunks.mjs"
echo 'process.exit(0)' > "$t/clone/scripts/write-cloudflare-web-routing.mjs"
echo x > "$t/clone/README.md"
gitq -C "$t/clone" add -A
gitq -C "$t/clone" commit -q -m c0
gitq -C "$t/clone" branch -M main
gitq -C "$t/clone" push -q origin main 2> /dev/null
gitq -C "$t/clone" fetch -q origin
SHA="$(gitq -C "$t/clone" rev-parse HEAD)"

# ---- fakes -------------------------------------------------------------------------------------------------
mkdir -p "$t/bin" "$t/home"
cat > "$t/gh" << 'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$GH_CALLS"
filter=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--jq" ]; then filter="$a"; fi
  prev="$a"
done
jq -r "$filter" "$FAKE_GH_FIXTURE"
FAKE
# The fake wrangler answers `versions list` from $FAKE_WRANGLER_LIST (a file), exiting $FAKE_WRANGLER_LIST_RC; with
# no fixture given the call fails. The JSON shape publish-web.sh reads (an array of objects with an `id`) comes from
# the Cloudflare documentation and has not been seen from the real tool by this run.
cat > "$t/wrangler" << 'FAKE'
#!/usr/bin/env bash
echo "wrangler $*" >> "$CALLS"
case "$*" in
  "versions upload"*) echo "Version ID: 11111111-2222-3333-4444-555555555555" ;;
  "versions list --name pokoin-web --json")
    if [ -n "${FAKE_WRANGLER_LIST:-}" ]; then cat "$FAKE_WRANGLER_LIST"; exit "${FAKE_WRANGLER_LIST_RC:-0}"; fi
    echo "wrangler: versions list has no fixture in this test" >&2
    exit 1 ;;
esac
FAKE
for n in vercel ssh scp; do
  cat > "$t/bin/$n" << FAKE
#!/usr/bin/env bash
echo "$n \$*" >> "\$CALLS"
exit 1
FAKE
done
# scp and ssh succeed in the Rust deploy case; vercel keeps failing (see the header)
for n in ssh scp; do
  cat > "$t/bin/$n" << FAKE
#!/usr/bin/env bash
echo "$n \$*" >> "\$CALLS"
exit 0
FAKE
done
cat > "$t/bin/file" << 'FAKE'
#!/usr/bin/env bash
echo "file $*" >> "$CALLS"
echo "$1: ELF 64-bit LSB executable, ARM aarch64"
FAKE
chmod +x "$t/gh" "$t/wrangler" "$t/bin/"*

export CALLS="$t/calls" GH_CALLS="$t/gh-calls" GH="$t/gh"
export POKOIN_CI_LOG="$t/ci.log" POKOIN_CI_POLL_S=0.2 POKOIN_CI_WAIT_S=2 POKOIN_CI_MISSING_GRACE_S=1
export POKOIN_WEB_PUBLISH_LOCK="$t/publish.lock" POKOIN_WEB_DEPLOY_LOCK="$t/deploy.lock"
export POKOIN_WEB_VERSIONS_LOG="$t/versions.tsv"
export POKOIN_DEPLOY_DIR="$t/deploy" POKOIN_MIN_FREE_GB=0
export WRANGLER="$t/wrangler"
unset POKOIN_CI_OVERRIDE LANE_WORKER POKOIN_OPS_RECORD_CMD || true

rc=0
# in_clone <fixture> <command...>: runs in the clone with fakes on PATH, output in $t/out, exit code in $rc
in_clone() {
  local fixture="$1"
  shift
  rm -f "$CALLS" "$GH_CALLS"
  : > "$CALLS"
  rc=0
  (cd "$t/clone" && env FAKE_GH_FIXTURE="$t/fx-$fixture.json" PATH="$t/bin:$PATH" "$@") > "$t/out" 2>&1 || rc=$?
}
want_rc() { [ "$rc" = "$1" ] || fail "$2: expected exit $1, got $rc"; }
has() { grep -qF -- "$1" "$t/out" || fail "$2: output lacks '$1'"; }
hasnt() { if grep -qF -- "$1" "$t/out"; then fail "$2: output has '$1'"; fi; }
called() { grep -q -- "$1" "$CALLS"; }
refused_by_gate() { has "require-ci-green: REFUSED" "$1"; }

# ---- publish-web.sh upload ---------------------------------------------------------------------------------
rm -f "$POKOIN_WEB_VERSIONS_LOG"
in_clone red bash scripts/publish-web.sh
want_rc 1 "publish red"
refused_by_gate "publish red"
if called build-web || called wrangler; then fail "publish red: the build or wrangler ran"; fi
[ ! -e "$POKOIN_WEB_VERSIONS_LOG" ] || fail "publish red: a version was recorded"
ok "publish-web.sh upload, CI red: exit 1, no build, no wrangler"

in_clone green bash scripts/publish-web.sh
want_rc 0 "publish green"
called build-web || fail "publish green: the build did not run"
called "wrangler versions upload" || fail "publish green: wrangler versions upload was not called"
grep -qP '^\S+\t11111111-2222-3333-4444-555555555555\t'"$SHA"'\tgreen$' "$POKOIN_WEB_VERSIONS_LOG" \
  || fail "publish green: versions file lacks the id with the sha and green: $(cat "$POKOIN_WEB_VERSIONS_LOG" 2> /dev/null)"
ok "publish-web.sh upload, CI green: exit 0, wrangler versions upload called, version recorded with sha and green"

# ---- publish-web.sh --promote (the rollback path, with an exception that ends by itself) ---------------------
RECORDED=11111111-2222-3333-4444-555555555555
UNKNOWN=99999999-8888-7777-6666-555555555555
SECOND=22222222-3333-4444-5555-666666666666
THIRD=33333333-4444-5555-6666-777777777777

# list_json_of <id>...: a `versions list --json` answer in the shape the fake wrangler prints, holding these ids.
# The shape is taken from the Cloudflare documentation and has NOT been seen from the real tool by this run;
# publish-web.sh prints the count line, so a wrong assumption shows itself at the first real promote.
list_json_of() {
  jq -n --arg ids "$*" '($ids | split(" ") | to_entries
    | map({id: .value, version_id: .value, number: (.key + 1), created_on: "2026-11-01T00:00:00Z", annotations: []}))'
}
# vlog <file> <kind> <id>...: a versions log with one line per id, as publish-web.sh records it
vlog() {
  local f="$1" kind="$2" id
  shift 2
  : > "$f"
  for id in "$@"; do printf '2026-11-01T00:00:00Z\t%s\t%s\t%s\n' "$id" "$SHA" "$kind" >> "$f"; done
}
list_json_of "$RECORDED" "$SECOND" "$THIRD" > "$t/list-3.json"
echo '[]' > "$t/list-none.json"
echo 'the retained versions, as a table' > "$t/list-not-json.txt"
vlog "$t/v-3of3.tsv" green "$RECORDED" "$SECOND" "$THIRD"
vlog "$t/v-1of3.tsv" green "$RECORDED"
: > "$t/v-none.tsv"
GATED_COUNT="retained versions were uploaded through the gate"
UNLISTED="publish-web: the retained versions could not be listed"
NOT_UPLOADED_WARNING="version $UNKNOWN was not uploaded through this script on this host; its commit's CI state is unknown"
NOT_UPLOADED_REFUSED="version $UNKNOWN was not uploaded through this script; every retained version was, so this one is not a rollback target."

grep -q -- '--self-check-only' "$here/publish-web.sh" || fail "promote: publish-web.sh does not run the gate's self-check"

in_clone red bash scripts/publish-web.sh --promote "$RECORDED"
want_rc 0 "promote recorded"
called "wrangler versions deploy $RECORDED@100%" || fail "promote recorded: wrangler versions deploy $RECORDED@100% not called"
hasnt "WARNING" "promote recorded"
has "$UNLISTED" "promote recorded: the count line"
grep -qP '^\S+\t'"$RECORDED"'\t'"$SHA"'\tpromoted$' "$POKOIN_WEB_VERSIONS_LOG" || fail "promote recorded: no 'promoted' line"
[ ! -s "$GH_CALLS" ] 2> /dev/null || [ ! -e "$GH_CALLS" ] || fail "promote: the gate was called for a promotion"
ok "publish-web.sh --promote <recorded id>: wrangler called, no warning, promoted line appended"

POKOIN_WEB_VERSIONS_LOG="$t/v-3of3.tsv" FAKE_WRANGLER_LIST="$t/list-3.json" \
  in_clone red bash scripts/publish-web.sh --promote "$RECORDED"
want_rc 0 "promote recorded, every retained version gated"
called "wrangler versions deploy $RECORDED@100%" || fail "promote recorded, every retained version gated: wrangler was not called"
hasnt "WARNING" "promote recorded, every retained version gated"
has "publish-web: 3 of 3 $GATED_COUNT" "promote recorded, every retained version gated"
ok "publish-web.sh --promote <recorded id> with 3 of 3 gated: promoted, no warning, 3 of 3 counted"

POKOIN_WEB_VERSIONS_LOG="$t/v-1of3.tsv" FAKE_WRANGLER_LIST="$t/list-3.json" \
  in_clone red bash scripts/publish-web.sh --promote "$UNKNOWN"
want_rc 0 "promote unknown, 1 of 3 gated"
called "wrangler versions deploy $UNKNOWN@100%" || fail "promote unknown, 1 of 3 gated: wrangler was not called"
has "$NOT_UPLOADED_WARNING" "promote unknown, 1 of 3 gated"
has "publish-web: 1 of 3 $GATED_COUNT" "promote unknown, 1 of 3 gated"
grep -qP '^\S+\t'"$UNKNOWN"'\t-\tpromoted-unrecorded$' "$t/v-1of3.tsv" || fail "promote unknown, 1 of 3 gated: no 'promoted-unrecorded' line"
ok "publish-web.sh --promote <unknown id> with 1 of 3 gated: promoted, warned, counted 1 of 3"

POKOIN_WEB_VERSIONS_LOG="$t/v-3of3.tsv" FAKE_WRANGLER_LIST="$t/list-3.json" \
  in_clone red bash scripts/publish-web.sh --promote "$UNKNOWN"
want_rc 1 "promote unknown, 3 of 3 gated"
if called "versions deploy"; then fail "promote unknown, 3 of 3 gated: wrangler versions deploy ran anyway"; fi
has "publish-web: 3 of 3 $GATED_COUNT" "promote unknown, 3 of 3 gated"
has "$NOT_UPLOADED_REFUSED" "promote unknown, 3 of 3 gated"
if grep -qF "$UNKNOWN" "$t/v-3of3.tsv"; then fail "promote unknown, 3 of 3 gated: a refused promotion was recorded"; fi
ok "publish-web.sh --promote <unknown id> with 3 of 3 gated: exit 1, versions deploy never called"

# the retained list cannot be trusted: unknown, so the old warning still carries the rollback
POKOIN_WEB_VERSIONS_LOG="$t/v-none.tsv" FAKE_WRANGLER_LIST="$t/list-3.json" FAKE_WRANGLER_LIST_RC=1 \
  in_clone red bash scripts/publish-web.sh --promote "$UNKNOWN"
want_rc 0 "promote, versions list exits 1"
called "wrangler versions deploy $UNKNOWN@100%" || fail "promote, versions list exits 1: wrangler was not called"
has "$UNLISTED (wrangler versions list did not answer)" "promote, versions list exits 1"
has "$NOT_UPLOADED_WARNING" "promote, versions list exits 1"
POKOIN_WEB_VERSIONS_LOG="$t/v-3of3.tsv" FAKE_WRANGLER_LIST="$t/list-none.json" \
  in_clone red bash scripts/publish-web.sh --promote "$UNKNOWN"
want_rc 0 "promote, versions list is empty"
called "wrangler versions deploy $UNKNOWN@100%" || fail "promote, versions list is empty: wrangler was not called"
has "$UNLISTED (no version id came back)" "promote, versions list is empty"
has "$NOT_UPLOADED_WARNING" "promote, versions list is empty"
POKOIN_WEB_VERSIONS_LOG="$t/v-3of3.tsv" FAKE_WRANGLER_LIST="$t/list-not-json.txt" \
  in_clone red bash scripts/publish-web.sh --promote "$UNKNOWN"
want_rc 0 "promote, versions list is not JSON"
called "wrangler versions deploy $UNKNOWN@100%" || fail "promote, versions list is not JSON: wrangler was not called"
has "$UNLISTED (wrangler versions list did not answer with JSON)" "promote, versions list is not JSON"
has "$NOT_UPLOADED_WARNING" "promote, versions list is not JSON"
ok "publish-web.sh --promote keeps rolling back, with the count line, while the retained list cannot be read"

# the self-check on the promote path: a warning while an old checkout could still be the rollback target, a
# refusal once every retained version went through the gate
PUBLISH_COPY="$t/clone/scripts/publish-web.sh"
cp "$PUBLISH_COPY" "$t/pristine-publish-web.sh"
printf '# edited\n' >> "$PUBLISH_COPY"
POKOIN_WEB_VERSIONS_LOG="$t/v-none.tsv" in_clone red bash scripts/publish-web.sh --promote "$UNKNOWN"
want_rc 0 "promote from a stale checkout, list unknown"
called "wrangler versions deploy $UNKNOWN@100%" || fail "promote from a stale checkout, list unknown: wrangler was not called"
has "WARNING promoting anyway" "promote from a stale checkout, list unknown"
has "deploy scripts are not origin/main's" "promote from a stale checkout, list unknown"
POKOIN_WEB_VERSIONS_LOG="$t/v-1of3.tsv" FAKE_WRANGLER_LIST="$t/list-3.json" \
  in_clone red bash scripts/publish-web.sh --promote "$UNKNOWN"
want_rc 0 "promote from a stale checkout, 1 of 3 gated"
called "wrangler versions deploy $UNKNOWN@100%" || fail "promote from a stale checkout, 1 of 3 gated: wrangler was not called"
has "WARNING promoting anyway" "promote from a stale checkout, 1 of 3 gated"
POKOIN_WEB_VERSIONS_LOG="$t/v-3of3.tsv" FAKE_WRANGLER_LIST="$t/list-3.json" \
  in_clone red bash scripts/publish-web.sh --promote "$RECORDED"
want_rc 1 "promote from a stale checkout, 3 of 3 gated"
if called "versions deploy"; then fail "promote from a stale checkout, 3 of 3 gated: wrangler versions deploy ran anyway"; fi
has "deploy scripts are not origin/main's" "promote from a stale checkout, 3 of 3 gated"
hasnt "WARNING promoting anyway" "promote from a stale checkout, 3 of 3 gated"
cp "$t/pristine-publish-web.sh" "$PUBLISH_COPY"
ok "publish-web.sh --promote warns about a stale checkout while the exception lives, and refuses once it has ended"

POKOIN_WEB_VERSIONS_LOG="$t/not-yet/dir/v.tsv" in_clone red bash scripts/publish-web.sh --promote "$UNKNOWN"
want_rc 0 "promote, no versions dir"
called "wrangler versions deploy $UNKNOWN@100%" || fail "promote, no versions dir: wrangler was not called"
[ -s "$t/not-yet/dir/v.tsv" ] || fail "promote, no versions dir: the file was not created"
echo plain > "$t/afile"
POKOIN_WEB_VERSIONS_LOG="$t/afile/dir/v.tsv" in_clone red bash scripts/publish-web.sh --promote "$UNKNOWN"
want_rc 0 "promote, versions file unwritable"
called "wrangler versions deploy $UNKNOWN@100%" || fail "promote, unwritable: wrangler was not called"
has "WARNING cannot write" "promote, unwritable"
ok "publish-web.sh --promote works when the versions file or directory is missing or cannot be written"

# ---- deploy-web.sh -----------------------------------------------------------------------------------------
in_clone red bash scripts/deploy-web.sh
want_rc 1 "deploy-web red"
refused_by_gate "deploy-web red"
if called vercel; then fail "deploy-web red: vercel was called"; fi
ok "deploy-web.sh, CI red: exit 1, vercel never called"

in_clone green bash scripts/deploy-web.sh
hasnt "REFUSED" "deploy-web green"
called "vercel api" || fail "deploy-web green: it did not get past the gate to the first Vercel call"
ok "deploy-web.sh, CI green: past the gate (stops at the fake vercel alias lookup)"

# ---- deploy-pokoin-rust.sh ---------------------------------------------------------------------------------
BIN="$t/clone/pokoin-rust/target/aarch64-unknown-linux-gnu/release/pokoin-api"
mkdir -p "$(dirname "$BIN")"
echo binary > "$BIN"
in_clone red bash scripts/deploy-pokoin-rust.sh
want_rc 1 "deploy-pokoin-rust red"
refused_by_gate "deploy-pokoin-rust red"
if called '^ssh' || called '^scp'; then fail "deploy-pokoin-rust red: ssh or scp was called"; fi
ok "deploy-pokoin-rust.sh, CI red: exit 1, no ssh, no scp"

in_clone green bash scripts/deploy-pokoin-rust.sh
want_rc 0 "deploy-pokoin-rust green"
called '^scp' || fail "deploy-pokoin-rust green: scp was not called"
called '^ssh' || fail "deploy-pokoin-rust green: ssh was not called"
ok "deploy-pokoin-rust.sh, CI green: runs through (fake ssh, scp, file)"

# ---- build-pokoin-rust-release.sh --------------------------------------------------------------------------
for extra in "" "--skip-tests"; do
  rm -rf "$POKOIN_DEPLOY_DIR"
  # shellcheck disable=SC2086
  in_clone red bash scripts/build-pokoin-rust-release.sh $extra
  want_rc 1 "build red $extra"
  refused_by_gate "build red $extra"
  [ ! -e "$POKOIN_DEPLOY_DIR/rust-release" ] || fail "build red $extra: the release checkout was created"
done
ok "build-pokoin-rust-release.sh, CI red (also with --skip-tests): exit 1, no rust-release checkout"

rm -rf "$POKOIN_DEPLOY_DIR"
in_clone green env HOME="$t/home" bash scripts/build-pokoin-rust-release.sh --skip-tests
hasnt "REFUSED" "build green"
[ -d "$POKOIN_DEPLOY_DIR/rust-release" ] || fail "build green: it did not get past the gate to the checkout"
ok "build-pokoin-rust-release.sh, CI green: past the gate (stops before cargo: no ~/.cargo/env in the test HOME)"

echo "all deploy-gate caller tests passed"
