#!/usr/bin/env bash
# Scan Connect production rollout (docs/SCAN_CONNECT.md#going-live-on-dashboardpokoincom).
# Run from the Mac (SSH aliases nezopt, pi-home, oracle-peer1; Vercel CLI logged in).
# Order matters: migrate → api → scanner → web. Each step verifies itself and stops on failure.
#
#   scripts/deploy-scan-connect.sh migrate     # 082 on the writer (nezopt :25432), grants to the API writer role
#   scripts/deploy-scan-connect.sh api         # new Pi release = current + scan files, restart pokoin-oracle-api
#   scripts/deploy-scan-connect.sh scanner     # peer1 /opt/pokoin-cardscan web + /connect route, with backup
#   scripts/deploy-scan-connect.sh web         # Vercel prebuilt prod deploy (pokoin.com + dashboard.pokoin.com)
#   scripts/deploy-scan-connect.sh rollback-api | rollback-scanner
set -euo pipefail

PROJECTS="${PROJECTS:-/Users/giuseppe/mnt/nezopt/Projects}"
CARDVAULT="$PROJECTS/cardvault/pokemon_card_vault"
BATTLESCAN="$PROJECTS/BattleScan"
WEB="$PROJECTS/pokoin-web"
STAMP="$(date -u +%Y%m%d%H%M%S)"
PG_CONTAINER="${PG_CONTAINER:-pokoin-marketplace-postgres-15t}"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"

# CardVault files this release touches (new + modified). Nothing else is copied,
# so unrelated uncommitted work in the nezopt tree never ships with it.
API_FILES=(
  api/_scan_connect.js api/_scan_store.js api/_scan_bus.js api/_scan_http.js
  api/scan-session.js api/scan-pair.js api/scan-phone.js api/scan-batch.js api/scan-stream.js
  api/marketplace-listings.js
  server/api-route-manifest.js server/api-route-families.js
  oracle-postgres/schema/082_scan_connect.sql
)

die() { echo "error: $*" >&2; exit 1; }
say() { echo "== $*"; }

writer_role() {
  # Username of MARKETPLACE_WRITER_DATABASE_URL inside the running API (never prints the password).
  ssh pi-home "pid=\$(docker inspect -f '{{.State.Pid}}' $API_CONTAINER); sudo -n cat /proc/\$pid/environ 2>/dev/null || docker exec $API_CONTAINER cat /proc/1/environ" \
    | tr '\0' '\n' | sed -nE 's#^MARKETPLACE_WRITER_DATABASE_URL=[a-z]+://([^:@/]+).*#\1#p' | head -1
}

cmd_migrate() {
  local role
  role="$(writer_role)"
  [[ -n "$role" ]] || die "could not read the API writer role"
  say "writer role: $role"
  ssh nezopt "docker exec -i $PG_CONTAINER psql -U postgres -d pokoin_marketplace -v ON_ERROR_STOP=1 -Atc 'select pg_is_in_recovery()'" | grep -qx f \
    || die "writer is in recovery (not the primary)"
  say "apply 082_scan_connect.sql (idempotent: create if not exists / add column if not exists)"
  ssh nezopt "docker exec -i $PG_CONTAINER psql -U postgres -d pokoin_marketplace -v ON_ERROR_STOP=1" < "$CARDVAULT/oracle-postgres/schema/082_scan_connect.sql"
  say "grants for $role"
  ssh nezopt "docker exec -i $PG_CONTAINER psql -U postgres -d pokoin_marketplace -v ON_ERROR_STOP=1 -v api_role=$role" \
    < "$CARDVAULT/oracle-postgres/schema/082_scan_connect.grants.sql"
  say "verify"
  ssh nezopt "docker exec -i $PG_CONTAINER psql -U postgres -d pokoin_marketplace -Atc \"
    select string_agg(tablename, ',' order by tablename) from pg_tables where tablename like 'scan_%';
    select count(*) from information_schema.columns where table_name = 'marketplace_user_listings' and column_name in ('location','altered');\""
}

cmd_api() {
  for f in "${API_FILES[@]}"; do [[ -f "$CARDVAULT/$f" ]] || die "missing $f"; done
  say "unit tests"
  (cd "$CARDVAULT" && node --test api/_scan_connect.test.js api/marketplace-listings.test.js server/api-route-families.test.js >/dev/null) \
    || die "CardVault tests failed"
  ssh pi-home "psql_ok=\$(docker exec $API_CONTAINER node -e \"require('/app/api/_marketplace_db').marketplaceWriteQuery('select to_regclass(\\\$\\\$public.scan_items\\\$\\\$) as t').then(r=>{console.log(r.rows[0].t||'');process.exit(0)}).catch(()=>process.exit(1))\"); [ \"\$psql_ok\" = scan_items ]" \
    || die "writer has no scan_items: run migrate first"
  local release="releases/scan-connect-$STAMP"
  say "new Pi release $release (copy of current)"
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .scan-connect-previous; cp -a \$prev $release"
  say "copy ${#API_FILES[@]} files"
  tar -C "$CARDVAULT" -cf - "${API_FILES[@]}" | ssh pi-home "tar -C /srv/pokoin/api/$release -xf -"
  ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn $release current.new && mv -Tf current.new current; docker restart $API_CONTAINER >/dev/null"
  say "health"
  for i in $(seq 1 30); do
    if ssh pi-home "curl -fsS 'http://127.0.0.1:18080/api/__routes?family=scan'" 2>/dev/null | grep -q scan-pair; then
      ssh pi-home "curl -s -o /dev/null -w 'scan-pair unauth POST -> %{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:18080/api/scan-pair"
      ssh pi-home "curl -s -o /dev/null -w 'marketplace-listings GET -> %{http_code}\n' 'http://127.0.0.1:18080/api/marketplace-listings?cardId=220962&nativeOnly=1&limit=1'"
      say "api live"
      return 0
    fi
    sleep 2
  done
  echo "health failed — rolling back" >&2
  cmd_rollback_api
  exit 1
}

