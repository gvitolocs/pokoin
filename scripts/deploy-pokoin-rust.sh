#!/usr/bin/env bash
# Install a prebuilt aarch64 pokoin-api beside Node on the Pi.
# Does not move traffic. The edge reads /srv/pokoin/api/rust-routes.json.
set -euo pipefail

die() { echo "deploy-pokoin-rust: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
PI="${PI_HOST:-pi-home}"
SHORT="${COMMIT:0:12}"
BIN="$REPO/pokoin-rust/target/aarch64-unknown-linux-gnu/release/pokoin-api"
[[ -f "$BIN" ]] || die "missing $BIN — build the aarch64 release first"

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; merge it first"

file "$BIN" | grep -q 'ARM aarch64' || die "$BIN is not an aarch64 binary"
say "artifact $SHORT"

ssh "$PI" "mkdir -p /srv/pokoin/rust/releases /srv/pokoin/api"
scp -q "$BIN" "$PI:/srv/pokoin/rust/releases/pokoin-api-$SHORT-aarch64"
scp -q "$REPO/deploy/systemd/pokoin-rust-api.service" "$PI:/tmp/pokoin-rust-api.service"
scp -q "$REPO/deploy/pokoin-rust-routes.json" "$PI:/tmp/pokoin-rust-routes.json"

ssh "$PI" "set -euo pipefail
install -o nes -g nes -m 0755 /srv/pokoin/rust/releases/pokoin-api-$SHORT-aarch64 /srv/pokoin/rust/releases/pokoin-api-$SHORT-aarch64
if [[ -L /srv/pokoin/rust/current ]]; then cp -a /srv/pokoin/rust/current /srv/pokoin/rust/previous; fi
ln -sfn /srv/pokoin/rust/releases/pokoin-api-$SHORT-aarch64 /srv/pokoin/rust/current
python3 - <<'PY'
import json, subprocess
raw = subprocess.check_output(['docker','inspect','pokoin-oracle-api'], text=True)
env = json.loads(raw)[0]['Config']['Env']
keep = {
  'MEILI_HOST','MEILISEARCH_HOST','MEILI_API_KEY','MEILISEARCH_API_KEY',
  'MEILI_MARKETPLACE_INDEX','MARKETPLACE_SEARCH_ENGINE','SEARCH_ENGINE',
  'MARKETPLACE_DATABASE_URL','VALKEY_HOST','VALKEY_PORT','VALKEY_URL','REDIS_URL',
}
lines = [item for item in env if item.split('=',1)[0] in keep]
open('/srv/pokoin/rust/pokoin-api.env','w').write('\n'.join(lines)+'\n')
PY
chown root:nes /srv/pokoin/rust/pokoin-api.env
chmod 640 /srv/pokoin/rust/pokoin-api.env
install -o root -g root -m 0644 /tmp/pokoin-rust-api.service /etc/systemd/system/pokoin-rust-api.service
if [[ ! -f /srv/pokoin/api/rust-routes.json ]]; then
  install -o root -g root -m 0644 /tmp/pokoin-rust-routes.json /srv/pokoin/api/rust-routes.json
fi
rm -f /tmp/pokoin-rust-api.service /tmp/pokoin-rust-routes.json
pkill -f '^/tmp/pokoin-api-aarch64$' || true
sleep 0.5
systemctl daemon-reload
systemctl enable --now pokoin-rust-api.service
systemctl restart pokoin-rust-api.service
for i in \$(seq 1 20); do
  if curl -sf --max-time 2 http://127.0.0.1:18082/health | grep -q '\"db\":true'; then
    curl -sf --max-time 2 http://127.0.0.1:18082/health
    echo
    exit 0
  fi
  sleep 1
done
journalctl -u pokoin-rust-api.service -n 40 --no-pager
exit 1
"
say "rust api live @ $SHORT :18082"
