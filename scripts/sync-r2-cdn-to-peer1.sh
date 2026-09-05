#!/usr/bin/env bash
# Sync R2 cardvault-images → peer1 /home/ubuntu/pokoin-cdn (ease R2 10 GB free cap).
# Does not delete R2. Does not print secrets.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_HOST="${1:-oracle-peer1}"
DEST_PATH="${2:-/home/ubuntu/pokoin-cdn}"
CONCURRENCY="${CONCURRENCY:-8}"

if [[ -f /home/nez/secrets/deploy/supabase-pokoin.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /home/nez/secrets/deploy/cloudflare-r2.env 2>/dev/null || true
  set +a
fi
# Prefer dedicated r2 env; fall back to marketplace docker env names on host.
for f in \
  /home/nez/secrets/deploy/cloudflare-r2.env \
  /home/nez/secrets/deploy/oci-free-stack/r2.env \
  /home/nez/Projects/cardvault/pokemon_card_vault/.env
do
  if [[ -f "$f" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$f"
    set +a
  fi
done

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID required}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID required}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY required}"
BUCKET="${POKOIN_CARD_IMAGES_BUCKET:-cardvault-images}"
ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
STAGING="${STAGING:-/tmp/pokoin-cdn-sync}"
mkdir -p "$STAGING"

echo "sync $BUCKET → $DEST_HOST:$DEST_PATH (staging $STAGING)"
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto

# Prefer aws cli if present; else python boto3.
if command -v aws >/dev/null 2>&1; then
  aws s3 sync "s3://${BUCKET}" "$STAGING" \
    --endpoint-url "$ENDPOINT" \
    --exclude "originals/*" \
    --exclude "manifests/*" \
    --only-show-errors
else
  python3 - <<PY
import os, pathlib, boto3
from botocore.config import Config
endpoint = os.environ["ENDPOINT"] if "ENDPOINT" in os.environ else "$ENDPOINT"
bucket = "$BUCKET"
staging = pathlib.Path("$STAGING")
staging.mkdir(parents=True, exist_ok=True)
client = boto3.client(
    "s3",
    endpoint_url=endpoint,
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    region_name="auto",
    config=Config(signature_version="s3v4", max_pool_connections=int("$CONCURRENCY")),
)
token = None
copied = 0
skipped = 0
while True:
    kwargs = {"Bucket": bucket, "MaxKeys": 1000}
    if token:
        kwargs["ContinuationToken"] = token
    page = client.list_objects_v2(**kwargs)
    for obj in page.get("Contents") or []:
        key = obj["Key"]
        if key.startswith("originals/") or key.startswith("manifests/"):
            skipped += 1
            continue
        dest = staging / key
        if dest.exists() and dest.stat().st_size == obj["Size"]:
            skipped += 1
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        client.download_file(bucket, key, str(dest))
        copied += 1
        if copied % 200 == 0:
            print(f"copied={copied} skipped={skipped}", flush=True)
    if not page.get("IsTruncated"):
        break
    token = page.get("NextContinuationToken")
print(f"done copied={copied} skipped={skipped}")
PY
fi

ssh -o BatchMode=yes "$DEST_HOST" "mkdir -p '$DEST_PATH'"
rsync -a --info=stats2 "$STAGING"/ "$DEST_HOST:$DEST_PATH"/
ssh -o BatchMode=yes "$DEST_HOST" "du -sh '$DEST_PATH'; find '$DEST_PATH' -type f | wc -l"
echo "sync complete (R2 untouched — delete separately after verify)"
