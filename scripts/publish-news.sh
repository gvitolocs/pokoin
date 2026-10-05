#!/usr/bin/env bash
# Publish Pokoin News to the assets-only `pokoin-news` Worker.
#
# Build runs from the exact `origin/main` tree (git archive), never the working
# tree, and uploads a new Worker version. Nothing is promoted unless the caller
# passes an explicit version id.
#
# The first-ever promote also needs the `pokoin.com/news*` route attached in the
# Cloudflare zone (dashboard or API). That is a production change and requires
# explicit approval; this script does not attach routes.
#
# Usage:
#   scripts/publish-news.sh                 # build + upload a version
#   scripts/publish-news.sh --promote <id>  # deploy an uploaded version at 100%
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

UPLOAD_OUT="$(
  cd "$WORK" && wrangler versions upload \
    -c wrangler.pokoin-news.jsonc \
    --message "news $SHA $STAMP"
)"
printf '%s\n' "$UPLOAD_OUT"

VERSION_ID="$(
  printf '%s' "$UPLOAD_OUT" | node -e \
    "let s='';process.stdin.on('data',(d)=>{s+=d}).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(j.id||j.version_id||'')}catch{}})"
)"
if [ -n "$VERSION_ID" ]; then
  echo "pokoin-news version: $VERSION_ID"
else
  echo "pokoin-news version: (could not parse id from upload output)" >&2
fi

if [ "${1:-}" = "--promote" ]; then
  PROMOTE_ID="${2:?--promote requires a version id}"
  wrangler versions deploy "$PROMOTE_ID@100%" --name pokoin-news -y
fi