cmd_rollback_api() {
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .scan-connect-previous); ln -sfn \$prev current.new && mv -Tf current.new current; docker restart $API_CONTAINER >/dev/null; echo restored \$prev"
}

cmd_scanner() {
  (cd "$BATTLESCAN" && node --test scripts/scan-connect.test.cjs >/dev/null && node scripts/scanner-ui.test.cjs web/index.html >/dev/null) \
    || die "BattleScan tests failed"
  say "backup peer1 web + app.py to .backups/$STAMP-scan-connect"
  ssh oracle-peer1 "set -e; cd /opt/pokoin-cardscan; mkdir -p .backups/$STAMP-scan-connect; cp -a web/index.html server/app.py .backups/$STAMP-scan-connect/; echo $STAMP-scan-connect > .backups/scan-connect-latest"
  scp -q "$BATTLESCAN/web/index.html" oracle-peer1:/tmp/sc-index.html
  scp -q "$BATTLESCAN/web/static/scan-connect.js" oracle-peer1:/tmp/sc-scan-connect.js
  scp -q "$BATTLESCAN/server/app.py" oracle-peer1:/tmp/sc-app.py
  ssh oracle-peer1 "set -e; cd /opt/pokoin-cardscan
    install -m 644 /tmp/sc-scan-connect.js web/static/scan-connect.js.new && mv -f web/static/scan-connect.js.new web/static/scan-connect.js
    install -m 644 /tmp/sc-index.html web/index.html.new && mv -f web/index.html.new web/index.html
    install -m 644 /tmp/sc-app.py server/app.py.new && mv -f server/app.py.new server/app.py
    sudo -n systemctl restart pokoin-cardscan
    for i in \$(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8099/connect && break; sleep 2; done
    curl -fsS http://127.0.0.1:8099/connect | grep -q scan-connect.js
    curl -fsS -o /dev/null http://127.0.0.1:8099/static/scan-connect.js
    curl -fsS http://127.0.0.1:8099/health | head -c 120; echo"
  say "scanner live"
}

cmd_rollback_scanner() {
  ssh oracle-peer1 "set -e; cd /opt/pokoin-cardscan; b=.backups/\$(cat .backups/scan-connect-latest); cp -a \$b/index.html web/index.html; cp -a \$b/app.py server/app.py; sudo -n systemctl restart pokoin-cardscan; echo restored \$b"
}

cmd_web() {
  say "SPA unit tests"
  (cd "$WEB" && node --test market/src/scan-model.test.js market/src/scan-shortcuts.test.js market/src/scan-stream.test.js market/src/qr.test.js >/dev/null) \
    || die "pokoin-web tests failed"
  local stage="/tmp/pokoin-web-scan-connect-$STAMP"
  say "stage $stage (Codex recipe: no .git/node_modules/.vercel/output/dist-web)"
  rsync -a --exclude .git --exclude node_modules --exclude .vercel/output --exclude dist-web "$WEB/" "$stage/"
  mkdir -p "$stage/.vercel" && cp "$WEB/.vercel/project.json" "$stage/.vercel/project.json"
  (cd "$stage" && env -u VERCEL_TOKEN vercel build --prod --yes && env -u VERCEL_TOKEN vercel deploy --prebuilt --prod --yes --archive=tgz) | tee "$stage/deploy.log"
  local url
  url="$(grep -Eo 'https://[a-z0-9-]+\.vercel\.app' "$stage/deploy.log" | tail -1)"
  say "verify $url"
  (cd "$stage" && env -u VERCEL_TOKEN vercel curl /inventory/scan --deployment "$url" | grep -q '<div id="root"') || die "SPA shell missing"
  say "web deployed; aliases pokoin.com + dashboard.pokoin.com follow the production deployment"
}

case "${1:-}" in
  migrate) cmd_migrate ;;
  api) cmd_api ;;
  scanner) cmd_scanner ;;
  web) cmd_web ;;
  rollback-api) cmd_rollback_api ;;
  rollback-scanner) cmd_rollback_scanner ;;
  all) cmd_migrate; cmd_api; cmd_scanner; cmd_web ;;
  *) sed -n 2,12p "$0"; exit 2 ;;
esac
