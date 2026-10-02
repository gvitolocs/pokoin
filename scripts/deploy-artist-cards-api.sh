#!/usr/bin/env bash
# Deploy the artist catalog handler (server/api/marketplace-artist-cards.js)
# plus its vendored helpers from an exact origin/main commit. The handler
# supports tiles=1 — artist/profile identity served once instead of repeated
# on every card row (the SPA artist desk payload drops from ~6 MB decoded to
# roughly a third of that).
set -euo pipefail

die() { echo "deploy-artist-cards-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-artist-cards-api-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/api | tar -C "$STAGE" -xf -
SRC="$STAGE/server/api"
for file in marketplace-artist-cards.js _artist_display.js marketplace-expansions.js marketplace-card-versions.js; do
  [[ -f "$SRC/$file" ]] || die "commit is missing server/api/$file"
done

say "artist cards unit tests"
NODE_PATH="${REPO}/server/node_modules${NODE_PATH:+:$NODE_PATH}" \
  node --test "$SRC/marketplace-artist-cards.test.js" | grep -E "^# (pass|fail)"
node --check "$SRC/marketplace-artist-cards.js"

release="releases/artist-cards-$SHORT-$STAMP"
say "Pi release $release"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .artist-cards-previous; cp -a \$prev '$release'"
tar -C "$SRC" -cf - marketplace-artist-cards.js _artist_display.js marketplace-expansions.js marketplace-card-versions.js \
  | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.pokoin-artist-cards-commit'"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

say "verify health + artist cards endpoint"
healthy=0
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  [ "$health" = "200" ] && healthy=1 && break
  sleep 2
done
[ "$healthy" = "1" ] || die "api :18080 did not come back healthy"
tiles="$(ssh pi-home "curl -fsS 'http://127.0.0.1:18080/api/marketplace-artist-cards?artistSlug=ken-sugimori&limit=1&tiles=1'" || true)"
echo "$tiles" | python3 -c '
import json, sys
data = json.load(sys.stdin)
cards = data.get("cards") or []
assert data.get("artist"), "artist identity missing"
if cards:
    row = cards[0]
    assert "profile_summary" not in row, "tiles row still carries profile columns"
    assert row.get("image_url") or row.get("cdn_image_url"), "tiles row lost its image"
print("tiles payload ok:", len(cards), "card(s), artist", data["artist"].get("name"))
' || die "tiles verification failed"
say "done: artist-cards API deployed from ${COMMIT:0:12}"
