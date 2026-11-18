#!/bin/sh
# Tests scripts/marketplace-home-purge.sh against a stub curl: no Cloudflare call,
# no production host, no real token. The stub records every argument, the curl
# config file it is handed, and the request body on stdin, so the checks cover what
# must be true of the purge: five variants per rail path (the api. host plain and
# under each page Origin, plus the site and www same-origin copies), at most 30
# files per request with a path's variants never split, the token and zone id never
# in an argument or in the output, a refused purge reported as a failure, a missing
# variable reported by name only, and --dry-run sending nothing at all.
# Run: sh scripts/marketplace-home-purge.test.sh
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
base=$(mktemp -d "${TMPDIR:-$HOME/scratch/tmp}/marketplace-home-purge-test.XXXXXX")
trap 'rm -rf "$base"' EXIT INT TERM
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
TOKEN='tok-8kQ2sampleNotARealValue'
ZONE='zone7f21abc'
script=$repo/scripts/marketplace-home-purge.sh

mkdir -p "$base/bin"
: >"$base/argv.log"
: >"$base/configs.log"
: >"$base/bodies.log"
printf '%s\n' '{"success":true,"errors":[],"result":{"id":"x"}}' >"$base/reply.json"

cat >"$base/bin/curl" <<'STUB'
#!/bin/sh
# One fake Cloudflare call: log the arguments, the config file curl was pointed at
# and its mode, and the body on stdin; answer with the fixture the test chose.
printf 'argv:' >>"$STUB_ARGV"
for a in "$@"; do printf ' [%s]' "$a"; done
printf '\n' >>"$STUB_ARGV"
cfg=''
out=''
while [ "$#" -gt 0 ]; do
    case "$1" in
        -o) out=${2:-}; shift 2 ;;
        --config) cfg=${2:-}; shift 2 ;;
        *) shift ;;
    esac
done
if [ -n "$cfg" ] && [ -f "$cfg" ]; then
    printf 'mode=%s\n' "$(stat -c '%a' "$cfg")" >>"$STUB_CONFIGS"
    cat "$cfg" >>"$STUB_CONFIGS"
    printf 'private-dir=%s\n' "$(dirname "$cfg")" >>"$STUB_CONFIGS"
fi
body=$(cat)
printf '%s\n' "$body" >>"$STUB_BODIES"
if [ -n "$out" ]; then
    cp "$PURGE_STUB_REPLY" "$out"
fi
exit "${PURGE_STUB_EXIT:-0}"
STUB
chmod +x "$base/bin/curl"

STUB_ARGV="$base/argv.log" STUB_CONFIGS="$base/configs.log" STUB_BODIES="$base/bodies.log"
PURGE_STUB_REPLY="$base/reply.json"
export STUB_ARGV STUB_CONFIGS STUB_BODIES PURGE_STUB_REPLY
PATH="$base/bin:$PATH"
export PATH

# --dry-run: the urls, and nothing sent — not even a curl process.
dry=$(CLOUDFLARE_ZONE_ID='' CLOUDFLARE_API_TOKEN='' bash "$script" --dry-run 2>&1) ||
    fail 'dry-run exited non-zero'
printf '%s\n' "$dry" >"$base/dry.txt"
if [ -s "$STUB_ARGV" ]; then
    fail 'dry-run called curl'
fi
n_urls=$(( $(wc -l <"$base/dry.txt") / 5 ))
if [ "$n_urls" -lt 10 ]; then
    fail "dry-run listed only $n_urls urls"
fi
# The rail lives on the API host the SPA fetches it from (PUBLIC_API_ORIGIN in
# market/src/extension-auth-bridge.js), cached once per request Origin.
grep -qx 'https://api.pokoin.com/api/marketplace-home/new-cards' "$base/dry.txt" ||
    fail 'dry-run lost the new-cards rail on the api host'
grep -qx 'https://api.pokoin.com/api/marketplace-home/new-cards with Origin https://pokoin.com' \
    "$base/dry.txt" || fail 'the pokoin.com Origin variant of the api host is missing'
grep -qx 'https://api.pokoin.com/api/marketplace-home/new-cards with Origin https://www.pokoin.com' \
    "$base/dry.txt" || fail 'the www Origin variant of the api host is missing'
grep -qx 'https://pokoin.com/api/marketplace-home/new-cards' "$base/dry.txt" ||
    fail 'dry-run lost the same-origin site copy'
grep -qx 'https://www.pokoin.com/api/marketplace-home/new-cards' "$base/dry.txt" ||
    fail 'dry-run lost the same-origin www copy'
grep -q '^https://api\.pokoin\.com/api/marketplace-rails?id=set%3A' "$base/dry.txt" ||
    fail 'dry-run lost the encoded set rail'
count() { grep -c "$1" "$base/dry.txt" || true; }
if [ "$(count '^https://api\.pokoin\.com/.* with Origin https://pokoin\.com$')" != "$n_urls" ]; then
    fail 'not every url carries the pokoin.com Origin variant on the api host'
fi
if [ "$(count '^https://api\.pokoin\.com/.* with Origin https://www\.pokoin\.com$')" != "$n_urls" ]; then
    fail 'not every url carries the www Origin variant on the api host'
fi
if [ "$(count '^https://api\.pokoin\.com/')" != $((n_urls * 3)) ]; then
    fail 'the api host does not carry three entries per url'
fi
if [ "$(count '^https://pokoin\.com/')" != "$n_urls" ]; then
    fail 'not every url carries one same-origin site entry'
