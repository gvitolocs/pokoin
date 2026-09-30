#!/usr/bin/env bash
# Pokoin card recognition API on the Pi (docs/SCAN_API.md), from an exact
# origin/main commit. Run on nezopt:
#   1. Pi CPU fallback worker: container pokoin-scan (server/scan) on 127.0.0.1:18150
#   2. nezopt GPU worker tunnel: pokoin-scan-pi-tunnel.service → Pi 127.0.0.1:18151
#   3. API routes /api/scan/identify, -identify-album, -catalogs, -health
# Models/catalogs come from the running nezopt worker (battlescan-fast.service)
# so both workers recognize against the same galleries.
set -euo pipefail

die() { echo "deploy-scan-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
SCAN_DIR=/srv/pokoin/scan
STAGE="$(mktemp -d /tmp/pokoin-scan-api-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/pokoin-api server/scan scripts/pokoin-scan-pi-tunnel.service | tar -C "$STAGE" -xf -
SRC="$STAGE/server/pokoin-api"
FILES=(scan-identify.js scan-identify-album.js scan-catalogs.js scan-health.js)
for file in "${FILES[@]}"; do node --check "$SRC/$file"; done
node --test "$SRC/scan-identify.test.js"

env_of() { systemctl --user show battlescan-fast -p Environment --value | tr ' ' '\n' | sed -n "s/^$1=//p"; }
MODELS="$(env_of CARDSCAN_MODELS)"
CATALOGS="$(env_of CARDSCAN_CATALOGS)"
[[ -f "$MODELS/milo.onnx" && -f "$CATALOGS/manifest.json" ]] || die "nezopt worker models/catalogs not found"

say "1/3 Pi CPU fallback worker (pokoin-scan)"
ssh pi-home "mkdir -p $SCAN_DIR/build $SCAN_DIR/models $SCAN_DIR/catalogs"
rsync -a --delete "$STAGE/server/scan/" "pi-home:$SCAN_DIR/build/"
rsync -a --delete "$MODELS/" "pi-home:$SCAN_DIR/models/"
rsync -a --delete "$CATALOGS/" "pi-home:$SCAN_DIR/catalogs/"
ssh pi-home "set -e
  docker build -q -t pokoin-scan:$SHORT $SCAN_DIR/build >/dev/null
  docker rm -f scanbench pokoin-scan >/dev/null 2>&1 || true
  docker run -d --name pokoin-scan --restart unless-stopped --cpus 2 \
    -p 127.0.0.1:18150:8000 \
    -v $SCAN_DIR/models:/app/models:ro -v $SCAN_DIR/catalogs:/app/catalogs:ro \
    pokoin-scan:$SHORT >/dev/null
  for i in \$(seq 1 60); do
    [ \"\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18150/health)\" = 200 ] && exit 0
    sleep 2
  done
  echo 'pokoin-scan did not become healthy' >&2; docker logs --tail 20 pokoin-scan >&2; exit 1"

say "2/3 nezopt GPU worker tunnel"
install -D -m 0644 "$STAGE/scripts/pokoin-scan-pi-tunnel.service" "$HOME/.config/systemd/user/pokoin-scan-pi-tunnel.service"
systemctl --user daemon-reload
systemctl --user enable --now pokoin-scan-pi-tunnel.service >/dev/null
systemctl --user restart pokoin-scan-pi-tunnel.service
for i in $(seq 1 20); do
  code="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18151/health" || true)"
  [[ "$code" == 200 ]] && break
  sleep 1
done
[[ "$code" == 200 ]] || die "Pi cannot reach the nezopt worker through the tunnel"

say "3/3 API routes"
release="releases/scan-$SHORT-$STAMP"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .scan-previous; cp -a \$prev '$release'; mkdir -p '$release/api'"
tar -C "$SRC" -cf - "${FILES[@]}" | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"
ssh pi-home "cat '/srv/pokoin/api/$release/server/api-route-manifest.js'" > "$STAGE/manifest.js"
node -e '
const fs = require("node:fs");
const rows = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).filter((r) => r.path.startsWith("/api/scan/"));
if (rows.length !== 4) throw new Error(`expected 4 scan routes, got ${rows.length}`);
fs.writeFileSync(process.argv[2], JSON.stringify(rows, null, 2));
' "$SRC/route-definitions.json" "$STAGE/scan-routes.json"
node "$SRC/patch-route-manifest.js" "$STAGE/manifest.js" "$STAGE/scan-routes.json"
node --check "$STAGE/manifest.js"
ssh pi-home "cat > '/srv/pokoin/api/$release/server/api-route-manifest.js'" < "$STAGE/manifest.js"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.pokoin-scan-commit'; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

ok=0
for i in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  scan="$(ssh pi-home "curl -s http://127.0.0.1:18080/api/scan/health" || true)"
  if [[ "$health" == 200 && "$scan" == *'"nezopt":{"ok":true'* && "$scan" == *'"pi":{"ok":true'* ]]; then ok=1; break; fi
  sleep 2
done
if [[ "$ok" != 1 ]]; then
  echo "verification failed (health=$health scan=$scan) — rolling back API release" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .scan-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "API verification failed; previous release restored"
fi
say "deployed $COMMIT — $scan"
