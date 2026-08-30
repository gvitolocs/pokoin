#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="${CARDVAULT_WEB:-/home/nez/Projects/cardvault/pokemon_card_vault/web}"
cp "$ROOT/index.html" "$WEB/home.html"
rm -rf "$WEB/home"
cp -a "$ROOT/home" "$WEB/home"
python3 - <<PY
from pathlib import Path
p = Path("$WEB/home.html")
t = p.read_text()
t = t.replace('href="home/', 'href="/home/').replace('src="home/', 'src="/home/')
p.write_text(t)
print("synced landing to", p)
PY
