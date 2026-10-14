#!/usr/bin/env bash
# Publish pokoin.com (Cloudflare Workers Static Assets `pokoin-web`) from an
# exact origin/main commit. docs/WEB_HOST.md#deploying explains each step.
#
# The build runs from `git archive <sha>`, never the working tree. The upload
# carries the last two releases' /market/s/* chunks from the live site
# (scripts/carry-web-release-chunks.mjs), so tabs and edges still on the old
# shell keep finding their chunks. Nothing gets traffic until --promote.
#
# Usage (nezopt):
#   scripts/publish-web.sh [<sha>]                  # build + upload a version (no traffic)
#   scripts/publish-web.sh --build-only [<sha>]     # build any commit into a temp dir, print it, stop
#   scripts/publish-web.sh --promote <version-id>   # deploy an uploaded version at 100%
#
# WRANGLER=<path> picks the wrangler binary (default: wrangler on PATH, else npx wrangler@4).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -n "${WRANGLER:-}" ]; then
  WRANGLER_CMD=("$WRANGLER")
elif command -v wrangler >/dev/null 2>&1; then
  WRANGLER_CMD=(wrangler)
else
  WRANGLER_CMD=(npx --yes wrangler@4)
fi

mode=upload
case "${1:-}" in
  --promote)
    VERSION_ID="${2:?--promote requires a version id}"
    exec "${WRANGLER_CMD[@]}" versions deploy "$VERSION_ID@100%" --name pokoin-web -y
    ;;
  --build-only)
    mode=build
    shift
    ;;
esac

exec 9>/tmp/pokoin-web-publish.lock
flock 9

git fetch -q origin main
SHA="$(git rev-parse --verify "${1:-origin/main}^{commit}")"
# --build-only may build any commit (a branch to preview); uploads only origin/main.
if [ "$mode" = upload ] && ! git merge-base --is-ancestor "$SHA" origin/main; then
  echo "publish-web: $SHA is not on origin/main" >&2
  exit 1
fi
SHORT="${SHA:0:12}"

WORK="$(mktemp -d /tmp/pokoin-web-publish.XXXXXX)"
if [ "$mode" = upload ]; then
  trap 'rm -rf "$WORK"' EXIT
fi
git archive "$SHA" | tar -x -C "$WORK"

(cd "$WORK" && scripts/build-web.sh)
node "$WORK/scripts/carry-web-release-chunks.mjs" "$WORK/dist-web" --release "$SHORT"
node "$WORK/scripts/write-cloudflare-web-routing.mjs" "$WORK/dist-web"

if [ "$mode" = build ]; then
  echo "built $SHORT in $WORK/dist-web"
  echo "preview: node $WORK/solid/scripts/preview.mjs --dist-web $WORK/dist-web --port <port>"
  exit 0
fi

UPLOAD_OUT="$(cd "$WORK" && "${WRANGLER_CMD[@]}" versions upload -c wrangler.pokoin-web.jsonc --message "main $SHORT")"
printf '%s\n' "$UPLOAD_OUT"
VERSION_ID="$(printf '%s' "$UPLOAD_OUT" | grep -oE 'Version ID: [0-9a-f-]{36}' | head -1 | awk '{print $3}')"
if [ -n "$VERSION_ID" ]; then
  echo "pokoin-web version $VERSION_ID (main $SHORT). Check the Version Preview URL above, then:"
  echo "  scripts/publish-web.sh --promote $VERSION_ID"
else
  echo "pokoin-web: could not parse the version id from the upload output" >&2
fi
