#!/bin/sh
# Batch driver for cards that have NO image yet (nezopt).
#
# Walks a file of CardTrader ids (ct_id per line) in BATCH-sized chunks and, per
# batch: thermal gate -> Oracle scratch reset -> ingest under a CPU cap -> rsync
# the batch output to the Pi and the local replica -> Cloudflare purge of exactly
# the staged keys -> CDN HTTP-200 verify -> stamp the DB rows -> done-ids.
#
# scripts/lowres-upgrade-driver.sh upgrades scans that already exist and stops at
# the CDN; these cards have no image at all, so a scan only helps once
# cardtrader_pokemon_blueprints and the candidate/card/version rows point at it.
# Hence the stamp step (STAMP=dry|apply, dry by default). LIST is the whole input:
# there are no probe files.
#
# Usage:
#   LIST=<file of ct_ids, one per line> [BATCH=150] [R=$HOME/scratch/lowres-images]
#     [MAXTEMP=90] [STAMP=dry|apply] [IDS=<ct_id[,ct_id]>|<file of ids>]
#     scripts/missing-images-driver.sh
#
# IDS restricts the run to those ids (each must be in LIST). STAMP=dry (default)
# prints the per-table count of rows a stamp WOULD change and writes nothing;
# STAMP=apply prints those dry counts first for the same batch, then writes one
# transaction per batch, and refuses to run on any host but nezopt. The old values
# of every row an apply pass touched land in $R/missing-undo/<batch>.sql and its
# restore command line goes to the batch log.
#
# Resume is $R/missing-done-ids.txt; every batch gets its own directory under
# $R/missing-batches/<NNNN>/. The run stops on any ingest/rsync/purge/verify error
# without stamping and without marking the batch ids done, so the next run retries
# them: only keys that answer HTTP 200 on the CDN are ever stamped.
#
# Per-batch results land in <batch>/results.tsv as `ct_id  status  reason  width`
# (tabs; status replaced|skipped|failed, width of the accepted main JPEG). Reasons:
# new / overwrote_existing (a scan this batch staged), already_shipped /
# skip_smaller (an equal or wider object exists already), scan_too_small /
# no_scan_source / no_catalog_row / ambiguous_key / placeholder_object (a replica
# object too small to use) (nothing usable). Ids under $UNDER500_WIDTH (500) px are
# listed in $R/missing-under500.txt as `ct_id  name  width` for review; that file
# accumulates across runs and is never truncated.
#
# Stamp keys resolve from the batch out dir first, then from this driver's own
# $R/missing-shipped.tsv record, then from the local replica object: an object that
# is already live but whose DB rows are still empty is exactly what the stamp fixes,
# and the HTTP-200 check, the replica width check and the empty-target predicate
# still gate every write.
#
# It writes inside $R/missing-batches/, $R/missing-work/, $R/missing-undo/,
# $R/backup, $R/missing-done-ids.txt, $R/missing-shipped.tsv and
# $R/missing-under500.txt; the only objects it touches are the ones its own batches
# staged, the only ids it ingests, verifies, stamps or marks done are in LIST, and
# the only deletes are the two Oracle /tmp scratch items the ingest recreates.
# Nothing is pushed to git and no CLIP run happens (POKOIN_SKIP_VERSION_MATCH=1):
# version sets stay a separate, deliberate step. No schema change and no column
# outside the ones named below is written.
set -eu

R="${R:-$HOME/scratch/lowres-images}"
BATCH="${BATCH:-150}"
MAXTEMP="${MAXTEMP:-90}"
STAMP="${STAMP:-dry}"
LIST="${LIST:-}"
IDS="${IDS:-}"
LOCK_TIMEOUT="${LOCK_TIMEOUT:-10s}"
MIN_SCAN_WIDTH="${MIN_SCAN_WIDTH:-240}"
UNDER500_WIDTH="${UNDER500_WIDTH:-500}"

ORACLE="${ORACLE:-pokoin-marketplace}"
PI="${PI:-pi-home}"
PI_OBJECTS="${PI_OBJECTS:-/srv/pokoin/card-images/objects}"
REPLICA_OBJECTS="${REPLICA_OBJECTS:-/home/nez/data/pokoin-leftovers/objects}"
CDN="${CDN:-https://cdn.pokoin.com}"
CF_ENV="${CF_ENV:-$HOME/.config/pokoin/cloudflare.env}"
PG_CONTAINER="${PG_CONTAINER:-pokoin-marketplace-postgres-15t}"
PG_USER="${PG_USER:-pokoin_marketplace}"
PG_DB="${PG_DB:-pokoin_marketplace}"

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKTREE="${WORKTREE:-$(CDPATH= cd -- "$SELF_DIR/.." && pwd)}"
SCRIPT="$WORKTREE/scripts/ingest-missing-product-images.py"
BP=public.cardtrader_pokemon_blueprints
OVERLAY_TABLES="marketplace_search_candidates marketplace_cards marketplace_card_versions"

export TMPDIR="${TMPDIR:-$HOME/scratch/tmp}"

