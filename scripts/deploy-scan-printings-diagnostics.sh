#!/usr/bin/env bash
# Run on nezopt after explicit push/deploy authorization. Ships an exact origin/main snapshot.
set -euo pipefail
mode="${1:-all}"
[[ "$mode" == api || "$mode" == scanner || "$mode" == all ]] || { echo 'Usage: deploy-scan-printings-diagnostics.sh [api|scanner|all] [commit]' >&2; exit 1; }
repo="$(git rev-parse --show-toplevel)"
commit="$(git rev-parse "${2:-HEAD}^{commit}")"
git fetch -q origin
[[ "$commit" == "$(git rev-parse origin/main)" ]] || { echo 'Integrate and push first: deployment must be exact origin/main.' >&2; exit 1; }
stamp="$(date -u +%Y%m%d%H%M%S)"
stage="$(mktemp -d /tmp/scan-printings-diagnostics-XXXXXX)"
trap 'rm -rf "$stage"' EXIT
git archive "$commit" server/pokoin-api server/scan | tar -C "$stage" -xf -
node --test "$stage/server/pokoin-api/_scan_connect.test.js" "$stage/server/pokoin-api/scan-printings-diagnostics.test.js" "$stage/server/pokoin-api/scan-phone.test.js" "$stage/server/scan/tests/scan-connect.test.cjs" "$stage/server/scan/tests/scanner-ui.test.cjs"
api="$stage/server/pokoin-api"
web="$stage/server/scan/web"
if [[ "$mode" == api || "$mode" == all ]]; then
  release="releases/scan-diagnostics-$stamp"
  previous="$(ssh pi-home 'readlink /srv/pokoin/api/current')"
  ssh pi-home "set -e; cd /srv/pokoin/api; cp -a '$previous' '$release'"
  files=(_scan_connect.js _scan_store.js _scan_http.js _print_bucket.js _scan_diagnostics.js scan-phone.js)
  for file in "${files[@]}"; do node --check "$api/$file"; done
  tar -C "$api" -cf - "${files[@]}" | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"
  ssh pi-home "set -e; cd /srv/pokoin/api; printf '%s\n' '$previous' > .scan-diagnostics-previous; printf '%s\n' '$commit' > '$release/.scan-diagnostics-commit'; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart pokoin-oracle-api >/dev/null"
  healthy=0
  for i in $(seq 1 30); do
    code="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18080/api/scan-phone?action=heartbeat" || true)"
    if [[ "$code" == 401 ]]; then healthy=1; break; fi
    sleep 1
  done
  if [[ "$healthy" != 1 ]]; then
    ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$previous' current.new; mv -Tf current.new current; docker restart pokoin-oracle-api >/dev/null"
    echo 'API verification failed; restored previous release.' >&2; exit 1
  fi
fi
if [[ "$mode" == scanner || "$mode" == all ]]; then
  # The current deployed phone, including its printing picker, now belongs to this repo.
  ssh oracle-peer1 "set -e; cd /opt/pokoin-cardscan; mkdir -p '.backups/$stamp-scan-diagnostics'; cp -a web '.backups/$stamp-scan-diagnostics/'"
  tar -C "$web" -cf - . | ssh oracle-peer1 "set -e; mkdir -p '/tmp/scan-diagnostics-$stamp'; tar -C '/tmp/scan-diagnostics-$stamp' -xf -; cd /opt/pokoin-cardscan; for file in static/pokoin-icon.png static/scan-diagnostics.js static/scan-connect.js index.html; do install -m 644 '/tmp/scan-diagnostics-$stamp/'\"\$file\" web/\"\$file\".new; mv web/\"\$file\".new web/\"\$file\"; done; rm -rf '/tmp/scan-diagnostics-$stamp'"
  # Read the entire response before grep: grep -q can close the pipe early,
  # causing curl exit 23 under pipefail even when the expected asset is live.
  if ! curl -fsS "https://scan.pokoin.com/connect?v=$stamp" -o "$stage/live-phone.html" \
    || ! grep -q 'scan-connect.js?v=scan-diag-v2' "$stage/live-phone.html" \
    || ! curl -fsS "https://scan.pokoin.com/static/scan-diagnostics.js?v=$stamp" -o "$stage/live-diagnostics.js" \
    || ! grep -q 'scan-diag-v2' "$stage/live-diagnostics.js"; then
    ssh oracle-peer1 "set -e; cd /opt/pokoin-cardscan; cp -a '.backups/$stamp-scan-diagnostics/web/.' web/"
    echo 'Scanner verification failed; restored previous phone files.' >&2; exit 1
  fi
fi
printf 'Deployed %s (%s). Reload the phone and verify Logs active.\n' "$commit" "$mode"
