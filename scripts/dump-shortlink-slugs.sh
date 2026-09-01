#!/usr/bin/env bash
# Dump English card slugs from marketplace Postgres into the shortlink Worker index.
# Does not touch Cloudflare KV (Free plan is 1,000 puts/day).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/workers"
ssh -o ConnectTimeout=15 -o BatchMode=yes pokoin-marketplace \
  "docker exec pokoin-marketplace-postgres psql -U pokoin_marketplace -d pokoin_marketplace -At -c \"COPY (SELECT card_id, canonical_slug FROM marketplace_card_urls WHERE language = 'en') TO STDOUT WITH CSV\"" \
  | python3 -c "
import csv, gzip, struct, sys
from pathlib import Path
out = Path('$OUT')
rows = [(int(card_id), slug) for card_id, slug in csv.reader(sys.stdin)]
if len(rows) < 1000:
    raise SystemExit(f'too few slugs: {len(rows)}')
rows.sort()
ids = struct.pack('<' + 'I' * len(rows), *[card_id for card_id, _ in rows])
blob = ''.join(slug for _, slug in rows)
starts = [0]
off = 0
for _, slug in rows:
    off += len(slug)
    starts.append(off)
starts_bin = struct.pack('<' + 'I' * len(starts), *starts)
(out / 'card-ids.bin').write_bytes(ids)
(out / 'card-starts.bin').write_bytes(starts_bin)
(out / 'card-slug-blob.gz').write_bytes(gzip.compress(blob.encode('utf-8'), 9))
print(len(rows), 'slugs', 'ids', len(ids), 'starts', len(starts_bin), 'blob_gz', (out / 'card-slug-blob.gz').stat().st_size)
"
