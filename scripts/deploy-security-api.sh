#!/usr/bin/env bash
# Pokoin-web-owned API security rollout (Pi release overlay).
# Run on nezopt:
#
#   scripts/deploy-security-api.sh
#
# Ships ONLY the security files this repository owns into a copy of the live
# Pi release: trusted client IP, the central CORS policy, the request security
# layer (writeHead wrapper, preflight, route-manifest gate), hardened
# firebase auth 401s, and the oracle-api-server glue. Ships the patched sharp
# 0.35.5 overlay for both linux glibc architectures so the x64 k3s pods can
# load it too. Stages on port 18089
# first, verifies behaviour, then switches the release and restarts
# pokoin-oracle-api. Rolls back automatically. Nothing is read from any other
# checkout, so unrelated work in other trees can never ship.
set -euo pipefail

API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGING_CONTAINER="pokoin-oracle-api-staging"
STAGING_PORT=18089
LIVE_PORT=18080
STAMP="$(date -u +%Y%m%d%H%M%S)"
REPO="$(git rev-parse --show-toplevel)"
git -C "$REPO" fetch -q origin
COMMIT="$(git -C "$REPO" rev-parse "${1:-origin/main}^{commit}")"
[[ "$COMMIT" == "$(git -C "$REPO" rev-parse origin/main)" ]] \
  || { echo 'deploy-security-api: use the exact pushed origin/main commit' >&2; exit 1; }
HERE="$(mktemp -d /tmp/pokoin-security-api-source-XXXXXX)"
STAGE_SHARP="$(mktemp -d /tmp/pokoin-sharp-overlay-XXXXXX)"
trap 'rm -rf "$HERE" "$STAGE_SHARP"' EXIT
git -C "$REPO" archive "$COMMIT" | tar -C "$HERE" -xf -
export NODE_PATH="${REPO}/server/node_modules${NODE_PATH:+:$NODE_PATH}"

# Files this repository owns, as "source-path:release-path" pairs.
API_FILES=(
  "server/pokoin-api/_client_ip.js:api/_client_ip.js"
  "server/pokoin-api/_cors_policy.js:api/_cors_policy.js"
  "server/pokoin-api/_http_security.js:api/_http_security.js"
  "server/pokoin-api/_rate_limit.js:api/_rate_limit.js"
  "server/pokoin-api/_route_limits.js:api/_route_limits.js"
  "server/pokoin-api/poko-chat.js:api/poko-chat.js"
  "server/pokoin-api/trainingai-card-classify.js:api/trainingai-card-classify.js"
  "server/pokoin-api/marketplace-image-log.js:api/marketplace-image-log.js"
  "server/pokoin-api/marketplace-recommendations.js:api/marketplace-recommendations.js"
  "server/pokoin-api/_scan_http.js:api/_scan_http.js"
  "server/pokoin-api/news-comments.js:api/news-comments.js"
  "server/api/_firebase.js:api/_firebase.js"
  "server/server/oracle-api-server.js:server/oracle-api-server.js"
)

