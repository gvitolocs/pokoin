#!/usr/bin/env bash
# Run: bash scripts/load-cf-env.test.sh
# Proves scripts/lib/load-cf-env.sh and the scripts that source it, with dummy values in a throwaway HOME and fakes
# that only record calls. No network; everything lives in one temp dir; values are never printed.
#
# Where each script stops (fake wrangler records whether CLOUDFLARE_API_TOKEN was non-empty, one line per call):
#   publish-web.sh               `--promote <id>`: stops after wrangler `versions list` and `versions deploy`
#   publish-news.sh              runs to the end of an upload (node and wrangler are fakes)
#   refresh-site-map.sh          stops after its first wrangler call (`deployments list`); its child publish-web.sh is
#                                a fake that prints an upload result and does not load anything itself
#   create-pokoin-news-tunnel.sh stops at the credential check, or at the fake python3 when the credentials exist
#   install-hypemeter-a1.sh      same; with the credentials present it stops at `need oci`
# shellcheck disable=SC2016  # the single-quoted bash -c bodies expand in the child shell
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d "${TMPDIR:-/tmp}/load-cf-env-test.XXXXXX")"
trap 'rm -rf "$t"' EXIT
export POKOIN_CF_ENV_FILE="$t/no-such-cloudflare.env"

DUMMY=dummy-token-for-test
fail() {
  echo "FAIL: $*" >&2
  exit 1
}
ok() { echo "ok: $*"; }
gitq() { git -c user.name=t -c user.email=t@example.invalid -c core.hooksPath= "$@"; }

# ---- homes: one with the dummy file, one without ---------------------------------------------------------
mkdir -p "$t/home-with/.config/pokoin" "$t/home-without" "$t/tmp"
cat > "$t/home-with/.config/pokoin/cloudflare.env" << EOF
CLOUDFLARE_API_TOKEN=$DUMMY
CLOUDFLARE_ACCOUNT_ID=dummy-account-for-test
CLOUDFLARE_EMAIL=dummy@example.invalid
CLOUDFLARE_API_KEY=dummy-key-for-test
EOF
for h in home-with home-without; do
  printf '[user]\n\tname = t\n\temail = t@example.invalid\n[core]\n\thooksPath =\n' > "$t/$h/.gitconfig"
done

# ---- fakes ------------------------------------------------------------------------------------------------
mkdir -p "$t/bin"
cat > "$t/bin/wrangler" << FAKE
#!/bin/sh
if [ -n "\${CLOUDFLARE_API_TOKEN:-}" ]; then echo token-set >> "$t/wrangler-token"; else echo token-unset >> "$t/wrangler-token"; fi
echo "wrangler \$*" >> "$t/wrangler-calls"
case "\$*" in
  "versions upload"*) echo "Version ID: 11111111-2222-3333-4444-555555555555" ;;
  "versions list"*) echo '[]' ;;
  "deployments list"*) echo "Version(s):  (100%) 7593dc2d-0e08-4723-8638-cdaec722a164" ;;
esac
exit 0
FAKE
cat > "$t/bin/node" << 'FAKE'
#!/bin/sh
case "$1" in
  scripts/build-site-map.mjs) echo "{\"n\": $(date +%s%N)}" > market/public/data/site-map.json ;;
esac
exit 0
FAKE
cat > "$t/bin/curl" << 'FAKE'
#!/bin/sh
exit 0
FAKE
cat > "$t/bin/python3" << FAKE
#!/bin/sh
echo "python3 \$*" >> "$t/python-calls"
exit 0
FAKE
chmod +x "$t/bin/"*
STUBPATH="$t/bin:/usr/bin:/bin"

# reset_records: forget what the fakes saw
reset_records() { rm -f "$t/wrangler-token" "$t/wrangler-calls" "$t/python-calls"; }
# first_token: the first recorded wrangler token state
first_token() { head -1 "$t/wrangler-token" 2> /dev/null || echo none; }
# no_dummy_in <file> <what>: the dummy value never shows up in captured output
no_dummy_in() { if grep -qF -- "$DUMMY" "$1"; then fail "$2: output contains the credential value"; fi; }
no_unbound() { if grep -qF 'unbound variable' "$1"; then fail "$2: stderr has an unbound variable error"; fi; }