fi
if [ "$(count '^https://www\.pokoin\.com/')" != "$n_urls" ]; then
    fail 'not every url carries one same-origin www entry'
fi
if [ "$(grep -vc ' with Origin ' "$base/dry.txt")" != $((n_urls * 3)) ]; then
    fail 'the plain entries are not three per url'
fi
sort "$base/dry.txt" >"$base/dry.sorted"

run() { # run <label> <expected exit> -- <script args...>
    label=$1
    want=$2
    shift 3
    out=$(CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ZONE_ID="$ZONE" bash "$script" "$@" 2>&1) && got=0 || got=$?
    printf '%s\n' "$out" >"$base/out.log"
    if [ "$got" != "$want" ]; then
        fail "$label: exit $got, wanted $want (output: $out)"
    fi
}

# A real purge: exactly the dry-run urls, sent as whole variant groups.
run 'purge' 0 --
requests=$(grep -c '^argv:' "$STUB_ARGV")
if [ "$requests" -lt 2 ]; then
    fail 'one request only: batching is unproven'
fi
for what in "$TOKEN:token" "$ZONE:zone id"; do
    value=${what%%:*}
    label=${what##*:}
    if grep -qF -- "$value" "$STUB_ARGV"; then
        fail "the $label reached a curl argument"
    fi
    if grep -qF -- "$value" "$base/out.log"; then
        fail "the $label was printed"
    fi
done
grep -qF -- "$TOKEN" "$base/configs.log" || fail 'no Authorization header was handed to curl'
grep -q '^mode=600$' "$base/configs.log" || fail 'the curl config is not 0600'
if [ "$(grep -c '^purged [0-9]* urls: ok$' "$base/out.log")" != "$requests" ]; then
    fail 'not every request reported exactly one ok line'
fi
# The files that were sent must be the files --dry-run promised.
jq -s -c '[ .[].files[] |
    (if type == "object" then .url + " with Origin " + .headers.Origin else . end) ] | sort' \
    "$base/bodies.log" | jq -r '.[]' | sort >"$base/sent.txt"
if ! diff -u "$base/dry.sorted" "$base/sent.txt" >/dev/null; then
    fail 'the purged files differ from the dry-run list'
fi
jq -s '[ .[].files | length ]' "$base/bodies.log" >"$base/sizes.json"
if [ "$(jq 'map(select(. > 30)) | length' "$base/sizes.json")" != 0 ]; then
    fail 'a request sent more than 30 files'
fi
# Inside every request, every url that appears appears with all five of its
# entries: an Origin variant left for the next batch would keep serving the old rail.
jq -s -c '[ .[] | .files | (length) as $n |
    ([ .[] | (if type == "object" then .url else . end) |
        sub("^https://api\\.pokoin\\.com"; "") | sub("^https://www\\.pokoin\\.com"; "") |
        sub("^https://pokoin\\.com"; "") ] | unique | length) as $k |
    [$n, $k] ]' "$base/bodies.log" >"$base/groups.json"
if [ "$(jq 'map(select(.[0] != .[1] * 5)) | length' "$base/groups.json")" != 0 ]; then
    fail 'a url variant group was split across requests'
fi
reported=$(sed -n 's/^purged \([0-9]*\) urls: ok$/\1/p' "$base/out.log" |
    awk '{ total += $1 } END { print total + 0 }')
if [ "$reported" != "$n_urls" ]; then
    fail "the requests covered $reported urls, not $n_urls"
fi

# Cloudflare refusing is a failure the publish chain has to see.
printf '%s\n' \
    '{"success":false,"errors":[{"code":1134,"message":"Unable to purge, rate limit reached."}],"result":null}' \
    >"$base/reply.json"
run 'refused purge' 1 --
grep -q 'Unable to purge, rate limit reached.' "$base/out.log" ||
    fail 'the Cloudflare message was swallowed'
if grep -qF -- "$TOKEN" "$base/out.log"; then
    fail 'the token was printed by a failing run'
fi

# Without either variable nothing is sent, and the run names the one that is missing.
for label in 'zone id' 'token'; do
    if [ "$label" = 'zone id' ]; then
        missing=CLOUDFLARE_ZONE_ID
        zone=''
        token=$TOKEN
    else
        missing=CLOUDFLARE_API_TOKEN
        zone=$ZONE
        token=''
    fi
    : >"$base/argv-silent.log"
    # shellcheck disable=SC2034  # the script reads both through the environment
    out=$(STUB_ARGV="$base/argv-silent.log" CLOUDFLARE_ZONE_ID="$zone" \
        CLOUDFLARE_API_TOKEN="$token" bash "$script" 2>&1) && got=0 || got=$?
    if [ "$got" != 2 ]; then
        fail "missing $label: exit $got, wanted 2 (output: $out)"
    fi
    case $out in
        *"$missing"*) ;;
        *) fail "missing $label was not named: $out" ;;
    esac
    if printf '%s' "$out" | grep -qF -- "$TOKEN"; then
        fail "the token was printed by the missing-$label exit"
    fi
    if [ -s "$base/argv-silent.log" ]; then
        fail "a run without $label still called curl"
    fi
done

gone=$(grep '^private-dir=' "$base/configs.log" | cut -d= -f2 || true)
if [ -z "$gone" ]; then
    fail 'the stub never saw a curl config path'
fi
for dir in $gone; do
    if [ -e "$dir" ]; then
        fail "the script left $dir behind after it finished"
    fi
done

printf 'marketplace-home-purge: %s urls, %s purge requests, ok\n' "$n_urls" "$requests"
