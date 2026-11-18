#!/usr/bin/env bash
# Purge the homepage rail URLs from Cloudflare straight after a rails publish.
#
# A publish rewrites marketplace_rails; Cloudflare keeps the copy it cached for
# s-maxage=120 and then a further stale-while-revalidate=600, so a new order took
# up to twenty minutes to reach browsers. This is what the rails publish runs to
# end that wait; marketplace-home-purge.service is its unit.
#
# The URLs are exactly the ones the homepage asks for, on the host it asks the API
# on, spelled the way it spells them (market/src/lists.js): the three dedicated
# rails, the ?id= rails those three fall back to plus the grid rail, and one set
# rail per promo-fan slide. The fan's slugs come from the SPA's own list, so
# featuring another set needs no change here.
#
# Usage: marketplace-home-purge.sh [--dry-run | --help]
#   --dry-run  print the URLs that would be purged and call nothing.
# Environment: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID are required, read only
#   from the environment, and never printed, logged, or passed on a command line.
# Exit: 0 every batch was accepted, 1 a call failed or Cloudflare refused,
#   2 a required variable is missing.
set -euo pipefail

api='https://api.cloudflare.com/client/v4'
# Cloudflare caches the rails under this host, one copy per request Origin, because
# the handlers answer `vary: Origin`. The homepage reaches it through publicApiUrl()
# -> PUBLIC_API_ORIGIN, which market/src/extension-auth-bridge.js:90 sets, and
# market/src/lists.js:144 sends every rail fetch through it.
origin='https://api.pokoin.com'
site='https://pokoin.com'
mirror='https://www.pokoin.com'
variants=5
max_files=30
max_time=30

usage() {
    awk '/^set -euo/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0" >&2
    exit "${1:-2}"
}

dry_run=0
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) dry_run=1; shift ;;
        -h | --help) usage 0 ;;
        *) echo "marketplace-home-purge: unknown argument: $1" >&2; usage ;;
    esac
done

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# The fan's newest set: the same derivation market/src/promo-banners.js does.
new_set_slug=$(jq -r '.newCardsSet // empty' "$root/market/src/data/featured-set.json" |
    tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
if [ -z "$new_set_slug" ]; then
    echo "marketplace-home-purge: no newCardsSet in $root/market/src/data/featured-set.json" >&2
    exit 1
fi

mapfile -t fan_slugs < <(
    grep -oE "^    slug: '[^']+'" "$root/market/src/promo-banners.js" |
        sed -E "s/^    slug: '([^']+)'/\1/" |
        awk '!seen[$0]++'
)

paths=(
    /api/marketplace-home/new-cards
    /api/marketplace-home/best-sellers
    /api/marketplace-home/spotlight
)
rail_ids=(set:"$new_set_slug" spotlight new_cards best_sellers featured)
for slug in "${fan_slugs[@]}"; do
    rail_ids+=("set:$slug")
done
for id in "${rail_ids[@]}"; do
    paths+=("/api/marketplace-rails?id=$(jq -rn --arg id "$id" '$id|@uri')")
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

# Five files entries per rail path: the API host the browser reads (plain, plus one
# per Origin the page can be opened on), and the same-origin site/mirror paths the
# site Worker can also answer.
printf '%s\n' "${paths[@]}" | jq -Rcn \
    --arg origin "$origin" --arg site "$site" --arg mirror "$mirror" \
    '[inputs | . as $path |
        ($origin + $path),
        {url: ($origin + $path), headers: {Origin: $site}},
        {url: ($origin + $path), headers: {Origin: $mirror}},
        ($site + $path),
        ($mirror + $path)]' >"$work/files.json"

if [ "$dry_run" = 1 ]; then
    jq -r '.[] | if type == "object" then .url + " with Origin " + .headers.Origin else . end' \
        "$work/files.json"
    exit 0
fi

for name in CLOUDFLARE_ZONE_ID CLOUDFLARE_API_TOKEN; do
    if [ -z "${!name:-}" ]; then
        echo "marketplace-home-purge: $name is not set" >&2
        exit 2
    fi
done
for name in CLOUDFLARE_ZONE_ID CLOUDFLARE_API_TOKEN; do
    # Both go into curl's config file as one quoted value each.
    case "${!name}" in
        *[!A-Za-z0-9._~-]*)
            echo "marketplace-home-purge: $name is not a plain value" >&2
            exit 2
            ;;
    esac
done

conf=$work/curl.conf
{
    printf 'url = "%s/zones/%s/purge_cache"\n' "$api" "$CLOUDFLARE_ZONE_ID"
    printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN"
    printf 'header = "Content-Type: application/json"\n'
    printf 'request = "POST"\n'
    printf 'max-time = %d\n' "$max_time"
    printf 'silent\n'
} >"$conf"
chmod 600 "$conf"

files=$(jq 'length' "$work/files.json")
per_request=$((max_files / variants * variants))
failed=0
for ((lo = 0; lo < files; lo += per_request)); do
    hi=$((lo + per_request))
    count=$((hi < files ? hi - lo : files - lo))
    body=$(jq -c --argjson lo "$lo" --argjson hi "$hi" '{files: .[$lo:$hi]}' "$work/files.json")
    if ! http=$(printf '%s' "$body" | curl --config "$conf" -o "$work/response" \
        -w '%{http_code}' --data-binary @-); then
        echo "marketplace-home-purge: purged 0 urls: the Cloudflare call did not complete" >&2
        failed=1
        continue
    fi
    if ! verdict=$(jq -r --arg http "$http" \
        'if .success == true then "ok"
         else ([(.errors // [])[] | .message] | join("; ") |
               if . == "" then "Cloudflare refused (http " + $http + ")" else . end)
         end' "$work/response" 2>/dev/null); then
        verdict="Cloudflare answered http $http without json"
    fi
    echo "purged $((count / variants)) urls: $verdict"
    [ "$verdict" = "ok" ] || failed=1
done

exit "$failed"
