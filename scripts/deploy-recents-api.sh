#!/usr/bin/env bash
# Deploy game-scoped Recently Seen from an exact pokoin-web commit.
# Source of truth: server/pokoin-api/marketplace-recents.js
# Pi runtime receives an overlay on /srv/pokoin/api/current — shared by Web and
# CardVault app clients. This is not a CardVault-app deploy.
set -euo pipefail

die() { echo "deploy-recents-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-recents-api-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/pokoin-api | tar -C "$STAGE" -xf -
SRC="$STAGE/server/pokoin-api"
for file in marketplace-recents.js; do
  [[ -f "$SRC/$file" ]] || die "commit is missing server/pokoin-api/$file"
done

say "recents unit tests"
node --test "$SRC/marketplace-recents.test.js"
node --check "$SRC/marketplace-recents.js"

release="releases/recents-$SHORT-$STAMP"
say "Pi release $release"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .recents-previous; cp -a \$prev '$release'; mkdir -p '$release/api'"
tar -C "$SRC" -cf - marketplace-recents.js \
  | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.pokoin-recents-commit'"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

say "verify health + recents auth guard (missing game → 400, missing auth → 401)"
healthy=0
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  noauth="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:18080/api/marketplace-recents?game=pokemon'" || true)"
  nogame="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer invalid' 'http://127.0.0.1:18080/api/marketplace-recents'" || true)"
  # noauth should be 401; nogame with bad token may be 401 before game check — accept 400 or 401
  if [[ "$health" == "200" && "$noauth" =~ ^(401|403)$ && "$nogame" =~ ^(400|401|403)$ ]]; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo "health failed (health=$health noauth=$noauth nogame=$nogame) — rolling back" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .recents-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "Pi API verification failed; previous release restored"
fi

say "API live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
say "health=$health marketplace-recents noauth=$noauth nogame=$nogame"
say "Apply scripts/sql/090_marketplace_user_recents_game.sql on the nezopt writer before relying on game-scoped writes:"
say "  docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace -d pokoin_marketplace -v ON_ERROR_STOP=1 < scripts/sql/090_marketplace_user_recents_game.sql"
