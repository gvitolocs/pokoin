#!/usr/bin/env bash
# Download competitive sprites / scans / format badges / country flags we do
# not already have, then rsync to Oracle peer1 /home/ubuntu/pokoin-cdn/competitive.
# Sources: Limitless dump URLs (one-time copy) and HatScripts circle-flags (MIT).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DUMP="$ROOT/market/src/data/limitless.json"
STAGING="${STAGING:-/tmp/pokoin-competitive-cdn}"
DEST_HOST="${1:-oracle-peer1}"
DEST_PATH="${2:-/home/ubuntu/pokoin-cdn/competitive}"
export UA="${UA:-Mozilla/5.0 (compatible; PokoinCDN/1.0; +https://pokoin.com)}"

mkdir -p "$STAGING"/{sprites,formats,scans,flags}
python3 "$ROOT/scripts/sync-competitive-cdn.py" "$DUMP" "$STAGING"

echo "rsync $STAGING/ -> $DEST_HOST:$DEST_PATH/"
rsync -az --info=stats2 "$STAGING"/ "$DEST_HOST:$DEST_PATH/"
echo "done"
