#!/usr/bin/env bash
# Run: bash scripts/refresh-site-map.test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$here/refresh-site-map.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }

sample_upload='Worker Version ID: 0b5a2c1e-1111-4222-8333-944455556666
Uploaded pokoin-web (12.34 sec)
Version Preview URL: https://0b5a2c1e-pokoin-web.giuseppe.workers.dev'

id="$(parse_version_id "$sample_upload")"
[ "$id" = "0b5a2c1e-1111-4222-8333-944455556666" ] || fail "parse_version_id got $id"

url="$(parse_preview_url "$sample_upload")"
[ "$url" = "https://0b5a2c1e-pokoin-web.giuseppe.workers.dev" ] || fail "parse_preview_url got $url"

classic='Version ID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
https://preview.example.workers.dev/extra'
id2="$(parse_version_id "$classic")"
[ "$id2" = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" ] || fail "parse_version_id classic got $id2"

# Real `wrangler deployments list` layout: oldest first, the live version last.
sample_deploy='Created:     2026-10-15T13:23:49.827Z
Version(s):  (100%) e9488275-e4fd-4fdd-a440-eb673397e928
                 Created:  2026-10-15T13:13:09.273Z
                 Message:  main a19ce13fe88e

Created:     2026-10-16T07:10:32.425Z
Version(s):  (100%) 7593dc2d-0e08-4723-8638-cdaec722a164
                 Created:  2026-10-16T07:07:06.143Z
                 Message:  main f1ca2ac79efe'
prev="$(parse_production_version "$sample_deploy")"
[ "$prev" = "7593dc2d-0e08-4723-8638-cdaec722a164" ] || fail "parse_production_version got $prev"

echo "refresh-site-map: ok"
