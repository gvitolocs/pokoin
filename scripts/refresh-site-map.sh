#!/usr/bin/env bash
# Weekly pokoin.com/sitemap refresh (pokoin-site-map-refresh.timer on nezopt).
#
#   scripts/refresh-site-map.sh            # run inside the site-map-refresh Paseo worktree
#
# Rebuilds market/public/data/site-map.json from the latest origin/main and the
# 15T catalog. Commits, pushes to main and deploys with scripts/deploy-web.sh only
# when the map changed. It runs in its own Paseo worktree that nothing else
# uses, so resetting that tree is safe; it refuses to run in the canonical
# checkout or any other worktree.
set -euo pipefail

die() { echo "refresh-site-map: $*" >&2; exit 1; }
say() { echo "== $(date -u +%FT%TZ) $*"; }

# The checkout below rewrites this file mid-run: everything lives in main(),
# which bash has parsed in full before the first git command.
main() {
  HERE="$(cd "$(dirname "$0")/.." && pwd)"
  CANONICAL="${POKOIN_WEB_CANONICAL:-/home/nez/Projects/pokoin-web}"
  [[ "$HERE" != "$CANONICAL" ]] || die "never run in the canonical checkout; use the site-map-refresh Paseo worktree"
  [[ "$(basename "$HERE")" == "site-map-refresh" ]] || die "$HERE is not the site-map-refresh worktree (this script resets its tree)"
  cd "$HERE"
  
  MAP=market/public/data/site-map.json
  
  for attempt in 1 2 3; do
    say "attempt $attempt: sync to origin/main"
    git fetch -q origin
    git reset -q --hard
    git clean -qfd -- market/public/data
    git checkout -q --detach origin/main
    base="$(git rev-parse HEAD)"
  
    node scripts/build-site-map.mjs
    if git diff --quiet -- "$MAP"; then
      say "site map unchanged on $base — nothing to deploy"
      exit 0
    fi
    node --test market/src/site-map-graph.test.js
  
    git add -- "$MAP"
    git commit -q -m "chore(market): weekly site map refresh" \
      -m "Rebuilt $MAP with scripts/refresh-site-map.sh (pokoin-site-map-refresh.timer)."
    if git push -q origin HEAD:main; then
      commit="$(git rev-parse HEAD)"
      say "pushed $commit to main; deploying"
      bash scripts/deploy-web.sh "$commit"
      exit 0
    fi
  say "main moved while building; retrying on the new origin/main"
done
die "could not push after 3 attempts"
}

main "$@"
exit
