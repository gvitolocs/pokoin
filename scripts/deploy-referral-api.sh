#!/usr/bin/env bash
# Deploy Invite & Earn + the Ambassador program API from an exact pokoin-web
# commit: /api/marketplace-referral, the associate API (city), and the
# pokoin-referral-reconcile timer. Apply scripts/sql/096_ambassador_program.sql
# on the writer first — the associate API selects marketplace_associates.city.
set -euo pipefail

die() { echo "deploy-referral-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-referral-api-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

FILES=(marketplace-referral.js _referral_core.js _ambassador_core.js referral-reconcile.js marketplace-associate.js marketplace-associate-suggest.js)

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/pokoin-api scripts/pokoin-referral-reconcile.service scripts/pokoin-referral-reconcile.timer \
  | tar -C "$STAGE" -xf -
SRC="$STAGE/server/pokoin-api"
for file in "${FILES[@]}"; do
  [[ -f "$SRC/$file" ]] || die "commit is missing server/pokoin-api/$file"
  node --check "$SRC/$file"
done

say "unit tests"
node --test "$SRC/_referral_core.test.js" "$SRC/marketplace-referral.test.js" "$SRC/marketplace-associate.test.js"

say "writer has 096 (marketplace_associates.city)"
# Runs on nezopt, where the writer container lives.
docker exec pokoin-marketplace-postgres-15t psql -U pokoin_marketplace -d pokoin_marketplace -tAc \
  "select count(*) from information_schema.columns where table_name='marketplace_associates' and column_name='city'" \
  | grep -qx 1 || die "apply scripts/sql/096_ambassador_program.sql on the writer first"

release="releases/referral-$SHORT-$STAMP"
say "Pi release $release"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .referral-previous; cp -a \$prev '$release'; mkdir -p '$release/api'"
tar -C "$SRC" -cf - "${FILES[@]}" | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.pokoin-referral-commit'"

say "patch Pi route manifest"
ssh pi-home "cat '/srv/pokoin/api/$release/server/api-route-manifest.js'" > "$STAGE/manifest.js"
node -e '
const fs = require("node:fs");
const all = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const wanted = ["/api/marketplace-referral", "/api/marketplace-associate", "/api/marketplace-associate-suggest"];
const routes = all.filter((row) => wanted.includes(row.path));
if (routes.length !== wanted.length) throw new Error("route-definitions.json is missing a referral/associate route");
fs.writeFileSync(process.argv[2], JSON.stringify(routes, null, 2));
' "$SRC/route-definitions.json" "$STAGE/referral-routes.json"
node "$SRC/patch-route-manifest.js" "$STAGE/manifest.js" "$STAGE/referral-routes.json"
node --check "$STAGE/manifest.js"
ssh pi-home "cat > '/srv/pokoin/api/$release/server/api-route-manifest.js'" < "$STAGE/manifest.js"

ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

say "verify health + auth gates"
healthy=0
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  referral="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/marketplace-referral" || true)"
  associate="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/marketplace-associate" || true)"
  if [[ "$health" == "200" && "$referral" == "401" && "$associate" == "401" ]]; then
    healthy=1
    break
  fi
  sleep 2
done
if [[ "$healthy" != "1" ]]; then
  echo "health failed (health=$health referral=$referral associate=$associate) — rolling back" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .referral-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "Pi API verification failed; previous release restored"
fi

say "reconcile dry run, then install the timer"
ssh pi-home "docker exec -w /app '$API_CONTAINER' node /app/api/referral-reconcile.js --dry-run"
scp -q "$STAGE/scripts/pokoin-referral-reconcile.service" "$STAGE/scripts/pokoin-referral-reconcile.timer" pi-home:/tmp/
ssh pi-home "set -e; \
  sudo install -m 0644 /tmp/pokoin-referral-reconcile.service /etc/systemd/system/; \
  sudo install -m 0644 /tmp/pokoin-referral-reconcile.timer /etc/systemd/system/; \
  sudo systemctl daemon-reload; \
  sudo systemctl enable --now pokoin-referral-reconcile.timer; \
  sudo systemctl start pokoin-referral-reconcile.service; \
  systemctl is-active pokoin-referral-reconcile.timer; \
  systemctl show pokoin-referral-reconcile.service -p Result --value"

say "deployed $COMMIT — anonymous referral/associate GETs are 401; sign in on pokoin.com/invite to verify."