log() {
  line=$(printf '%s %s' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*")
  printf '%s\n' "$line"
  if [ -n "${BATCH_LOG:-}" ]; then
    printf '%s\n' "$line" >>"$BATCH_LOG"
  fi
}
die() { log "FATAL $*"; exit 1; }

usage() {
  printf '%s\n' "usage: LIST=<file of ct_ids, one per line> [BATCH=150] [R=\$HOME/scratch/lowres-images] [MAXTEMP=90] [STAMP=dry|apply] [IDS=<ct_id[,ct_id]>|<file>] scripts/missing-images-driver.sh"
}

# ------------------------------------------------------------------- inputs

# LIST minus blanks/comments, numeric ct_ids only, sorted. A malformed line stops
# the run instead of quietly working on the wrong id; the awk status stays visible
# because it is not the last command of a pipeline.
all_ids() {
  awk '
    /^[ \t]*$/ { next }
    /^[ \t]*#/ { next }
    {
      id = $0
      gsub(/[ \t\r]/, "", id)
      if (id !~ /^[0-9]+$/ || id + 0 <= 0) { print "bad line: " $0 > "/dev/stderr"; exit 3 }
      print id + 0
    }' "$LIST" >"$WORK/LIST.raw" || return 1
  sort -n -u "$WORK/LIST.raw"
}

# IDS=<comma list|file>, when given, narrows the run to those ids.
requested_ids() {
  if [ -f "$IDS" ]; then
    cat "$IDS"
  else
    printf '%s\n' "$IDS" | tr ',' '\n'
  fi | awk '
    /^[ \t]*$/ { next }
    {
      id = $1
      gsub(/[ \t\r]/, "", id)
      if (id ~ /^[0-9]+$/ && id + 0 > 0) print id + 0
    }' | sort -n -u
}

# The candidate ids: LIST, or the IDS subset of it.
todo_source() {
  if [ -n "$IDS" ]; then
    grep -x -F -f "$WORK/ids-requested.txt" "$LIST_IDS"
  else
    cat "$LIST_IDS"
  fi | sort -n -u
}

# Candidates minus what earlier batches already finished.
todo_ids() {
  todo_source | { grep -v -x -F -f "$DONE" || true; } | awk 'NF'
}

# Refuse before any work if an id we are about to touch is not in LIST. Files may
# carry a second column (the key), which is not part of the id.
assert_in_list() { # $1 = file of ids, optionally followed by a key column
  while read -r id rest; do
    [ -n "$id" ] || continue
    if ! grep -q -x -- "$id" "$LIST_IDS"; then
      die "id $id is not in LIST=$LIST; refusing to run"
    fi
  done <"$1"
}

# 0001, 0002, ... continuing after the highest existing batch dir.
next_batch_no() {
  high=0
  for d in "$BATCHES"/[0-9][0-9][0-9][0-9]; do
    [ -d "$d" ] || continue
    n=$(basename "$d" | sed 's/^0*//')
    [ -n "$n" ] || n=0
    if [ "$n" -gt "$high" ]; then high=$n; fi
  done
  printf '%s\n' $((high + 1))
}

# ------------------------------------------------------------------- objects

# ct_id of a leftover key: the digits before the first underscore.
key_ct_id() {
  printf '%s\n' "$1" | sed -n 's/^\([0-9]\{1,\}\)_[^/]*\.jpg$/\1/p'
}

key_name() { # $1 = key -> display name from the slug
  printf '%s\n' "$1" | sed 's/^[0-9]*_//; s/\.jpg$//; s/-/ /g'
}

homepage_of() { # $1 = main jpg key
  printf '%s\n' "$1" | sed 's/\.jpg$/_homepage.webp/'
}

# Unique <ct_id>_*.jpg basename in $1: '' when none, '?' when several, because a
# name-slug collision is never guessed at.
match_key() { # $1 = dir, $2 = ct_id
  found=''
  count=0
  for f in "$1/$2_"*.jpg; do
    [ -e "$f" ] || continue
    count=$((count + 1))
    found=$(basename "$f")
  done
  if [ "$count" -ge 2 ]; then
    printf '?\n'
  elif [ "$count" -eq 1 ]; then
    printf '%s\n' "$found"
  fi
}

# Key a previous run of this driver shipped for $1 but never stamped.
shipped_key() { # $1 = ct_id
  if [ -f "$SHIPPED" ]; then
    awk -v id="$1" -F'\t' '$1 == id { print $2 }' "$SHIPPED" | tail -n 1
  fi
}

jpeg_width() { # $1 = file; '-' when unreadable
  f="$1"
  w=''
  if command -v identify >/dev/null 2>&1; then
    w=$(identify -format '%w' "$f" 2>/dev/null | head -n 1) || w=''
  fi
  case "$w" in
    '' | *[!0-9]*)
      w=$(python3 -c 'import sys; from PIL import Image; print(Image.open(sys.argv[1]).size[0])' "$f" 2>/dev/null) || w=''
      ;;
  esac
  case "$w" in
    '' | *[!0-9]*) printf -- '-\n' ;;
    *) printf '%s\n' "$w" ;;
  esac
}