# ---- (a) the helper ---------------------------------------------------------------------------------------
helper="$here/lib/load-cf-env.sh"
probe_set() { # probe_set <home> [extra env...]: prints the number of the four names that are set
  local h="$1"
  shift
  env -i PATH="$STUBPATH" HOME="$h" "$@" bash -c '
    . "$1"
    n=0
    for v in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_EMAIL CLOUDFLARE_API_KEY; do
      if [ -n "${!v:-}" ]; then n=$((n + 1)); fi
    done
    echo "$n"' _ "$helper"
}
[ "$(probe_set "$t/home-with")" = 4 ] || fail "helper: the four names are not all set with the file present"
ok "helper: file present, the four names are set"
[ "$(probe_set "$t/home-with" LANE_WORKER=1)" = 0 ] || fail "helper: names set although LANE_WORKER is set"
ok "helper: LANE_WORKER set, the four names stay unset"
[ "$(probe_set "$t/home-without")" = 0 ] || fail "helper: names set with the file absent"
ok "helper: file absent, the four names stay unset"

rc=0
env -i PATH="$STUBPATH" HOME="$t/home-without" bash -c '. "$1"' _ "$helper" > "$t/a.out" 2> "$t/a.err" || rc=$?
[ "$rc" = 0 ] || fail "helper: file absent returned $rc"
[ ! -s "$t/a.out" ] && [ ! -s "$t/a.err" ] || fail "helper: file absent printed output"
rc=0
env -i PATH="$STUBPATH" HOME="$t/home-with" bash -c '. "$1"' _ "$helper" > "$t/a.out" 2> "$t/a.err" || rc=$?
[ "$rc" = 0 ] || fail "helper: file present returned $rc"
[ ! -s "$t/a.out" ] && [ ! -s "$t/a.err" ] || fail "helper: file present printed output"
ok "helper: returns 0 and prints nothing, file absent and present"

for opts in "set -eu" "set +eu" "set -eua" "set -e; set +u"; do
  for h in home-with home-without; do
    env -i PATH="$STUBPATH" HOME="$t/$h" bash -c "$opts"'; before="$-"; . "$1"; [ "$-" = "$before" ]' _ "$helper" \
      || fail "helper: shell options changed (start: $opts, $h)"
  done
done
ok "helper: set -e, set -u and set -a are as they were found"

rc=0
env -i PATH="$STUBPATH" HOME="$t/home-with" POKOIN_CF_ENV_FILE="$t/home-without/none.env" bash -c '. "$1"; [ -z "${CLOUDFLARE_API_TOKEN:-}" ]' _ "$helper" || rc=$?
[ "$rc" = 0 ] || fail "helper: POKOIN_CF_ENV_FILE did not change which file is read"
ok "helper: POKOIN_CF_ENV_FILE picks the file"

# a credentials file with a syntax error (unterminated quote): the helper still returns 0, prints nothing, the
# caller keeps running, and its shell options are as before
mkdir -p "$t/home-broken/.config/pokoin"
printf 'CLOUDFLARE_API_TOKEN="%s\n' "$DUMMY" > "$t/home-broken/.config/pokoin/cloudflare.env"
rc=0
env -i PATH="$STUBPATH" HOME="$t/home-broken" bash -c '
  set -eu
  before="$-"
  . "$1"
  [ "$-" = "$before" ] || exit 11
  echo caller-continued > "$2"' _ "$helper" "$t/continued" > "$t/a.out" 2> "$t/a.err" || rc=$?
[ "$rc" = 0 ] || fail "helper: a syntax error in the file made the caller exit $rc"
[ "$(cat "$t/continued" 2> /dev/null)" = caller-continued ] || fail "helper: the caller did not continue after a syntax error"
[ ! -s "$t/a.out" ] && [ ! -s "$t/a.err" ] || fail "helper: a syntax error in the file printed output"
ok "helper: syntax error in the file, returns 0, prints nothing, caller continues with its options unchanged"

# ---- fixtures: a bare origin and clones holding copies of the scripts -------------------------------------
make_origin() { # make_origin <name>: bare origin with `main` holding the files staged in $t/seed-<name>
  gitq init -q --bare -b main "$t/$1-origin.git"
  gitq init -q -b main "$t/seed-$1"
  gitq -C "$t/seed-$1" add -A
  gitq -C "$t/seed-$1" commit -q -m seed
  gitq -C "$t/seed-$1" push -q "$t/$1-origin.git" main 2> /dev/null
}

# publish-web.sh: promote path
mkdir -p "$t/seed-web/scripts/lib"
cp "$here/publish-web.sh" "$t/seed-web/scripts/publish-web.sh"
cp "$here/lib/load-cf-env.sh" "$t/seed-web/scripts/lib/load-cf-env.sh"
make_origin web

