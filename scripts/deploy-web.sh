#!/usr/bin/env bash
# The only production deploy path for pokoin-web (Vercel project `web`). Run on nezopt.
#
#   scripts/deploy-web.sh [commit]          # default HEAD; must already be on origin/main
#
# Why (2026-09-17, see docs/DEPLOY.md): agents shared one checkout and each put its
# own line of history into production — `vercel --prod` from feature branches and
# dirty trees, plus Vercel's GitHub auto-deploy of main. Each deploy silently removed
# the previous one's work (/email-preferences, Scan Connect). Git-built deploys also
# served a 404 /download/extension.zip (gitignored). vercel.json now sets
# git.deploymentEnabled.main=false, and this script enforces:
#   1. the commit is on origin/main (integrate there first);
#   2. the commit contains the commit production runs (meta gitCommitSha / githubCommitSha);
#   3. the build is a git archive of that commit + an allowlist of gitignored inputs;
#   4. one production deploy at a time (flock); the deployed SHA is recorded and re-checked.
set -euo pipefail

die() { echo "deploy-web: $*" >&2; exit 1; }
say() { echo "== $*"; }
V() { env -u VERCEL_TOKEN vercel "$@"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
CANONICAL="${POKOIN_WEB_CANONICAL:-/home/nez/Projects/pokoin-web}"
# Gitignored files scripts/build-web.sh needs. Nothing else from any working tree is used.
UNTRACKED_INPUTS=(download/extension.zip)

command -v vercel >/dev/null \
  || die "vercel CLI not on PATH. Non-interactive shells miss ~/.local/bin: run this through a login shell (bash -lc)."

exec 9>/tmp/pokoin-web-deploy.lock
flock -n 9 || die "another pokoin-web production deploy is running"

say "commit $COMMIT — $(git -C "$REPO" log -1 --format=%s "$COMMIT" | cut -c1-80)"
git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main. Merge it into main and push first."

# `vercel inspect --format=json` omits meta; the REST API has it.
prod_state() {
  local id
  # A silent failure here used to read as "production has no commit", which the
  # check below reports as a branch deploy. Fail on the API call instead.
  id="$(V api /v4/aliases/pokoin.com 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["deploymentId"])')" \
    || die "cannot read the pokoin.com alias from Vercel (logged in? \`vercel whoami\`)"
  V api "/v13/deployments/$id" 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
m = d.get("meta") or {}
print(d["id"], m.get("gitCommitSha") or m.get("githubCommitSha") or "-")'
}

read -r prod_id prod_sha <<<"$(prod_state)"
if [[ "$prod_sha" != "-" ]]; then
  git -C "$REPO" cat-file -e "$prod_sha^{commit}" 2>/dev/null \
    || die "production runs $prod_sha, which this repo does not have (a branch deploy?). Fetch it and merge it into main."
  git -C "$REPO" merge-base --is-ancestor "$prod_sha" "$COMMIT" \
    || die "commit does not contain production $prod_sha. Merge it into main first; deploying would remove live work."
  say "contains production $prod_sha ($prod_id)"
else
  [[ "${ALLOW_UNTRACKED_PRODUCTION:-}" == "$prod_id" ]] \
    || die "production $prod_id has no commit SHA. Compare its bundle with this commit, then rerun with ALLOW_UNTRACKED_PRODUCTION=$prod_id"
  say "production $prod_id untracked — accepted explicitly"
fi

stage="$(mktemp -d /tmp/pokoin-web-deploy-XXXXXX)"
say "stage $stage (git archive)"
git -C "$REPO" archive "$COMMIT" | tar -x -C "$stage"
for f in "${UNTRACKED_INPUTS[@]}"; do
  [[ -f "$CANONICAL/$f" ]] || die "missing build input $CANONICAL/$f"
  mkdir -p "$stage/$(dirname "$f")"
  cp "$CANONICAL/$f" "$stage/$f"
done
mkdir -p "$stage/.vercel"
cp "$CANONICAL/.vercel/project.json" "$stage/.vercel/project.json"

say "unit tests"
(cd "$stage/market" && npm ci --no-audit --no-fund >/dev/null && cd .. && node --test market/src/*.test.js >"$stage/tests.log" 2>&1) \
  || { tail -30 "$stage/tests.log" >&2; die "tests failed"; }
grep -E "^# (tests|pass|fail)" "$stage/tests.log"

say "vercel build + deploy"
(cd "$stage" && V build --prod --yes >"$stage/build.log" 2>&1) || { tail -30 "$stage/build.log" >&2; die "build failed"; }
[[ -f "$stage/.vercel/output/static/download/extension.zip" ]] || die "build output lacks download/extension.zip"
(cd "$stage" && V deploy --prebuilt --prod --yes --archive=tgz \
  --meta gitCommitSha="$COMMIT" --meta deployedBy="${DEPLOYED_BY:-$(whoami)@$(hostname)}" >"$stage/deploy.log" 2>&1) \
  || { tail -30 "$stage/deploy.log" >&2; die "deploy failed"; }
url="$(grep -Eo 'https://web-[a-z0-9]+-[a-z0-9-]+\.vercel\.app' "$stage/deploy.log" | tail -1)"
say "deployed $url"

live="-"
for i in $(seq 1 30); do
  read -r _ live <<<"$(prod_state)"
  [[ "$live" == "$COMMIT" ]] && break
  sleep 2
done
[[ "$live" == "$COMMIT" ]] || die "pokoin.com runs $live, not $COMMIT — another deploy raced this one"
# test.pokoin.com is a separate Vercel alias and can lag behind pokoin.com.
host="${url#https://}"
say "point test.pokoin.com at $host"
V alias set "$host" test.pokoin.com >/dev/null
say "pokoin.com + test.pokoin.com run $COMMIT"
echo "$url"
