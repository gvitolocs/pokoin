#!/usr/bin/env bash
# Guarded production deploy of pokoin-web (Vercel project `web`). Run on nezopt.
#
#   scripts/deploy-web.sh [commit]          # default HEAD
#
# Why this exists (2026-09-17): several agent sessions share this repo and each
# deployed its own line of history to the same production. A deploy from a line
# that lacked another session's already-deployed commit silently removed that
# work from pokoin.com (/email-preferences vanished 10 minutes after it shipped).
#
# Rules enforced here — docs/DEPLOY.md:
#   1. Build from a commit (git archive), never from a working tree.
#   2. The commit must contain the commit production currently runs
#      (Vercel meta gitCommitSha, mirrored at origin/production).
#   3. One pokoin-web production deploy at a time (flock).
#   4. Every deploy records gitCommitSha on Vercel and fast-forwards origin/production.
set -euo pipefail

die() { echo "deploy-web: $*" >&2; exit 1; }
say() { echo "== $*"; }
V() { env -u VERCEL_TOKEN vercel "$@"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
CANONICAL="${POKOIN_WEB_CANONICAL:-/home/nez/Projects/pokoin-web}"
# Gitignored files the build needs (scripts/build-web.sh). Nothing else is copied.
UNTRACKED_INPUTS=(download/extension.zip)

exec 9>/tmp/pokoin-web-deploy.lock
flock -n 9 || die "another pokoin-web production deploy is running"

say "commit $COMMIT ($(git -C "$REPO" log -1 --format=%s "$COMMIT" | cut -c1-80))"
git -C "$REPO" fetch -q origin || die "git fetch origin failed"

prod="$(V inspect pokoin.com --format=json)"
prod_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$prod")"
prod_sha="$(python3 -c 'import json,sys; print((json.load(sys.stdin).get("meta") or {}).get("gitCommitSha",""))' <<<"$prod")"
if [[ -n "$prod_sha" ]]; then
  git -C "$REPO" cat-file -e "$prod_sha^{commit}" 2>/dev/null \
    || die "production runs $prod_sha, which this repo does not have. git fetch origin production && merge it."
  git -C "$REPO" merge-base --is-ancestor "$prod_sha" "$COMMIT" \
    || die "commit does not contain production $prod_sha. Merge origin/production first; deploying would remove live work."
  say "contains production $prod_sha"
else
  [[ "${ALLOW_UNTRACKED_PRODUCTION:-}" == "$prod_id" ]] \
    || die "production $prod_id was deployed without gitCommitSha, so it cannot be checked. Compare its bundle with this commit, then rerun with ALLOW_UNTRACKED_PRODUCTION=$prod_id"
  say "production $prod_id untracked — accepted explicitly"
fi

stage="$(mktemp -d /tmp/pokoin-web-deploy-XXXXXX)"
say "stage $stage from git archive"
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
(cd "$stage" && V deploy --prebuilt --prod --yes --archive=tgz \
  --meta gitCommitSha="$COMMIT" --meta deployedBy="${DEPLOYED_BY:-$(whoami)@$(hostname)}" >"$stage/deploy.log" 2>&1) \
  || { tail -30 "$stage/deploy.log" >&2; die "deploy failed"; }
url="$(grep -Eo 'https://web-[a-z0-9]+-[a-z0-9-]+\.vercel\.app' "$stage/deploy.log" | tail -1)"
say "deployed $url"

for i in $(seq 1 30); do
  live="$(V inspect pokoin.com --format=json | python3 -c 'import json,sys; print((json.load(sys.stdin).get("meta") or {}).get("gitCommitSha",""))')"
  [[ "$live" == "$COMMIT" ]] && break
  sleep 2
done
[[ "$live" == "$COMMIT" ]] || die "pokoin.com does not point at $COMMIT yet (points at ${live:-untracked})"

git -C "$REPO" push -q origin "$COMMIT:refs/heads/production" \
  || die "deployed, but origin/production could not fast-forward to $COMMIT — fix before the next deploy"
say "pokoin.com runs $COMMIT; origin/production updated"
echo "$url"
