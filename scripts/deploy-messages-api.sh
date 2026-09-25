#!/usr/bin/env bash
# Deploy the conversation/payment API from an exact pokoin-web commit.
# Source of truth stays in this repository under server/pokoin-api; the Pi
# runtime receives only these handlers in a cloned, atomic API release.
set -euo pipefail

die() { echo "deploy-messages-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-messages-api-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/pokoin-api | tar -C "$STAGE" -xf -
SRC="$STAGE/server/pokoin-api"
for file in chat.js money-request.js _chat_core.js _money_request_core.js route-definitions.json patch-route-manifest.js; do
  [[ -f "$SRC/$file" ]] || die "commit is missing server/pokoin-api/$file"
done

say "API core tests"
# The staged tree is server/pokoin-api only. CardTrader handler tests need the
# Pi layout (api/ beside server/) and cannot load here.
node --test \
  "$SRC/_chat_core.test.js" \
  "$SRC/_money_request_core.test.js" \
  "$SRC/patch-route-manifest.test.js"
node --check "$SRC/chat.js"
node --check "$SRC/money-request.js"

release="releases/messages-$SHORT-$STAMP"
say "Pi release $release"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .messages-previous; cp -a \$prev '$release'; mkdir -p '$release/api'"
tar -C "$SRC" -cf - chat.js money-request.js _chat_core.js _money_request_core.js route-definitions.json patch-route-manifest.js \
  | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"
ssh pi-home "node '/srv/pokoin/api/$release/api/patch-route-manifest.js' '/srv/pokoin/api/$release/server/api-route-manifest.js' '/srv/pokoin/api/$release/api/route-definitions.json'; rm '/srv/pokoin/api/$release/api/patch-route-manifest.js' '/srv/pokoin/api/$release/api/route-definitions.json'"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.pokoin-messages-commit'"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

say "verify routes and authentication guard"
healthy=0
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  chat="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:18080/api/chat?action=list'" || true)"
  requests="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:18080/api/money-request?action=list'" || true)"
  if [[ "$health" == "200" && "$chat" =~ ^(401|403)$ && "$requests" =~ ^(401|403)$ ]]; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo "health failed (health=$health chat=$chat money-request=$requests) — rolling back" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .messages-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "Pi API verification failed; previous release restored"
fi

say "API live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
say "health=$health chat=$chat money-request=$requests"