die() { echo "deploy-security-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

SHARP_VERSION=0.35.5
SHARP_CHECK="const sharp=require(\"sharp\");if(sharp.versions.sharp!==\"$SHARP_VERSION\"){console.error(\"sharp\",sharp.versions.sharp);process.exit(1)}sharp({create:{width:64,height:64,channels:3,background:\"#c33\"}}).rotate().resize(32,32).webp().toBuffer().then(b=>{if(!b||!b.length){console.error(\"empty buffer\");process.exit(1)}console.log(\"sharp\",sharp.versions.sharp,process.arch,b.length)}).catch(e=>{console.error(e);process.exit(1)})"

for pair in "${API_FILES[@]}"; do
  src="${pair%%:*}"
  [[ -f "$HERE/$src" ]] || die "missing $HERE/$src"
done

say "security unit tests"
(cd "$HERE" && NODE_PATH="${REPO}/server/node_modules" node --test \
  server/pokoin-api/_client_ip.test.js \
  server/pokoin-api/_cors_policy.test.js \
  server/pokoin-api/_http_security.test.js \
  server/pokoin-api/_rate_limit.test.js \
  server/pokoin-api/_route_limits.test.js \
  server/api/_firebase.test.js >"/tmp/security-api-tests-$STAMP.log" 2>&1) \
  || { tail -30 "/tmp/security-api-tests-$STAMP.log" >&2; die "server tests failed"; }
grep -E "^# (tests|pass|fail)" "/tmp/security-api-tests-$STAMP.log"

release="releases/security-api-$STAMP"
say "Pi release $release = live release + ${#API_FILES[@]} security files"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .security-api-previous; cp -a \$prev $release"
for pair in "${API_FILES[@]}"; do
  src="${pair%%:*}"
  dest="${pair##*:}"
  ssh pi-home "set -e; mkdir -p /srv/pokoin/api/$release/$(dirname "$dest")"
  tar -C "$HERE" -cf - "$src" | ssh pi-home "tar -C /srv/pokoin/api/$release -xf - --transform 's|^$src|$dest|'"
done

say "sharp $SHARP_VERSION overlay (linux glibc arm64 + x64)"
bash "$HERE/scripts/build-sharp-overlay.sh" "$STAGE_SHARP"
ssh pi-home "set -e; cd /srv/pokoin/api/$release; rm -rf node_modules/sharp node_modules/@img/sharp-*; mkdir -p node_modules/@img"
tar -C "$STAGE_SHARP" -cf - node_modules | ssh pi-home "tar -C /srv/pokoin/api/$release -xf -"

say "syntax check on the Pi"
ssh pi-home "docker run --rm -v /srv/pokoin/api/$release:/app -w /app node:20-bookworm node --check server/oracle-api-server.js"

staging_fail() {
  echo "staging failed — deleting $release, current untouched" >&2
  ssh pi-home "rm -rf /srv/pokoin/api/$release" || true
  exit 1
}

say "sharp checks (arm64 on the Pi, x64 here on nezopt)"
ssh pi-home "docker run --rm -v /srv/pokoin/api/$release:/app:ro -w /app node:20-bookworm node -e '$SHARP_CHECK'" \
  || staging_fail
docker run --rm -v "$STAGE_SHARP/x64check/node_modules:/app/node_modules:ro" -w /app node:20-bookworm node -e "$SHARP_CHECK" \
  || staging_fail

say "staging on :$STAGING_PORT"
ssh pi-home "docker rm -f $STAGING_CONTAINER >/dev/null 2>&1 || true; docker run -d --name $STAGING_CONTAINER --network host --env-file /srv/pokoin/api/container.env -e PORT=$STAGING_PORT -v /srv/pokoin/api/$release:/app -v /etc/pokoin/pg-ca:/etc/pokoin/pg-ca:ro -w /app node:20-bookworm node server/oracle-api-server.js >/dev/null"
trap 'ssh pi-home "docker rm -f '"$STAGING_CONTAINER"' >/dev/null 2>&1 || true"; rm -rf "$HERE" "$STAGE_SHARP"' EXIT
staging_ok=0
for i in $(seq 1 60); do
  code="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:$STAGING_PORT/readyz'" 2>/dev/null || true)"
  if [[ "$code" == "200" ]]; then
    staging_ok=1
    break
  fi
  sleep 1
done
[[ "$staging_ok" == "1" ]] || staging_fail