# An object this batch did not stage is stampable only when it is a real scan on
# the local replica, i.e. what the ingest's is_placeholder() would reject: the
# 186x260 CardTrader logo, anything narrower than MIN_SCAN_WIDTH, or an image
# whose dimensions cannot be read. Grey backs and tiny catalog thumbs must never
# get a CDN URL stamped onto a catalog row.
stampable_object() { # $1 = main jpg key -> that key when usable
  f="$REPLICA_OBJECTS/$1"
  [ -f "$f" ] || return 0
  w=$(jpeg_width "$f")
  case "$w" in
    '' | *[!0-9]*) return 0 ;;
  esac
  [ "$w" -ge "$MIN_SCAN_WIDTH" ] || return 0
  printf '%s\n' "$1"
}

# ------------------------------------------------------------------- thermal

find_k10temp() {
  if [ "$(cat /sys/class/hwmon/hwmon4/name 2>/dev/null)" = "k10temp" ]; then
    printf '%s\n' /sys/class/hwmon/hwmon4
    return 0
  fi
  for d in /sys/class/hwmon/hwmon*; do
    if [ "$(cat "$d/name" 2>/dev/null)" = "k10temp" ]; then
      printf '%s\n' "$d"
      return 0
    fi
  done
  return 1
}

cpu_degrees() {
  [ -n "$HWMON" ] || return 1
  raw=$(cat "$HWMON/temp1_input" 2>/dev/null) || return 1
  case "$raw" in '' | *[!0-9]*) return 1 ;; esac
  printf '%s\n' $((raw / 1000))
}

wait_for_cool() {
  while :; do
    if ! deg=$(cpu_degrees); then
      log "temperature unreadable; running without the thermal gate"
      return 0
    fi
    if [ "$deg" -lt "$MAXTEMP" ]; then
      return 0
    fi
    log "CPU ${deg}C >= ${MAXTEMP}C; waiting 60s"
    sleep 60
  done
}

# ------------------------------------------------------------------- CDN

# HTTP code of one key; 000 when the request itself never completed.
cdn_code() { # $1 = key
  code=$(curl -sS -o /dev/null --max-time 30 -w '%{http_code}' "$CDN/$1" 2>/dev/null) || code=''
  case "$code" in
    '' | *[!0-9]*) printf '000\n' ;;
    *) printf '%s\n' "$code" ;;
  esac
}

# Keys of $1 that are not 200, written to $2 as `key code`; prints the count.
verify_keys() { # $1 = keys file, $2 = failures file
  : >"$2"
  while read -r key; do
    [ -n "$key" ] || continue
    code=$(cdn_code "$key")
    if [ "$code" != 200 ]; then
      printf '%s %s\n' "$key" "$code" >>"$2"
    fi
  done <"$1"
  wc -l <"$2" | tr -d ' '
}

key_failed_verify() { # $1 = key, $2 = failures file
  awk -v k="$1" '$1 == k { found = 1 } END { exit !found }' "$2"
}

# ------------------------------------------------------------------- database

db_exec() { # $1 = SQL; stdout = rows
  printf '%s\n' "$1" | docker exec -i "$PG_CONTAINER" psql \
    -U "$PG_USER" -d "$PG_DB" -At -v ON_ERROR_STOP=1
}

required_columns() { # $1 = table
  case "$1" in
    cardtrader_pokemon_blueprints)
      printf '%s\n' id cdn_image_url cdn_object_key homepage_image_url homepage_object_key ;;
    marketplace_search_candidates)
      printf '%s\n' card_id ct_id image_url cdn_image_url preview_image_url homepage_image_url ;;
    marketplace_cards | marketplace_card_versions)
      printf '%s\n' card_id ct_id image_url cdn_image_url preview_image_url ;;
  esac
}

# The stamp writes exactly these columns, so check them before any ingest burns a
# batch and name the gap instead of failing inside a transaction.
preflight() {
  found="$WORK/preflight-found.txt"
  err="$WORK/preflight-err.txt"
  sql="SELECT 'PREFOUND '||table_name||'.'||column_name FROM information_schema.columns
WHERE table_schema='public'
  AND table_name IN ('cardtrader_pokemon_blueprints','marketplace_search_candidates','marketplace_cards','marketplace_card_versions')
  AND column_name IN ('id','card_id','ct_id','image_url','cdn_image_url','cdn_object_key','homepage_image_url','homepage_object_key','preview_image_url')
ORDER BY 1"
  if ! db_exec "$sql" >"$found" 2>"$err"; then
    die "column preflight failed on $PG_CONTAINER: $(tail -n 3 "$err" | tr '\n' ' ')"
  fi
  for table in cardtrader_pokemon_blueprints $OVERLAY_TABLES; do
    for col in $(required_columns "$table"); do
      if ! grep -q -x -- "PREFOUND $table.$col" "$found"; then
        die "missing column public.$table.$col (or the table itself) in database $PG_DB; refusing to stamp"
      fi
    done
  done
  log "preflight ok tables=4 database=$PG_DB"
}

sql_quoted() { # $1 = value -> SQL string literal, quotes doubled
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"
}

# VALUES list of the batch keys: (123,'123_abra.jpg','123_abra_homepage.webp').
keys_values() { # $1 = ct_id<TAB>key file
  list=''
  while read -r id key; do
    [ -n "$id" ] || continue
    [ -n "$key" ] || continue
    if [ "$(key_ct_id "$key")" != "$id" ]; then
      die "key $key does not start with ct_id $id"
    fi
    if [ -n "$list" ]; then
      list="$list,"
    fi
    list=$(printf '%s(%s,%s,%s)' "$list" "$id" "$(sql_quoted "$key")" "$(sql_quoted "$(homepage_of "$key")")")
  done <"$1"
  printf '%s\n' "$list"
}

