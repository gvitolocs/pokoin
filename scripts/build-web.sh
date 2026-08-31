#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist-web"
cd "$ROOT"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$ROOT/index.html" "$OUT/index.html"
cp -a "$ROOT/home" "$OUT/home"
python3 - <<PY
from pathlib import Path
p = Path("$OUT/index.html")
t = p.read_text()
t = t.replace('href="home/', 'href="/home/').replace('src="home/', 'src="/home/')
p.write_text(t)
print("landing", p)
PY
cd "$ROOT/market"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
npm run build
mkdir -p "$OUT/market"
cp -a "$ROOT/market/dist/." "$OUT/market/"
echo "built $OUT"
