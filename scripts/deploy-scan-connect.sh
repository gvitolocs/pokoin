#!/usr/bin/env bash
# Scan Connect production rollout. Run ON NEZOPT (SSH aliases pi-home, oracle-peer1).
# docs/SCAN_CONNECT.md#production-deployment · web deploys go through scripts/deploy-web.sh.
#
#   scripts/deploy-scan-connect.sh migrate    # 082 on the primary (nezopt pokoin-marketplace-postgres-15t), grants, replica check
#   scripts/deploy-scan-connect.sh api        # new Pi release = live release + scan files, restart pokoin-oracle-api, auto-rollback
#   scripts/deploy-scan-connect.sh scanner    # peer1 /opt/pokoin-cardscan: backup, web + /connect route, verify
#   scripts/deploy-scan-connect.sh web        # scripts/deploy-web.sh (guarded, from a commit)
#   scripts/deploy-scan-connect.sh rollback-api | rollback-scanner
set -euo pipefail

PROJECTS="${PROJECTS:-/home/nez/Projects}"
CARDVAULT="$PROJECTS/cardvault/pokemon_card_vault"
BATTLESCAN="$PROJECTS/BattleScan"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date -u +%Y%m%d%H%M%S)"
PG_CONTAINER="${PG_CONTAINER:-pokoin-marketplace-postgres-15t}"
REPLICA_CONTAINER="${REPLICA_CONTAINER:-pokoin-marketplace-postgres-replica}"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
DB_USER="${DB_USER:-pokoin_marketplace}"
DB_NAME="${DB_NAME:-pokoin_marketplace}"

# CardVault files shipped whole. Everything else in the Pi release stays as deployed,
# so unrelated uncommitted work in the nezopt CardVault tree never ships.
API_FILES=(
  api/_scan_connect.js api/_scan_store.js api/_scan_bus.js api/_scan_http.js
  api/scan-session.js api/scan-pair.js api/scan-phone.js api/scan-batch.js api/scan-stream.js
  api/_user_card_collection.js
  api/marketplace-listings.js api/marketplace-orders.js
  api/marketplace-collection-summary.js api/marketplace-collection.js
  server/api-route-manifest.js
  oracle-postgres/schema/082_scan_connect.sql oracle-postgres/schema/082_scan_connect.grants.sql
)

