#!/usr/bin/env bash
# Immutable worker/model release on nezopt; leaves BattleScan source/WIP intact.
set -euo pipefail
commit="$(git rev-parse "${1:-HEAD}^{commit}")"
git fetch -q origin
[[ "$commit" == "$(git rev-parse origin/main)" ]] || { echo 'Deploy exact pushed origin/main only.' >&2; exit 1; }
exec 8>/tmp/pokoin-expansion-worker-deploy.lock
flock -n 8 || { echo 'Worker deployment already running.' >&2; exit 1; }
release="/home/nez/data/pokoin-scan-releases/$commit"
stage="$(mktemp -d /tmp/pokoin-symbol-release-XXXXXX)"
trap 'rm -rf "$stage"' EXIT
git archive "$commit" server/scan/worker server/scan/tests/worker-smoke.py server/scan/tests/expansion_symbols_test.py | tar -C "$stage" -xf -
mkdir -p "$stage/symbols"
python3 - "$stage" <<'PY'
import hashlib,json,shutil,sys
from pathlib import Path
stage=Path(sys.argv[1]); source=Path('/home/nez/data/pokoin-expansion-symbols/v1')
for name,digest in json.loads((stage/'server/scan/worker/artifacts.json').read_text()).items():
    data=(source/name).read_bytes()
    if hashlib.sha256(data).hexdigest()!=digest:raise SystemExit('Artifact checksum mismatch: '+name)
    shutil.copyfile(source/name,stage/'symbols'/name)
PY
/home/nez/Projects/BattleScan/.venv/bin/python "$stage/server/scan/tests/expansion_symbols_test.py"
CARDSCAN_EXPANSION_SYMBOLS="$stage/symbols" /home/nez/Projects/BattleScan/.venv/bin/python "$stage/server/scan/tests/worker-smoke.py"
[[ ! -e "$release" ]] || { echo 'Release directory already exists; refusing overwrite.' >&2; exit 1; }
mkdir -p "$(dirname "$release")"
cp -a "$stage" "$release"
printf '%s\n' "$commit" > "$release/commit"
conf="/home/nez/.config/systemd/user/battlescan-fast.service.d/100-pokoin-release.conf"
mkdir -p "$(dirname "$conf")"
previous=0
if [[ -f "$conf" ]]; then cp -a "$conf" "$release/previous-worker.conf"; previous=1; fi
rollback() {
  trap - ERR
  if [[ "$previous" == 1 ]]; then cp -a "$release/previous-worker.conf" "$conf"; else rm -f "$conf"; fi
  systemctl --user daemon-reload
  systemctl --user restart battlescan-fast.service
  echo 'Worker verification failed; previous worker restored.' >&2
}
trap rollback ERR
cat > "$conf.new" <<EOF
[Service]
Environment=CARDSCAN_EXPANSION_SYMBOLS=$release/symbols
Environment=CARDSCAN_RELEASE=$commit
ExecStart=
ExecStart=/home/nez/Projects/BattleScan/.venv/bin/uvicorn app:app --app-dir $release/server/scan/worker --host 127.0.0.1 --port 8099 --workers 1
EOF
mv "$conf.new" "$conf"
systemctl --user daemon-reload
systemctl --user restart battlescan-fast.service
healthy=0
# All-games catalogs take minutes to load; wait up to DEPLOY_HEALTH_WAIT_S (default 360 s).
for _ in $(seq 1 "${DEPLOY_HEALTH_WAIT_S:-360}"); do
  if curl -fsS http://127.0.0.1:8099/health 2>/dev/null | python3 -c 'import json,sys; h=json.load(sys.stdin); assert h["expansion_symbols"]["enabled"] and h["device"]=="rocm"' 2>/dev/null; then healthy=1; break; fi
  sleep 1
done
[[ "$healthy" == 1 ]]
trap - ERR
echo "Deployed symbol worker $commit on ROCm."
