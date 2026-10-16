#!/usr/bin/env bash
# Weekly pokoin.com/sitemap refresh (pokoin-site-map-refresh.timer on nezopt).
#
#   scripts/refresh-site-map.sh            # run inside the site-map-refresh Paseo worktree
#
# Rebuilds market/public/data/site-map.json and site-map-images.json from the
# latest origin/main and the 15T catalog. Commits, pushes to main and publishes
# with scripts/publish-web.sh only when either file changed. It runs in its own
# Paseo worktree that nothing else uses, so resetting that tree is safe; it
# refuses to run in the canonical checkout or any other worktree.
set -euo pipefail

die() { echo "refresh-site-map: $*" >&2; exit 1; }
say() { echo "== $(date -u +%FT%TZ) $*"; }

if [ -n "${WRANGLER:-}" ]; then
  WRANGLER_CMD=("$WRANGLER")
elif command -v wrangler >/dev/null 2>&1; then
  WRANGLER_CMD=(wrangler)
else
  WRANGLER_CMD=(npx --yes wrangler@4)
fi

parse_version_id() {
  printf '%s' "$1" | grep -oE 'Version ID: [0-9a-f-]{36}' | head -1 | awk '{print $3}'
}

parse_preview_url() {
  printf '%s' "$1" | grep -oE 'https://[^[:space:]]+workers\.dev' | head -1
}

# `wrangler deployments list` prints oldest first: the live version is the last one.
parse_production_version() {
  printf '%s' "$1" | grep -E '^Version\(s\):' | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -1
}

preview_curl() {
  local url="$1"
  local attempt
  for attempt in 1 2 3 4 5; do
    if curl -fsS --max-time 30 -o /dev/null "$url"; then
      return 0
    fi
    if [ "$attempt" -lt 5 ]; then
      sleep 5
    fi
  done
  return 1
}

publish() {
  local commit="$1"
  local out id preview dep_out previous rollback_hint

  out="$(bash scripts/publish-web.sh "$commit" 2>&1)" || {
    printf '%s\n' "$out"
    die "publish-web upload failed"
  }
  printf '%s\n' "$out"

  id="$(parse_version_id "$out")"
  preview="$(parse_preview_url "$out")"
  [ -n "$id" ] || die "could not parse version id from publish output"
  [ -n "$preview" ] || die "could not parse preview URL from publish output"

  preview="${preview%/}"
  for path in / /marketplace /sitemap /market/data/site-map.json; do
    preview_curl "${preview}${path}" || die "preview check failed; version $id left unpromoted"
  done

  previous=""
  if dep_out="$("${WRANGLER_CMD[@]}" deployments list --name pokoin-web 2>&1)"; then
    previous="$(parse_production_version "$dep_out")"
  fi
  if [ -z "$previous" ]; then
    say "previous version unknown"
    rollback_hint="<previous>"
  else
    rollback_hint="$previous"
  fi

  bash scripts/publish-web.sh --promote "$id"
  say "promoted $id (main ${commit:0:12}); rollback: scripts/publish-web.sh --promote $rollback_hint"
}

# The checkout below rewrites this file mid-run: everything lives in main(),
# which bash has parsed in full before the first git command.
main() {
  HERE="$(cd "$(dirname "$0")/.." && pwd)"
  CANONICAL="${POKOIN_WEB_CANONICAL:-/home/nez/Projects/pokoin-web}"
  [[ "$HERE" != "$CANONICAL" ]] || die "never run in the canonical checkout; use the site-map-refresh Paseo worktree"
  [[ "$(basename "$HERE")" == "site-map-refresh" ]] || die "$HERE is not the site-map-refresh worktree (this script resets its tree)"
  cd "$HERE"

  MAP=market/public/data/site-map.json
  IMAGES=market/public/data/site-map-images.json

  for attempt in 1 2 3; do
    say "attempt $attempt: sync to origin/main"
    git fetch -q origin
    git reset -q --hard
    git clean -qfd -- market/public/data
    git checkout -q --detach origin/main
    base="$(git rev-parse HEAD)"

    node scripts/build-site-map.mjs
    if git diff --quiet -- "$MAP" "$IMAGES"; then
      say "site map unchanged on $base — nothing to publish"
      exit 0
    fi
    node --test market/src/site-map-graph.test.js

    git add -- "$MAP" "$IMAGES"
    git commit -q -m "chore(market): weekly site map refresh" \
      -m "Rebuilt $MAP and $IMAGES with scripts/refresh-site-map.sh (pokoin-site-map-refresh.timer)."
    if git push -q origin HEAD:main; then
      commit="$(git rev-parse HEAD)"
      say "pushed $commit to main; publishing"
      publish "$commit"
      exit 0
    fi
    say "main moved while building; retrying on the new origin/main"
  done
  die "could not push after 3 attempts"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
  exit
fi