overlay_short() {
  case "$1" in
    marketplace_search_candidates) printf 'cand' ;;
    marketplace_cards) printf 'cards' ;;
    marketplace_card_versions) printf 'vers' ;;
  esac
}

# One transaction per batch, in dry or apply mode. The touch tables fix each
# predicate once, so the dry count, the captured undo values and the UPDATE cannot
# disagree. Every write fills a row whose own cdn_image_url is still empty; dry
# rolls back and leaves nothing behind but the counts.
stamp_sql() { # $1 = dry|apply, $2 = VALUES list
  mode="$1"
  values="$2"
  printf '%s\n' "-- missing-images-driver stamp mode=$mode database=$PG_DB"
  printf '%s\n' 'BEGIN;'
  printf '%s\n' "SET LOCAL lock_timeout='$LOCK_TIMEOUT';"
  printf '%s\n' 'CREATE TEMP TABLE missing_keys(id bigint PRIMARY KEY, main_key text, homepage_key text) ON COMMIT DROP;'
  printf '%s\n' "INSERT INTO missing_keys(id,main_key,homepage_key) VALUES $values;"
  printf '%s\n' "CREATE TEMP TABLE missing_stamped ON COMMIT DROP AS SELECT k.id, k.main_key, k.homepage_key FROM missing_keys k JOIN $BP b ON b.id = k.id WHERE nullif(b.cdn_image_url,'') IS NULL;"
  printf '%s\n' "SELECT 'COUNT cardtrader_pokemon_blueprints '||count(*) FROM missing_stamped;"
  if [ "$mode" = apply ]; then
    printf '%s\n' "SELECT 'UNDO UPDATE $BP SET cdn_image_url='||quote_nullable(b.cdn_image_url)||', cdn_object_key='||quote_nullable(b.cdn_object_key)||', homepage_image_url='||quote_nullable(b.homepage_image_url)||', homepage_object_key='||quote_nullable(b.homepage_object_key)||' WHERE id='||b.id||';' FROM $BP b JOIN missing_stamped s ON s.id = b.id;"
    printf '%s\n' "UPDATE $BP b SET cdn_image_url='$CDN/'||s.main_key, cdn_object_key=s.main_key, homepage_image_url='$CDN/'||s.homepage_key, homepage_object_key=s.homepage_key FROM missing_stamped s WHERE b.id = s.id AND nullif(b.cdn_image_url,'') IS NULL;"
  fi
  for table in $OVERLAY_TABLES; do
    short=$(overlay_short "$table")
    if [ "$table" = marketplace_search_candidates ]; then
      home_update=', homepage_image_url=b.homepage_image_url'
      home_undo="||', homepage_image_url='||quote_nullable(c.homepage_image_url)"
    else
      home_update=''
      home_undo=''
    fi
    printf '%s\n' "CREATE TEMP TABLE missing_touch_$short ON COMMIT DROP AS SELECT c.card_id AS pk FROM public.$table c WHERE c.ct_id IN (SELECT id FROM missing_stamped) AND nullif(c.cdn_image_url,'') IS NULL;"
    printf '%s\n' "SELECT 'COUNT $table '||count(*) FROM missing_touch_$short;"
    if [ "$mode" = apply ]; then
      printf '%s\n' "SELECT 'UNDO UPDATE public.$table SET image_url='||quote_nullable(c.image_url)||', cdn_image_url='||quote_nullable(c.cdn_image_url)||', preview_image_url='||quote_nullable(c.preview_image_url)$home_undo||' WHERE card_id='||c.card_id||';' FROM public.$table c JOIN missing_touch_$short t ON t.pk = c.card_id;"
      printf '%s\n' "UPDATE public.$table c SET image_url=b.cdn_image_url, cdn_image_url=b.cdn_image_url, preview_image_url=coalesce(b.preview_image_url,b.cdn_image_url)$home_update FROM $BP b WHERE c.ct_id = b.id AND c.card_id IN (SELECT pk FROM missing_touch_$short);"
    fi
  done
  if [ "$mode" = apply ]; then
    printf '%s\n' 'COMMIT;'
  else
    printf '%s\n' 'ROLLBACK;'
  fi
}