die() { echo "deploy-scan-connect: $*" >&2; exit 1; }
say() { echo "== $*"; }
primary_psql() { docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"; }
replica_psql() { ssh pi-home "docker exec -i $REPLICA_CONTAINER psql -U $DB_USER -d $DB_NAME -At -c \"$1\""; }

writer_url_parts() {
  # user host db of the running API's writer URL — never the password.
  ssh pi-home "tr '\0' '\n' < /proc/\$(docker inspect -f '{{.State.Pid}}' $API_CONTAINER)/environ" \
    | sed -nE 's#^MARKETPLACE_WRITER_DATABASE_URL=[a-z]+://([^:@/]+)[^@]*@([^/?]+)/([^?]*).*#\1 \2 \3#p' | head -1
}

SCHEMA_CHECK="select (select count(*) from pg_tables where schemaname='public' and tablename in ('scan_batches','scan_sessions','scan_pairings','scan_rate_limits','scan_items')) || ',' || (select count(*) from information_schema.columns where table_name='marketplace_user_listings' and column_name in ('location','altered')) || ',' || (select count(*) from pg_indexes where indexname='marketplace_user_listings_scan_row_uidx')"

cmd_migrate() {
  read -r role host db <<<"$(writer_url_parts)"
  [[ -n "${role:-}" ]] || die "could not read the API writer URL"
  say "API writes as $role@$host/$db"
  [[ "$host" == "192.168.178.55:25432" && "$db" == "$DB_NAME" ]] \
    || die "API writer is $host/$db, not $PG_CONTAINER — topology changed; re-verify before migrating"
  [[ "$(primary_psql -Atc 'select pg_is_in_recovery()')" == "f" ]] || die "$PG_CONTAINER is in recovery (read-only)"
  say "apply 082_scan_connect.sql (idempotent)"
  primary_psql -q < "$CARDVAULT/oracle-postgres/schema/082_scan_connect.sql"
  say "grants for $role"
  primary_psql -q -v api_role="$role" < "$CARDVAULT/oracle-postgres/schema/082_scan_connect.grants.sql"
  [[ "$(primary_psql -Atc "$SCHEMA_CHECK")" == "5,2,1" ]] || die "primary schema incomplete"
  say "primary: 5 tables, 2 columns, 1 index"
  for i in $(seq 1 30); do
    [[ "$(replica_psql "$SCHEMA_CHECK")" == "5,2,1" ]] && { say "replica (Pi) has the schema"; return 0; }
    sleep 2
  done
  die "replica did not receive the schema within 60 s — check pg_stat_replication"
}

cmd_api() {
  for f in "${API_FILES[@]}"; do [[ -f "$CARDVAULT/$f" ]] || die "missing $f"; done
  say "CardVault unit tests"
  (cd "$CARDVAULT" && node --test \
      api/_scan_connect.test.js \
      api/_scan_submit_intent.test.js \
      api/_scan_store_submit_intent.test.js \
      api/_user_card_collection.test.js \
      api/marketplace-listings.test.js \
      server/api-route-families.test.js \
      >/tmp/sc-api-tests.log 2>&1) \
    || { tail -20 /tmp/sc-api-tests.log; die "CardVault tests failed"; }
  [[ "$(replica_psql "$SCHEMA_CHECK")" == "5,2,1" ]] || die "scan schema missing on the Pi replica: run migrate first"
  local release="releases/scan-connect-$STAMP"
  say "Pi release $release = live release + ${#API_FILES[@]} files"
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .scan-connect-previous; cp -a \$prev $release"
  tar -C "$CARDVAULT" -cf - "${API_FILES[@]}" | ssh pi-home "tar -C /srv/pokoin/api/$release -xf -"
  # Families: keep the live file, add only the scan rule.
  ssh pi-home "cd /srv/pokoin/api/$release && python3 - server/api-route-families.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
if "id: 'scan'" not in s:
    a = "  { id: 'commerce', title: 'Listings / cart / orders' },"
    b = "  if (/cardtrader/"
    assert s.count(a) == 1 and s.count(b) == 1, "families layout changed"
    s = s.replace(a, a + "\n  { id: 'scan', title: 'Scan Connect' },")
    s = s.replace(b, "  if (/\\/api\\/scan-(session|pair|phone|batch|stream)(?:\\.js)?$/.test(p)) {\n    return 'scan';\n  }\n" + b, 1)
    open(p, "w").write(s)
PY
  ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn $release current.new && mv -Tf current.new current; docker restart $API_CONTAINER >/dev/null"
  say "health"
  for i in $(seq 1 45); do
    if ssh pi-home "curl -fsS 'http://127.0.0.1:18080/api/__routes?family=scan'" 2>/dev/null | grep -q scan-pair; then
      local pair listings
      pair="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{\"pin\":\"0000\"}' http://127.0.0.1:18080/api/scan-pair")"
      listings="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:18080/api/marketplace-listings?cardId=220962&nativeOnly=1&limit=1'")"
      say "scan-pair wrong code → $pair (expect 400), marketplace-listings → $listings (expect 200)"
      if [[ "$pair" == "400" && "$listings" == "200" ]]; then
        say "api live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
        return 0
      fi
      break
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
  (cd "$BATTLESCAN" && node --test scripts/scan-connect.test.cjs >/dev/null \
    && node scripts/scan-connect-phone-layout.cjs >/dev/null \
    && node scripts/scanner-ui.test.cjs web/index.html >/dev/null) \
    || die "BattleScan tests failed"
  say "backup peer1 files to .backups/$STAMP-scan-connect"
  ssh oracle-peer1 "set -e; cd /opt/pokoin-cardscan; b=.backups/$STAMP-scan-connect; mkdir -p \$b/static; cp -a web/index.html server/app.py \$b/; [ -f web/static/scan-connect.js ] && cp -a web/static/scan-connect.js \$b/static/ || true; echo $STAMP-scan-connect > .backups/scan-connect-latest"
  scp -q "$BATTLESCAN/web/index.html" oracle-peer1:/tmp/sc-index.html
  scp -q "$BATTLESCAN/web/static/scan-connect.js" oracle-peer1:/tmp/sc-scan-connect.js
  scp -q "$BATTLESCAN/server/app.py" oracle-peer1:/tmp/sc-app.py
  # Static UI is Caddy file_server under /opt/pokoin-cardscan/web. Recognition is
  # the SSH tunnel 8100→nezopt; peer1 uvicorn is optional and may be down.
  ssh oracle-peer1 "set -e; cd /opt/pokoin-cardscan
    install -m 644 /tmp/sc-scan-connect.js web/static/scan-connect.js.new && mv -f web/static/scan-connect.js.new web/static/scan-connect.js
    install -m 644 /tmp/sc-index.html web/index.html.new && mv -f web/index.html.new web/index.html
    install -m 644 /tmp/sc-app.py server/app.py.new && mv -f server/app.py.new server/app.py
    grep -q chromeUrlFor web/static/scan-connect.js
    grep -q 'padding-bottom: calc(88px' web/index.html"
  # Public scan.pokoin.com is Caddy file_server over /opt/pokoin-cardscan/web (recognition paths
  # proxy to 127.0.0.1:8100 → nezopt). /connect must be rewritten there; app.py is not in that path.
  ssh oracle-peer1 bash -s <<'REMOTE'
