#!/usr/bin/env bash
# Deploy the Silver unlock price from an exact pokoin-web commit.
# Source of truth: server/pokoin-api/unlock-silver.js (SILVER_PRICE_PKN; the
# web label reads market/src/silver.js).
# Pi runtime receives an overlay on /srv/pokoin/api/current — shared by Web and
# CardVault app clients. This is not a CardVault-app deploy.
set -euo pipefail

die() { echo "deploy-silver-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-silver-api-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/pokoin-api | tar -C "$STAGE" -xf -
SRC="$STAGE/server/pokoin-api"
for file in unlock-silver.js; do
  [[ -f "$SRC/$file" ]] || die "commit is missing server/pokoin-api/$file"
done

say "unlock-silver unit tests"
node --test "$SRC/unlock-silver.test.js"
node --check "$SRC/unlock-silver.js"

release="releases/silver-$SHORT-$STAMP"
say "Pi release $release"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .silver-previous; cp -a \$prev '$release'; mkdir -p '$release/api'"
tar -C "$SRC" -cf - unlock-silver.js \
  | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.pokoin-silver-commit'"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

say "verify health + auth gate (no token → 401, GET → 405)"
healthy=0
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  anon="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18080/api/unlock-silver" || true)"
  get="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/unlock-silver" || true)"
  if [[ "$health" == "200" && "$anon" =~ ^(401|403)$ && "$get" == "405" ]]; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo "health failed (health=$health anon=$anon get=$get) — rolling back" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .silver-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "Pi API verification failed; previous release restored"
fi

say "API live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
say "health=$health anon=$anon get=$get · Silver now $(grep -o "SILVER_PRICE_PKN = [0-9]*" "$SRC/unlock-silver.js")"
