#!/usr/bin/env bash
# Publish Pokoin News to the assets-only `pokoin-news` Worker.
#
# Build runs from the exact `origin/main` tree (git archive), never the working
# tree, and uploads a new Worker version. Nothing is promoted unless the caller
# passes an explicit version id.
#
# `--deploy` (used by the newsroom publisher service) builds and runs
# `wrangler deploy`, which also attaches the routes in wrangler.pokoin-news.jsonc
# (pokoin.com/news* and pokoin.com/<game>/news*). Approved 2026-10-05.
#
# Usage:
#   scripts/publish-news.sh                 # build + upload a version (no traffic)
#   scripts/publish-news.sh --promote <id>  # deploy an uploaded version at 100%
#   scripts/publish-news.sh --deploy        # build + deploy at 100% (routes included)
set -euo pipefail

exec 9>/tmp/pokoin-news-publish.lock
flock 9

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

git fetch origin main

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git archive origin/main | tar -x -C "$WORK"

NEWS_EXPORT="${NEWS_EXPORT:-http://127.0.0.1:8789/api/poko/news?export=published}"
NEWS_MEDIA_DIR="${NEWS_MEDIA_DIR:-/home/nez/Projects/Hermes/data/newsroom-media}"
SHA="$(git rev-parse --short origin/main)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

node "$WORK/scripts/build-news-site.mjs" \
  --input "$NEWS_EXPORT" \
  --out "$WORK/dist-news" \
  --media-dir "$NEWS_MEDIA_DIR" \
  --strict

if [ "${1:-}" = "--deploy" ]; then
  (cd "$WORK" && wrangler deploy -c wrangler.pokoin-news.jsonc --message "news $SHA $STAMP")
  exit 0
fi

UPLOAD_OUT="$(
  cd "$WORK" && wrangler versions upload \
    -c wrangler.pokoin-news.jsonc \
    --message "news $SHA $STAMP"
)"
printf '%s\n' "$UPLOAD_OUT"

# wrangler prints "Worker Version ID: <uuid>".
VERSION_ID="$(printf '%s' "$UPLOAD_OUT" | grep -oE 'Version ID: [0-9a-f-]{36}' | head -1 | awk '{print $3}')"
if [ -n "$VERSION_ID" ]; then
  echo "pokoin-news version: $VERSION_ID"
else
  echo "pokoin-news version: (could not parse id from upload output)" >&2
fi

if [ "${1:-}" = "--promote" ]; then
  PROMOTE_ID="${2:?--promote requires a version id}"
  wrangler versions deploy "$PROMOTE_ID@100%" --name pokoin-news -y
fi
