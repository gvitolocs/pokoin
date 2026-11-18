#!/usr/bin/env bash
# Purge the homepage rail URLs from Cloudflare straight after a rails publish.
#
# A publish rewrites marketplace_rails; Cloudflare keeps the copy it cached for
# s-maxage=120 and then a further stale-while-revalidate=600, so a new order took
# up to twenty minutes to reach browsers. marketplace-rails-sync runs this after it.
#
# The URLs are exactly the ones the homepage asks for, spelled the way it spells
# them (market/src/lists.js): the three dedicated rails, the ?id= rails those three
# fall back to plus the grid rail, and one set rail per promo-fan slide. The fan's
# slugs come from the SPA's own list, so featuring another set needs no change here.
#
# Usage: marketplace-home-purge.sh [--dry-run | --help]
#   --dry-run  print the URLs that would be purged and call nothing.
# Environment: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID are required, read only
#   from the environment, and never printed, logged, or passed on a command line.
# Exit: 0 every batch was accepted, 1 a call failed or Cloudflare refused,
#   2 a required variable is missing.
set -euo pipefail

api='https://api.cloudflare.com/client/v4'
site='https://pokoin.com'
mirror='https://www.pokoin.com'
max_files=30
max_time=30

usage() {
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' >&2
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

# Three files entries per URL: the one a browser without the Vary'd Origin header
# hits, the one cached under Origin: https://pokoin.com, and the www mirror's copy.
printf '%s\n' "${paths[@]}" | jq -Rcn \
    --arg site "$site" --arg mirror "$mirror" \
    '[inputs | . as $path |
        ($site + $path),
        {url: ($site + $path), headers: {Origin: $site}},
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
per_request=$((max_files / 3 * 3))
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
    echo "purged $count urls: $verdict"
    [ "$verdict" = "ok" ] || failed=1
done

exit "$failed"