# publish-news.sh: the lock file moves into the temp dir, the rest is the real script
mkdir -p "$t/seed-news/scripts/lib"
sed "s#/tmp/pokoin-news-publish.lock#$t/news.lock#" "$here/publish-news.sh" > "$t/seed-news/scripts/publish-news.sh"
cp "$here/lib/load-cf-env.sh" "$t/seed-news/scripts/lib/load-cf-env.sh"
echo 'process.exit(0)' > "$t/seed-news/scripts/build-news-site.mjs"
echo '{}' > "$t/seed-news/wrangler.pokoin-news.jsonc"
make_origin news

# refresh-site-map.sh: a worktree named site-map-refresh; publish-web.sh is a fake that loads nothing
mkdir -p "$t/seed-map/scripts/lib" "$t/seed-map/market/public/data"
cp "$here/refresh-site-map.sh" "$t/seed-map/scripts/refresh-site-map.sh"
cp "$here/lib/load-cf-env.sh" "$t/seed-map/scripts/lib/load-cf-env.sh"
cat > "$t/seed-map/scripts/publish-web.sh" << 'FAKE'
#!/usr/bin/env bash
echo "Version ID: 11111111-2222-3333-4444-555555555555"
echo "Version Preview URL: https://11111111-pokoin-web.example.workers.dev"
FAKE
echo '{}' > "$t/seed-map/market/public/data/site-map.json"
echo '{}' > "$t/seed-map/market/public/data/site-map-images.json"
echo 'x' > "$t/seed-map/scripts/build-site-map.mjs"
make_origin map

# run_in <clone-name> <home> <extra env...> -- <command...>: fresh clone, run under env -i, output in $t/out and $t/err
run_in() {
  local name="$1" home="$2"
  shift 2
  local extra=()
  while [ "$1" != "--" ]; do
    extra+=("$1")
    shift
  done
  shift
  rm -rf "$t/clone-$name"
  mkdir -p "$t/clones"
  case "$name" in
    map) gitq clone -q "$t/map-origin.git" "$t/clones/site-map-refresh" 2> /dev/null; cd "$t/clones/site-map-refresh" ;;
    *) gitq clone -q "$t/$name-origin.git" "$t/clones/$name" 2> /dev/null; cd "$t/clones/$name" ;;
  esac
  reset_records
  rc=0
  env -i PATH="$STUBPATH" HOME="$home" "${extra[@]}" "$@" > "$t/out" 2> "$t/err" || rc=$?
  cd "$t"
  rm -rf "$t/clones"
}

# ---- (b) env -i runs of the three entry points ------------------------------------------------------------
for h in with without; do
  want=token-set
  [ "$h" = with ] || want=token-unset

  run_in web "$t/home-$h" -- bash scripts/publish-web.sh --promote 99999999-8888-7777-6666-555555555555
  [ "$rc" = 0 ] || fail "publish-web.sh ($h file): exit $rc: $(cat "$t/err")"
  [ "$(first_token)" = "$want" ] || fail "publish-web.sh ($h file): first wrangler call saw $(first_token), wanted $want"
  no_unbound "$t/err" "publish-web.sh ($h file)"
  no_dummy_in "$t/out" "publish-web.sh ($h file)"
  no_dummy_in "$t/err" "publish-web.sh ($h file)"
  ok "env -i publish-web.sh --promote, file $h: wrangler saw $want"

  run_in news "$t/home-$h" TMPDIR="$t/tmp" -- bash scripts/publish-news.sh
  [ "$rc" = 0 ] || fail "publish-news.sh ($h file): exit $rc: $(cat "$t/err")"
  [ "$(first_token)" = "$want" ] || fail "publish-news.sh ($h file): first wrangler call saw $(first_token), wanted $want"
  no_unbound "$t/err" "publish-news.sh ($h file)"
  no_dummy_in "$t/out" "publish-news.sh ($h file)"
  no_dummy_in "$t/err" "publish-news.sh ($h file)"
  ok "env -i publish-news.sh, file $h: wrangler saw $want"

  run_in map "$t/home-$h" TMPDIR="$t/tmp" -- bash scripts/refresh-site-map.sh
  [ "$rc" = 0 ] || fail "refresh-site-map.sh ($h file): exit $rc: $(cat "$t/err") $(cat "$t/out")"
  [ "$(first_token)" = "$want" ] || fail "refresh-site-map.sh ($h file): first wrangler call saw $(first_token), wanted $want"
  no_unbound "$t/err" "refresh-site-map.sh ($h file)"
  no_dummy_in "$t/out" "refresh-site-map.sh ($h file)"
  no_dummy_in "$t/err" "refresh-site-map.sh ($h file)"
  ok "env -i refresh-site-map.sh, file $h: wrangler saw $want"
