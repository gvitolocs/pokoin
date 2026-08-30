#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="${CARDVAULT_WEB:-/home/nez/Projects/cardvault/pokemon_card_vault/web}"
BUILD="${CARDVAULT_BUILD:-/home/nez/Projects/cardvault/pokemon_card_vault/build/web}"
cd "$ROOT/market"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
npm run build
rm -rf "$WEB/market"
mkdir -p "$WEB/market"
cp -a dist/. "$WEB/market/"
if [[ -d "$BUILD" ]]; then
  rm -rf "$BUILD/market"
  mkdir -p "$BUILD/market"
  cp -a dist/. "$BUILD/market/"
  echo "copied market to $WEB/market and $BUILD/market"
else
  echo "copied market to $WEB/market (no Flutter build/web yet)"
fi