# Dry: per-table counts a stamp WOULD change, no write. Apply: the same counts plus
# the actual row counts, with the touched rows' old values in $R/missing-undo.
stamp_batch() { # $1 = bdir, $2 = tag, $3 = dry|apply
  bdir="$1"
  tag="$2"
  mode="$3"
  keys="$bdir/stamp-keys.tsv"
  counts="$bdir/dry-counts.txt"
  if [ "$mode" = dry ]; then
    : >"$counts"
  fi
  if [ ! -s "$keys" ]; then
    log "batch $tag stamp=$mode skipped: no verified key"
    return 0
  fi
  assert_in_list "$keys"
  if [ "$mode" = apply ] && [ "${DRY_PRINTED_TAG:-}" != "$tag" ]; then
    die "batch $tag apply refused: its dry counts were not printed first in this run"
  fi
  values=$(keys_values "$keys")
  if [ -z "$values" ]; then
    log "batch $tag stamp=$mode skipped: no keys"
    return 0
  fi
  out="$WORK/stamp-$mode.txt"
  err="$WORK/stamp-$mode.err"
  if ! db_exec "$(stamp_sql "$mode" "$values")" >"$out" 2>"$err"; then
    die "batch $tag stamp ($mode) failed on $PG_CONTAINER: $(tail -n 3 "$err" | tr '\n' ' ')"
  fi
  grep '^COUNT ' "$out" | while read -r kind table rows; do
    [ "$kind" = COUNT ] || continue
    log "batch $tag stamp=$mode table=$table rows=$rows"
    if [ "$mode" = dry ]; then
      printf '%s\t%s\n' "$table" "$rows" >>"$counts"
    fi
  done
  if [ "$mode" = apply ]; then
    write_undo "$out" "$UNDO_DIR/$tag.sql" "$tag"
    log "batch $tag undo: docker exec -i $PG_CONTAINER psql -U $PG_USER -d $PG_DB -v ON_ERROR_STOP=1 < $UNDO_DIR/$tag.sql"
  fi
}

# The UNDO lines come from inside the transaction, captured immediately before each
# UPDATE, so the file restores exactly the rows the stamp touched.
write_undo() { # $1 = stamp output, $2 = destination, $3 = tag
  src="$1"
  dest="$2"
  tag="$3"
  tmp="$WORK/undo-lines.txt"
  grep '^UNDO ' "$src" | sed 's/^UNDO //' >"$tmp" || true
  if [ ! -s "$tmp" ]; then
    log "batch $tag undo: no row was touched, no undo file"
    return 0
  fi
  {
    printf '%s\n' "-- missing-images-driver undo for batch $tag (host $(hostname 2>/dev/null || echo unknown), database $PG_DB)"
    printf '%s\n' "-- generated $(date -u '+%Y-%m-%dT%H:%M:%SZ') by scripts/missing-images-driver.sh with STAMP=apply"
    printf '%s\n' "-- Old values of every row the stamp touched, captured in the same transaction"
    printf '%s\n' "-- right before each UPDATE. Restoring them returns the image columns to the"
    printf '%s\n' "-- pre-stamp state; the objects themselves stay on the CDN."
    printf '%s\n' 'BEGIN;'
    printf '%s\n' "SET LOCAL lock_timeout='$LOCK_TIMEOUT';"
    cat "$tmp"
    printf '%s\n' 'COMMIT;'
  } >"$dest"
  log "batch $tag undo file=$dest lines=$(wc -l <"$tmp" | tr -d ' ')"
}

# ------------------------------------------------------------------- ingest

# The Oracle scan scratch is global on the remote side and the ingest rsyncs the
# whole remote out dir, so stale scratch would leak into this batch.
reset_oracle_scratch() {
  if ! ssh -o BatchMode=yes "$ORACLE" \
    'rm -rf /tmp/pokoin-ct-fetch-out /tmp/pokoin-ct-fetch-jobs.json'; then
    log "warn: Oracle scratch reset failed; ingest rewrites both paths"
  fi
}

# 240 px: these cards have no image at all, so a small real scan beats none.
run_ingest() { # $1 = bdir, $2 = tag
  bdir="$1"
  tag="$2"
  rc=0
  POKOIN_INGEST_ID_FILE="$bdir/ids.txt" \
    POKOIN_PRODUCT_IMAGE_DIR="$bdir/out" \
    POKOIN_TMP_DIR="$bdir/tmp" \
    POKOIN_BACKUP_DIR="$BACKUP" \
    POKOIN_PLACEHOLDER_ID_FILE="$bdir/tmp/ingest-ids.json" \
    POKOIN_NO_PUSH=1 \
    POKOIN_MIN_SCAN_WIDTH="$MIN_SCAN_WIDTH" \
    HOMEPAGE_IMAGE_REFERENCE_WIDTH="${HOMEPAGE_IMAGE_REFERENCE_WIDTH:-480}" \
    POKOIN_SKIP_VERSION_MATCH=1 \
    POKOIN_REGEN_PREVIEWS=1 \
    systemd-run --user --scope -p CPUQuota=200% nice -n 19 \
    python3 "$SCRIPT" >>"$bdir/run.log" 2>&1 || rc=$?
  rm -rf "$bdir/tmp/pokoin-ct-fetch-out"
  summary=$(grep '^done saved=' "$bdir/run.log" | tail -n 1 || true)
  if [ -z "$summary" ]; then
    printf 'driver: ingest exit=%s\n' "$rc" >>"$bdir/run.log"
    die "batch $tag ingest exit=$rc without a summary line; nothing stamped, ids NOT marked done; see $bdir/run.log"
  fi
  if [ "$rc" -ne 0 ]; then
    # Exit 1 after a summary line means the batch found nothing usable: every id
    # lost its scan, which is a result for these cards, not a broken run.
    log "batch $tag ingest found nothing to stage (exit=$rc)"
  fi
  log "batch $tag ingest $summary"
}

# ------------------------------------------------------------------- results

