#!/usr/bin/env bash
# Change one edge route percentage without restarting Node or Rust.
#   scripts/pokoin-rust-canary.sh suggest 5
#   scripts/pokoin-rust-canary.sh suggest 0
# Shadow stays listed until removed with: shadow suggest off
set -euo pipefail
route="${1:?route}"
value="${2:?percent or off}"
PI="${PI_HOST:-pi-home}"
ssh "$PI" "python3 - $(printf '%q' "$route") $(printf '%q' "$value") <<'PY'
import json, sys
path = '/srv/pokoin/api/rust-routes.json'
route, value = sys.argv[1], sys.argv[2]
doc = json.load(open(path))
doc.setdefault('routes', {})
doc.setdefault('shadow', [])
if value == 'off':
    doc['shadow'] = [name for name in doc['shadow'] if name != route]
else:
    percent = int(value)
    if percent < 0 or percent > 100:
        raise SystemExit('percent must be 0..100')
    doc['routes'][route] = percent
json.dump(doc, open(path, 'w'), indent=2)
print(json.dumps(doc))
PY"