done

run_in web "$t/home-with" LANE_WORKER=1 -- bash scripts/publish-web.sh --promote 99999999-8888-7777-6666-555555555555
[ "$rc" = 0 ] || fail "publish-web.sh (LANE_WORKER set): exit $rc: $(cat "$t/err")"
[ "$(first_token)" = token-unset ] || fail "publish-web.sh (LANE_WORKER set): first wrangler call saw $(first_token), wanted token-unset"
no_dummy_in "$t/out" "publish-web.sh (LANE_WORKER set)"
no_dummy_in "$t/err" "publish-web.sh (LANE_WORKER set)"
ok "env -i publish-web.sh --promote, file with, LANE_WORKER set: wrangler saw token-unset"

# ---- (c) the two scripts that read the names in inline python ---------------------------------------------
for s in create-pokoin-news-tunnel install-hypemeter-a1; do
  reset_records
  rc=0
  env -i PATH="$STUBPATH" HOME="$t/home-without" bash "$here/$s.sh" > "$t/out" 2> "$t/err" || rc=$?
  [ "$rc" != 0 ] || fail "$s: exited 0 with no credentials"
  [ "$(grep -c . "$t/err")" = 1 ] || fail "$s: expected one stderr line, got: $(cat "$t/err")"
  grep -q 'CLOUDFLARE_ACCOUNT_ID' "$t/err" || fail "$s: message lacks CLOUDFLARE_ACCOUNT_ID"
  grep -q 'CLOUDFLARE_API_TOKEN' "$t/err" || fail "$s: message lacks CLOUDFLARE_API_TOKEN"
  grep -q 'cloudflare.env' "$t/err" || fail "$s: message does not name the file it looked in"
  if grep -qE 'Traceback|KeyError|unbound variable' "$t/err"; then fail "$s: traceback or unbound variable"; fi
  [ ! -e "$t/python-calls" ] || fail "$s: python3 ran without credentials"
  ok "$s, file absent: one-line message naming the variables, exit $rc, python3 not run"
done

reset_records
rc=0
env -i PATH="$STUBPATH" HOME="$t/home-with" bash "$here/create-pokoin-news-tunnel.sh" > "$t/out" 2> "$t/err" || rc=$?
[ "$rc" = 0 ] || fail "create-pokoin-news-tunnel with the file: exit $rc: $(cat "$t/err")"
[ -e "$t/python-calls" ] || fail "create-pokoin-news-tunnel with the file: python3 was not reached"
ok "create-pokoin-news-tunnel, file present: passes the check and reaches python3"
reset_records
rc=0
env -i PATH="$STUBPATH" HOME="$t/home-with" bash "$here/install-hypemeter-a1.sh" > "$t/out" 2> "$t/err" || rc=$?
if grep -q 'CLOUDFLARE_ACCOUNT_ID' "$t/err"; then fail "install-hypemeter-a1 with the file: still asks for credentials"; fi
grep -q 'missing oci' "$t/err" || fail "install-hypemeter-a1 with the file: did not reach its tool check: $(cat "$t/err")"
no_dummy_in "$t/err" "install-hypemeter-a1"
ok "install-hypemeter-a1, file present: passes the check and reaches its tool check"

# ---- (d) with-cf-env --------------------------------------------------------------------------------------
[ -x "$here/with-cf-env" ] || fail "with-cf-env is not executable"
ok "with-cf-env is executable"
out="$(env -i PATH="$STUBPATH" HOME="$t/home-with" "$here/with-cf-env" sh -c '[ -n "$CLOUDFLARE_API_TOKEN" ] && echo token-set' 2> "$t/err")"
[ "$out" = token-set ] || fail "with-cf-env: did not run the command with the token set"
[ ! -s "$t/err" ] || fail "with-cf-env: printed on stderr"
case "$out" in *"$DUMMY"*) fail "with-cf-env: output has the credential value" ;; esac
ok "with-cf-env <cmd>: command saw token-set"
rc=0
env -i PATH="$STUBPATH" HOME="$t/home-with" "$here/with-cf-env" > "$t/out" 2> "$t/err" || rc=$?
[ "$rc" = 2 ] || fail "with-cf-env with no command: exit $rc, wanted 2"
grep -q '^usage:' "$t/err" || fail "with-cf-env with no command: no usage line"
[ ! -s "$t/out" ] || fail "with-cf-env with no command: printed on stdout"
no_dummy_in "$t/err" "with-cf-env usage"
ok "with-cf-env with no command: usage on stderr, exit 2"

echo "load-cf-env: ok"