# Which refusal line the ingest logged for this id, or none.
run_log_reason() { # $1 = bdir, $2 = ct_id
  if grep -q "^skip-smaller $2_" "$1/run.log" 2>/dev/null; then
    printf 'skip_smaller\n'
  elif grep -q "^placeholder $2 " "$1/run.log" 2>/dev/null; then
    printf 'scan_too_small\n'
  elif grep -q "^miss $2 " "$1/run.log" 2>/dev/null; then
    printf 'no_scan_source\n'
  else
    printf 'none\n'
  fi
}

# Key named by the skip-smaller line (that object is already on the replica).
skip_smaller_key() { # $1 = bdir, $2 = ct_id
  grep "^skip-smaller $2_" "$1/run.log" 2>/dev/null | head -n 1 | sed 's/^skip-smaller //'
}

record_under500() { # $1 = id, $2 = key, $3 = width
  line="$1$(printf '\t')$(key_name "$2")$(printf '\t')"
  if [ -f "$UNDER" ] && grep -Fq -- "$line" "$UNDER"; then
    return 0
  fi
  printf '%s\t%s\t%s\n' "$1" "$(key_name "$2")" "$3" >>"$UNDER"
}

# One row per ct_id: replaced|skipped|failed, why, and the accepted width. Keys
# with an object worth stamping go to verify-keys.txt; stamp-keys.tsv is filled
# after the CDN check.
classify_batch() { # $1 = bdir, $2 = tag
  bdir="$1"
  tag="$2"
  res="$bdir/results.tsv"
  : >"$res"
  : >"$bdir/new-keys.tsv"
  : >"$bdir/verify-keys.txt"
  : >"$bdir/stamp-keys.tsv"
  printf '%s\n' 'ct_id	status	reason	width' >>"$res"
  while read -r id; do
    [ -n "$id" ] || continue
    width='-'
    key=$(match_key "$bdir/out" "$id")
    if [ "$key" = '?' ]; then
      printf '%s\t%s\t%s\t%s\n' "$id" failed ambiguous_key '-' >>"$res"
      log "batch $tag ambiguous key for id $id; not touched"
      continue
    fi
    if [ -n "$key" ]; then
      status=replaced
      reason=new
      width=$(jpeg_width "$bdir/out/$key")
      if [ -f "$REPLICA_OBJECTS/$key" ] || [ -f "$BACKUP/$key" ]; then
        reason=overwrote_existing
      fi
      printf '%s\t%s\n' "$id" "$key" >>"$bdir/new-keys.tsv"
    else
      reason=$(run_log_reason "$bdir" "$id")
      status=skipped
      if [ "$reason" = scan_too_small ] || [ "$reason" = no_scan_source ]; then
        status=failed
      elif [ "$reason" = skip_smaller ]; then
        key=$(skip_smaller_key "$bdir" "$id")
      else
        # Nothing in the log: either an object is already there (the ingest counts
        # it as skipped without a word) or this id is not an ingessable row.
        key=$(shipped_key "$id")
        if [ -z "$key" ]; then
          key=$(match_key "$REPLICA_OBJECTS" "$id")
        fi
        if [ "$key" = '?' ]; then
          key=''
          status=failed
          reason=ambiguous_key
        elif [ -z "$key" ]; then
          status=failed
          reason=no_catalog_row
        else
          reason=already_shipped
        fi
      fi
    fi
    if [ -n "$key" ] && [ "$width" = '-' ]; then
      for local_file in "$bdir/out/$key" "$REPLICA_OBJECTS/$key"; do
        if [ -f "$local_file" ]; then
          width=$(jpeg_width "$local_file")
          break
        fi
      done
    fi
    # A key the ingest staged is a scan it accepted; one this driver only adopted
    # from the Pi/replica must clear the same placeholder yardstick.
    if [ -n "$key" ] && [ ! -f "$bdir/out/$key" ] &&
      [ -z "$(stampable_object "$key")" ]; then
      log "batch $tag $id: replica object $key is a placeholder or unreadable; not stamped"
      key=''
      status=failed
      reason=placeholder_object
    fi
    printf '%s\t%s\t%s\t%s\n' "$id" "$status" "$reason" "$width" >>"$res"
    if [ -n "$key" ]; then
      printf '%s\n%s\n' "$key" "$(homepage_of "$key")" >>"$bdir/verify-keys.txt"
      if [ "$width" != '-' ] && [ "$width" -lt "$UNDER500_WIDTH" ]; then
        record_under500 "$id" "$key" "$width"
      fi
    fi
  done <"$bdir/ids.txt"
}

count_status() { # $1 = results file, $2 = status
  awk -F'\t' -v want="$2" 'NR > 1 && $2 == want { n++ } END { print n + 0 }' "$1"
}

# Rows this batch can stamp whose accepted scan is narrower than UNDER500_WIDTH.
count_under() { # $1 = results file
  awk -F'\t' -v max="$UNDER500_WIDTH" \
    'NR > 1 && $2 != "failed" && $4 != "-" && $4 + 0 > 0 && $4 + 0 < max { n++ } END { print n + 0 }' "$1"
}

