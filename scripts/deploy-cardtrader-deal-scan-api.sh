#!/usr/bin/env bash
# Deploy CardTrader deal-scan API from an exact pokoin-web commit on origin/main.
set -euo pipefail

die() { echo "deploy-cardtrader-deal-scan-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-deal-scan-api-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

FILES=(
  cardtrader-deal-scan.js
  cardtrader-deal-scan.test.js
  route-definitions.json
  patch-route-manifest.js
)

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
prev_main=""
for _ in $(seq 1 10); do
  cur_main="$(git -C "$REPO" rev-parse origin/main)"
  [ "$cur_main" = "$prev_main" ] && break
  prev_main="$cur_main"
  sleep 3
  git -C "$REPO" fetch -q origin || true
done
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/pokoin-api | tar -C "$STAGE" -xf -
SRC="$STAGE/server/pokoin-api"
for file in "${FILES[@]}"; do
  [[ -f "$SRC/$file" ]] || die "commit is missing server/pokoin-api/$file"
done

say "unit tests"
node --test "$SRC/cardtrader-deal-scan.test.js"
node --check "$SRC/cardtrader-deal-scan.js"

release="releases/ct-deal-scan-$SHORT-$STAMP"
say "Pi release $release"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .ct-deal-scan-previous; cp -a \$prev '$release'; mkdir -p '$release/api'"
tar -C "$SRC" -cf - "${FILES[@]}" \
  | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"
ssh pi-home "node '/srv/pokoin/api/$release/api/patch-route-manifest.js' '/srv/pokoin/api/$release/server/api-route-manifest.js' '/srv/pokoin/api/$release/api/route-definitions.json'; rm '/srv/pokoin/api/$release/api/patch-route-manifest.js' '/srv/pokoin/api/$release/api/route-definitions.json' '/srv/pokoin/api/$release/api/cardtrader-deal-scan.test.js'"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.ct-deal-scan-commit'"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

say "verify health + auth guard"
healthy=0
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  unauth="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:18080/api/cardtrader-deal-scan?seller=x'" || true)"
  if [[ "$health" == "200" && ( "$unauth" == "401" || "$unauth" == "503" ) ]]; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo "health failed (health=$health deal-scan=$unauth) — rolling back" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .ct-deal-scan-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "Pi API verification failed; previous release restored"
fi

say "API live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
say "health=$health deal-scan unauthenticated=$unauth (expect 401 or 503 if DEAL_SCAN_TOKEN unset)"
say "set DEAL_SCAN_TOKEN in pokoin-oracle-api env before first use"
