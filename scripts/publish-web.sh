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
# --promote prints how many of Cloudflare's retained versions this host uploaded through the CI gate. An id it
# did not record is still promoted (the rollback path), until every retained version went through the gate: then
# such an id is refused, because it cannot be an older-than-the-gate rollback target any more.
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

# Every version this script uploads or promotes: <UTC>\t<version-id>\t<sha>\t<green|override|promoted|promoted-unrecorded>.
VERSIONS_LOG="${POKOIN_WEB_VERSIONS_LOG:-$HOME/pokoin-deploy/web-versions.tsv}"
record_version() { # version-id sha kind: a log problem warns, it never stops a publish
  { mkdir -p "$(dirname "$VERSIONS_LOG")" \
    && printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" >> "$VERSIONS_LOG"; } 2> /dev/null \
    || echo "publish-web: WARNING cannot write $VERSIONS_LOG" >&2
}

mode=upload
case "${1:-}" in
  --promote)
    VERSION_ID="${2:?--promote requires a version id}"
    # Promoting an older version is the rollback path, so an id this host did not upload is not refused outright:
    # it gets a warning and a `promoted-unrecorded` line. The exception exists for versions uploaded before the CI
    # gate, so it ends by itself once every retained version went through the gate (docs/CI.md, "Deploy gate").
    PROMOTE_SHA="$(awk -F'\t' -v id="$VERSION_ID" '$2 == id && $3 != "-" { print $3; exit }' "$VERSIONS_LOG" 2> /dev/null || true)"

    # The retained versions, as wrangler lists them. The `--json` shape (an array of objects with an `id`) is taken
    # from the Cloudflare documentation and has not been seen from the real tool by this run: the count line below
    # makes a wrong assumption visible at the first real promote.
    list_why=
    retained_ids=
    if ! list_json="$("${WRANGLER_CMD[@]}" versions list --name pokoin-web --json 2> /dev/null)"; then
      list_why="wrangler versions list did not answer"
    elif ! retained_ids="$(printf '%s\n' "$list_json" | jq -r '.[].id' 2> /dev/null)"; then
      list_why="wrangler versions list did not answer with JSON"
    fi
    retained=0
    gated=0
    if [ -z "$list_why" ]; then
      while IFS= read -r id; do
        case "$id" in "" | null) continue ;; esac
        retained=$((retained + 1))
        if awk -F'\t' -v id="$id" '$2 == id && ($4 == "green" || $4 == "override") { found = 1; exit } END { exit !found }' \
          "$VERSIONS_LOG" 2> /dev/null; then
          gated=$((gated + 1))
        fi
      done <<< "$retained_ids"
      [ "$retained" -gt 0 ] || list_why="no version id came back"
    fi
    all_through_gate=0
    if [ -n "$list_why" ]; then
      echo "publish-web: the retained versions could not be listed ($list_why)"
    else
      echo "publish-web: $gated of $retained retained versions were uploaded through the gate"
      if [ "$gated" = "$retained" ]; then all_through_gate=1; fi
    fi

    # The same self-check the upload path gets through the gate, but a warning while an old checkout can still be
    # a rollback target, and a refusal only once every retained version was gated.
    if ! git fetch -q origin main 2> /dev/null; then
      echo "publish-web: WARNING git fetch origin main failed; this checkout's deploy scripts were not compared with origin/main" >&2
    elif ! self_note="$(bash "$ROOT/scripts/require-ci-green.sh" --self-check-only --repo-dir "$ROOT" \
      --caller-script "$ROOT/scripts/publish-web.sh" 2>&1)"; then
      if [ "$all_through_gate" = 1 ]; then
        printf '%s\n' "$self_note" >&2
        exit 1
      fi
      echo "publish-web: WARNING promoting anyway: this checkout's deploy scripts are not origin/main's, and an old checkout is still a possible rollback target" >&2
      printf '%s\n' "$self_note" >&2
    fi

    if [ -n "$PROMOTE_SHA" ]; then
      PROMOTE_KIND=promoted
    elif [ "$all_through_gate" = 1 ]; then
      echo "publish-web: REFUSED version $VERSION_ID was not uploaded through this script; every retained version was, so this one is not a rollback target." >&2
      exit 1
    else
      echo "publish-web: WARNING version $VERSION_ID was not uploaded through this script on this host; its commit's CI state is unknown" >&2
      PROMOTE_SHA=-
      PROMOTE_KIND=promoted-unrecorded
    fi
    "${WRANGLER_CMD[@]}" versions deploy "$VERSION_ID@100%" --name pokoin-web -y
    record_version "$VERSION_ID" "$PROMOTE_SHA" "$PROMOTE_KIND"
    exit 0
    ;;
  --build-only)
    mode=build
    shift
    ;;
esac

exec 9>"${POKOIN_WEB_PUBLISH_LOCK:-/tmp/pokoin-web-publish.lock}"
flock 9

git fetch -q origin main
SHA="$(git rev-parse --verify "${1:-origin/main}^{commit}")"
# --build-only may build any commit (a branch to preview); uploads only origin/main.
if [ "$mode" = upload ] && ! git merge-base --is-ancestor "$SHA" origin/main; then
  echo "publish-web: $SHA is not on origin/main" >&2
  exit 1
fi
CI_RESULT=
if [ "$mode" = upload ]; then
  # Uploads only a commit whose required GitHub checks are green, and only from a checkout whose own scripts are
  # origin/main's (docs/CI.md, "Deploy gate").
  POKOIN_CI_CALLER=publish-web bash "$ROOT/scripts/require-ci-green.sh" --repo-dir "$ROOT" \
    --caller-script "$ROOT/scripts/publish-web.sh" "$SHA"
  CI_RESULT=green
  if [ -n "${POKOIN_CI_OVERRIDE:-}" ]; then CI_RESULT=override; fi
fi
SHORT="${SHA:0:12}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pokoin-web-publish.XXXXXX")"
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
  record_version "$VERSION_ID" "$SHA" "$CI_RESULT"
  echo "pokoin-web version $VERSION_ID (main $SHORT). Check the Version Preview URL above, then:"
  echo "  scripts/publish-web.sh --promote $VERSION_ID"
else
  echo "pokoin-web: could not parse the version id from the upload output" >&2
fi