say "staging behaviour checks"
suggest="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:$STAGING_PORT/api/marketplace-suggest?q=pika&limit=1'")"
[[ "$suggest" == "200" ]] || staging_fail
routes="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:$STAGING_PORT/api/__routes'")"
[[ "$routes" == "404" ]] || staging_fail
badtoken_body="$(ssh pi-home "curl -s -H 'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln' 'http://127.0.0.1:$STAGING_PORT/api/account-addresses'")"
badtoken_code="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln' 'http://127.0.0.1:$STAGING_PORT/api/account-addresses'")"
[[ "$badtoken_code" == "401" ]] || staging_fail
[[ "$badtoken_body" != *aud* ]] || staging_fail
preflight_headers="$(ssh pi-home "curl -s -o /dev/null -D - -X OPTIONS -H 'Origin: https://pokoin.com' -H 'Access-Control-Request-Method: POST' 'http://127.0.0.1:$STAGING_PORT/api/marketplace-listings'")"
preflight_code="$(printf '%s' "$preflight_headers" | awk 'NR==1 {print $2}')"
[[ "$preflight_code" == "204" ]] || staging_fail
printf '%s' "$preflight_headers" | grep -qi '^access-control-allow-origin: https://pokoin.com$' || staging_fail
printf '%s' "$preflight_headers" | grep -qi '^access-control-allow-credentials: true$' || staging_fail
evil_headers="$(ssh pi-home "curl -s -o /dev/null -D - -H 'Origin: https://evil.example' 'http://127.0.0.1:$STAGING_PORT/api/marketplace-suggest?q=pika&limit=1'")"
printf '%s' "$evil_headers" | grep -qi '^access-control-allow-origin: \*$' || staging_fail
if printf '%s' "$evil_headers" | grep -qi '^access-control-allow-credentials:'; then
  staging_fail
fi

# Global route limiter: 11 POSTs from one TEST-NET-2 IP, the 11th is a 429
# rate_limited (limit 10/hour, counted in the shared Postgres store).
LIMIT_IP="198.51.100.$((RANDOM % 254 + 1))"
last_code=""
last_body=""
for i in $(seq 1 11); do
  last_body="$(ssh pi-home "curl -s -w '\n%{http_code}' -H 'cf-connecting-ip: $LIMIT_IP' -H 'content-type: application/json' -d '{}' 'http://127.0.0.1:$STAGING_PORT/api/register-email'")"
  last_code="$(printf '%s' "$last_body" | tail -n 1)"
  last_body="$(printf '%s' "$last_body" | sed '$d')"
done
[[ "$last_code" == "429" ]] || staging_fail
printf '%s' "$last_body" | grep -q '"code":"rate_limited"' || staging_fail

# Cache-poisoning guard: game selected by header (no ?game=) is not cacheable.
poison_headers="$(ssh pi-home "curl -s -o /dev/null -D - -H 'x-pokoin-game: one_piece' 'http://127.0.0.1:$STAGING_PORT/api/marketplace-expansion-page?limit=1'")"
printf '%s' "$poison_headers" | grep -qi '^cache-control:.*no-store' || staging_fail
printf '%s' "$poison_headers" | grep -qi '^cdn-cache-control: no-store' || staging_fail

say "staging OK (suggest 200 · __routes 404 · bad token 401 no aud · preflight 204 · evil origin * · rate limit 429 · no-store on game header)"

say "switching current"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn $release current.new && mv -Tf current.new current; docker restart $API_CONTAINER >/dev/null"

live_ok=0
for i in $(seq 1 45); do
  readyz="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:$LIVE_PORT/readyz'" 2>/dev/null || true)"
  routes_live="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:$LIVE_PORT/api/__routes'" 2>/dev/null || true)"
  badtoken_live="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln' 'http://127.0.0.1:$LIVE_PORT/api/account-addresses'" 2>/dev/null || true)"
  if [[ "$readyz" == "200" && "$routes_live" == "404" && "$badtoken_live" == "401" ]]; then
    live_ok=1
    break
  fi
  sleep 2
done

if [[ "$live_ok" == "1" ]]; then
  say "api live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
  say "summary: security-api deployed to $release (trusted client IP, central CORS, preflight, no public route manifest, hardened auth 401s, sharp $SHARP_VERSION (arm64+x64))"
  exit 0
fi

echo "live health failed — rolling back" >&2
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .security-api-previous); ln -sfn \$prev current.new && mv -Tf current.new current; docker restart $API_CONTAINER >/dev/null; echo restored \$prev"
exit 1