# Only ids whose main JPEG and homepage WebP both answered 200 get stamped.
build_stamp_keys() { # $1 = bdir, $2 = tag
  bdir="$1"
  : >"$bdir/stamp-keys.tsv"
  if [ ! -s "$bdir/verify-keys.txt" ]; then
    log "batch $tag stamp keys=0 (nothing staged)"
    return 0
  fi
  ok="$bdir/verify-ok.txt"
  : >"$ok"
  while read -r key; do
    [ -n "$key" ] || continue
    if key_failed_verify "$key" "$bdir/verify-fail.txt"; then
      continue
    fi
    printf '%s\n' "$key" >>"$ok"
  done <"$bdir/verify-keys.txt"
  sort -u -o "$ok" "$ok"
  while read -r key; do
    [ -n "$key" ] || continue
    id=$(key_ct_id "$key")
    [ -n "$id" ] || continue
    home=$(homepage_of "$key")
    if grep -q -x -- "$home" "$ok"; then
      printf '%s\t%s\n' "$id" "$key" >>"$bdir/stamp-keys.tsv"
    else
      log "batch $tag warn: $key is 200 but $home is not; id $id not stamped"
    fi
  done <"$ok"
  sort -n -u -o "$bdir/stamp-keys.tsv" "$bdir/stamp-keys.tsv"
  log "batch $tag stamp keys=$(wc -l <"$bdir/stamp-keys.tsv" | tr -d ' ')"
}

# ------------------------------------------------------------------- startup

case "$STAMP" in
  dry | apply) ;;
  *) usage; die "STAMP must be dry or apply (got $STAMP)" ;;
esac
if [ -z "$LIST" ]; then
  usage
  die "LIST=<file of ct_ids, one per line> is required"
fi
[ -f "$LIST" ] || die "no such LIST file: $LIST"
case "$BATCH" in
  '' | *[!0-9]* | 0) die "BATCH must be a positive integer (got $BATCH)" ;;
esac

BATCHES="$R/missing-batches"
WORK="$R/missing-work"
UNDO_DIR="$R/missing-undo"
DONE="$R/missing-done-ids.txt"
SHIPPED="$R/missing-shipped.tsv"
BACKUP="$R/backup"
UNDER="$R/missing-under500.txt"
LIST_IDS="$WORK/LIST.ids"

mkdir -p "$BATCHES" "$WORK" "$UNDO_DIR" "$BACKUP" "$TMPDIR"
[ -d "$REPLICA_OBJECTS" ] || log "warn: no replica dir $REPLICA_OBJECTS"
[ -f "$R/purge.py" ] || die "no purge.py in $R: this driver purges the CDN through it"
[ -f "$CF_ENV" ] || die "no Cloudflare env $CF_ENV"
[ -f "$SCRIPT" ] || die "no ingest script $SCRIPT (set WORKTREE=...)"
[ -f "$DONE" ] || : >"$DONE"
[ -f "$SHIPPED" ] || : >"$SHIPPED"

if ! all_ids >"$LIST_IDS"; then
  die "LIST=$LIST has a line that is not a positive ct_id"
fi
n_list=$(wc -l <"$LIST_IDS" | tr -d ' ')
[ "$n_list" -gt 0 ] || die "LIST=$LIST has no ct_ids"

if [ -n "$IDS" ]; then
  requested_ids >"$WORK/ids-requested.txt"
  n_req=$(wc -l <"$WORK/ids-requested.txt" | tr -d ' ')
  [ "$n_req" -gt 0 ] || die "IDS=$IDS matched no ct_id"
  assert_in_list "$WORK/ids-requested.txt"
fi

case "$(hostname 2>/dev/null || echo unknown)" in
  nezopt*) ;;
  *)
    if [ "$STAMP" = apply ]; then
      die "STAMP=apply runs only on nezopt; this host is $(hostname 2>/dev/null || echo unknown)"
    fi
    log "warn: not nezopt; the stamp stays dry (apply is refused off nezopt)"
    ;;
esac

HWMON=$(find_k10temp || true)
[ -n "$HWMON" ] || log "warn: no k10temp hwmon found; running without the thermal gate"

log "start list=$LIST ids=$n_list done=$(wc -l <"$DONE" | tr -d ' ') R=$R BATCH=$BATCH MAXTEMP=$MAXTEMP stamp=$STAMP min_scan_width=$MIN_SCAN_WIDTH"
preflight

# ------------------------------------------------------------------- batches

RUN_BATCHES=0
RUN_STAMPED=0