set -euo pipefail
if ! sudo -n grep -q "rewrite /connect /index.html" /etc/caddy/Caddyfile; then
  stamp=$(date -u +%Y%m%d%H%M%S)
  sudo -n cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-scan-connect-$stamp
  tmp=$(mktemp); sudo -n cat /etc/caddy/Caddyfile > "$tmp"
  python3 - "$tmp" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "    handle {\n        root * /opt/pokoin-cardscan/web\n        file_server\n    }"
new = "    handle {\n        root * /opt/pokoin-cardscan/web\n        # Scan Connect (pokoin-web docs/SCAN_CONNECT.md): /connect is the same page in pairing mode.\n        rewrite /connect /index.html\n        rewrite /connect/ /index.html\n        file_server\n    }"
assert s.count(old) == 2, "scanner Caddy blocks changed"
open(p, "w").write(s.replace(old, new))
PY
  sudo -n caddy validate --config "$tmp" --adapter caddyfile >/dev/null
  sudo -n install -m 644 "$tmp" /etc/caddy/Caddyfile
  sudo -n systemctl reload caddy
fi
REMOTE
  for u in https://scan.pokoin.com/connect https://cardscan.pokoin.com/connect; do
    # Avoid curl exit 23 (SIGPIPE) when grep -q closes the pipe early.
    curl -fsS "$u" -o /tmp/sc-connect-check.html
    grep -q scan-connect.js /tmp/sc-connect-check.html || die "$u does not serve the connect page"
  done
  curl -fsS https://scan.pokoin.com/static/scan-connect.js -o /tmp/sc-js-check.js
  grep -q chromeUrlFor /tmp/sc-js-check.js || die "public scan-connect.js is stale"
  curl -fsS https://scan.pokoin.com/ -o /tmp/sc-index-check.html
  grep -q 'padding-bottom: calc(88px' /tmp/sc-index-check.html || die "public index.html missing phone dock pad"
  say "scanner live on peer1 (public /connect verified)"
}

cmd_rollback_scanner() {
  # The Caddy /connect rewrite is left in place: without scan-connect.js it serves the normal scanner.
  ssh oracle-peer1 "set -e; cd /opt/pokoin-cardscan; b=.backups/\$(cat .backups/scan-connect-latest); cp -a \$b/index.html web/index.html; cp -a \$b/app.py server/app.py; rm -f web/static/scan-connect.js; [ -f \$b/static/scan-connect.js ] && cp -a \$b/static/scan-connect.js web/static/ || true; sudo -n systemctl restart pokoin-cardscan; echo restored \$b"
}

case "${1:-}" in
  migrate) cmd_migrate ;;
  api) cmd_api ;;
  scanner) cmd_scanner ;;
  web) "$HERE/scripts/deploy-web.sh" "${2:-HEAD}" ;;
  rollback-api) cmd_rollback_api ;;
  rollback-scanner) cmd_rollback_scanner ;;
  *) sed -n 2,10p "$0"; exit 2 ;;
esac
