#!/usr/bin/env bash
# Deploy the Pokoin Associates desk API from an exact pokoin-web commit.
set -euo pipefail

die() { echo "deploy-associate-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-associate-api-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/pokoin-api | tar -C "$STAGE" -xf -
SRC="$STAGE/server/pokoin-api"
for file in marketplace-associate.js marketplace-associate.test.js; do
  [[ -f "$SRC/$file" ]] || die "commit is missing server/pokoin-api/$file"
done

say "associate unit tests"
node --test "$SRC/marketplace-associate.test.js"
node --check "$SRC/marketplace-associate.js"

release="releases/associate-$SHORT-$STAMP"
say "Pi release $release"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .associate-previous; cp -a \$prev '$release'; mkdir -p '$release/api'"
tar -C "$SRC" -cf - marketplace-associate.js \
  | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.pokoin-associate-commit'"

say "patch Pi route manifest"
ssh pi-home "cat '/srv/pokoin/api/$release/server/api-route-manifest.js'" > "$STAGE/manifest.js"
node -e '
const fs = require("node:fs");
const all = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const route = all.find((row) => row.path === "/api/marketplace-associate");
if (!route) throw new Error("associate route missing from route-definitions.json");
fs.writeFileSync(process.argv[2], JSON.stringify([route], null, 2));
' "$SRC/route-definitions.json" "$STAGE/associate-routes.json"
node "$SRC/patch-route-manifest.js" "$STAGE/manifest.js" "$STAGE/associate-routes.json"
node --check "$STAGE/manifest.js"
ssh pi-home "cat > '/srv/pokoin/api/$release/server/api-route-manifest.js'" < "$STAGE/manifest.js"

ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

say "verify health + auth gate"
healthy=0
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  anon="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/marketplace-associate" || true)"
  if [[ "$health" == "200" && "$anon" == "401" ]]; then
    healthy=1
    break
  fi
  sleep 2
done
if [[ "$healthy" != "1" ]]; then
  echo "health failed (health=$health anon=$anon) — rolling back" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .associate-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "Pi API verification failed; previous release restored"
fi

say "deployed $COMMIT — anonymous GET is correctly 401; sign in on pokoin.com/associate to verify a real desk."