while :; do
  todo=$(todo_ids)
  if [ -z "$todo" ]; then
    log "no ids left"
    break
  fi
  wait_for_cool

  tag=$(printf '%04d' "$(next_batch_no)")
  bdir="$BATCHES/$tag"
  mkdir -p "$bdir/out" "$bdir/tmp"
  BATCH_LOG="$bdir/batch.log"
  export BATCH_LOG
  printf '%s\n' "$todo" | head -n "$BATCH" >"$bdir/ids.txt"
  assert_in_list "$bdir/ids.txt"
  n_ids=$(wc -l <"$bdir/ids.txt" | tr -d ' ')
  first=$(head -n 1 "$bdir/ids.txt")
  last=$(tail -n 1 "$bdir/ids.txt")
  log "batch $tag start ids=$n_ids range=$first..$last out=$bdir/out stamp=$STAMP"

  reset_oracle_scratch
  : >"$bdir/run.log"
  run_ingest "$bdir" "$tag"
  classify_batch "$bdir" "$tag"
  n_replaced=$(count_status "$bdir/results.tsv" replaced)
  n_skipped=$(count_status "$bdir/results.tsv" skipped)
  n_failed=$(count_status "$bdir/results.tsv" failed)
  log "batch $tag results replaced=$n_replaced skipped=$n_skipped failed=$n_failed under${UNDER500_WIDTH}=$(count_under "$bdir/results.tsv") details=$bdir/results.tsv"

  if [ -s "$bdir/new-keys.tsv" ]; then
    if ! rsync -a "$bdir/out/" "$PI:$PI_OBJECTS/"; then
      die "batch $tag rsync to $PI:$PI_OBJECTS failed; nothing stamped, ids NOT marked done"
    fi
    if ! rsync -a "$bdir/out/" "$REPLICA_OBJECTS/"; then
      die "batch $tag rsync to $REPLICA_OBJECTS failed; nothing stamped, ids NOT marked done"
    fi
    cat "$bdir/new-keys.tsv" >>"$SHIPPED"
    log "batch $tag shipped=$(wc -l <"$bdir/new-keys.tsv" | tr -d ' ') to $PI and $REPLICA_OBJECTS"
  else
    log "batch $tag nothing staged; skipping rsync"
  fi

  keys="$bdir/tmp/replaced-keys.txt"
  if [ -s "$keys" ]; then
    purge_rc=0
    (
      set -a
      # shellcheck disable=SC1090 # Runtime credential file, mode 0600.
      . "$CF_ENV"
      set +a
      python3 "$R/purge.py" "$keys"
    ) >"$bdir/purge.log" 2>&1 || purge_rc=$?
    if grep -q '^ERR' "$bdir/purge.log"; then
      grep '^ERR' "$bdir/purge.log" | head -n 5
      die "batch $tag purge reported ERR lines; nothing stamped, ids NOT marked done; see $bdir/purge.log"
    fi
    if [ "$purge_rc" -ne 0 ]; then
      die "batch $tag purge exit=$purge_rc; nothing stamped, ids NOT marked done; see $bdir/purge.log"
    fi
    log "batch $tag purged keys=$(wc -l <"$keys" | tr -d ' ')"
  else
    log "batch $tag nothing replaced; skipping purge"
  fi

  if [ -s "$bdir/verify-keys.txt" ]; then
    sort -u -o "$bdir/verify-keys.txt" "$bdir/verify-keys.txt"
    n_verify=$(wc -l <"$bdir/verify-keys.txt" | tr -d ' ')
    fails=$(verify_keys "$bdir/verify-keys.txt" "$bdir/verify-fail.txt")
    if [ "$fails" -gt 0 ]; then
      sleep 20
      fails=$(verify_keys "$bdir/verify-keys.txt" "$bdir/verify-fail.txt")
    fi
    if [ "$fails" -gt 0 ]; then
      head -n 5 "$bdir/verify-fail.txt"
      die "batch $tag verify: $fails of $n_verify key(s) not 200; nothing stamped, ids NOT marked done; see $bdir/verify-fail.txt"
    fi
    log "batch $tag verify keys=$n_verify all=200"
  else
    : >"$bdir/verify-fail.txt"
  fi

  build_stamp_keys "$bdir" "$tag"
  if [ -s "$bdir/stamp-keys.tsv" ]; then
    DRY_PRINTED_TAG=''
    stamp_batch "$bdir" "$tag" dry
    DRY_PRINTED_TAG="$tag"
    total_would=$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$bdir/dry-counts.txt")
    if [ "$STAMP" = dry ]; then
      log "batch $tag stamp=dry would_change=$total_would and wrote nothing"
    elif [ "$total_would" -eq 0 ]; then
      log "batch $tag stamp=apply skipped: the dry counts are all zero"
    else
      stamp_batch "$bdir" "$tag" apply
    fi
    RUN_STAMPED=$((RUN_STAMPED + $(wc -l <"$bdir/stamp-keys.tsv" | tr -d ' ')))
  fi

  {
    cat "$DONE"
    cat "$bdir/ids.txt"
  } | sort -n -u >"$WORK/done-next.txt"
  mv "$WORK/done-next.txt" "$DONE"
  left=$(todo_ids | wc -l | tr -d ' ')
  log "batch $tag done ids=$n_ids range=$first..$last replaced=$n_replaced stamp_keys=$(wc -l <"$bdir/stamp-keys.tsv" | tr -d ' ') ids_left=$left"
  BATCH_LOG=''
  RUN_BATCHES=$((RUN_BATCHES + 1))
  sleep 20
done

# ------------------------------------------------------------------- summary

for status in replaced skipped failed; do
  n=$(awk -F'\t' 'NR > 1 && $2 == st { c++ } END { print c + 0 }' st="$status" "$BATCHES"/*/results.tsv 2>/dev/null || printf 0)
  log "summary all_batches $status=$n"
done
log "summary run batches=$RUN_BATCHES stamp_keys=$RUN_STAMPED under${UNDER500_WIDTH}=$(wc -l <"$UNDER" | tr -d ' ') stamp=$STAMP"
log "summary state ids=$n_list done=$(wc -l <"$DONE" | tr -d ' ') under500_file=$UNDER"
exit 0
