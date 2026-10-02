#!/usr/bin/env bash
# Deploy the shared marketplace game registry to the Pi API from an exact
# origin/main commit: which games exist (_cardtrader_game_ingest.js), how a
# request picks its game DB (_marketplace_game.js), and which CDN prefixes keep
# their raw image keys (_marketplace_row.js).
#
# These files otherwise only arrive with a full CardVault release, so a new
# game (docs/CARDMARKET_GAMES.md) would stay invisible on api.pokoin.com.
#
#   scripts/deploy-multigame-registry-api.sh [commit]
set -euo pipefail

die() { echo "deploy-multigame-registry-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-game-registry-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

FILES=(
  _cardtrader_game_ingest.js
  _marketplace_game.js
  _marketplace_row.js
)
# A game that must answer with cards after the deploy (Cardmarket-only game).
PROBE_GAME="${PROBE_GAME:-final_fantasy}"

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/pokoin-api | tar -C "$STAGE" -xf -
SRC="$STAGE/server/pokoin-api"
for file in "${FILES[@]}"; do
  [[ -f "$SRC/$file" ]] || die "commit is missing server/pokoin-api/$file"
  node --check "$SRC/$file"
done

say "registry unit tests"
node --test "$SRC/_marketplace_row.test.js"

release="releases/game-registry-$SHORT-$STAMP"
say "Pi release $release (overlay; preserves other handlers)"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .game-registry-previous; cp -a \$prev '$release'"
tar -C "$SRC" -cf - "${FILES[@]}" | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.pokoin-game-registry-commit'"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

say "verify health + $PROBE_GAME catalog"
healthy=0; health=""; rows=""
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  rows="$(ssh pi-home "curl -s 'http://127.0.0.1:18080/api/marketplace-search-page?game=$PROBE_GAME&limit=5'" \
    | PROBE_GAME="$PROBE_GAME" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const ok=j.game===process.env.PROBE_GAME&&Array.isArray(j.cards);console.log(ok?j.cards.length:0)}catch(_){console.log(0)}})' || true)"
  if [[ "$health" == "200" && "${rows:-0}" -gt 0 ]]; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo "verification failed (health=$health $PROBE_GAME rows=${rows:-0}) — rolling back" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .game-registry-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "Pi API verification failed; previous release restored"
fi

say "API live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
say "commit=$COMMIT health=$health $PROBE_GAME search rows=$rows"
