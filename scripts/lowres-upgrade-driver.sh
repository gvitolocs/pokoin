#!/bin/sh
# Batch driver for the low-res leftover upgrade (nezopt).
#
# Walks the CardTrader probe results (ct_id, http_code, WxH) in BATCH-sized
# chunks and, per batch: thermal gate -> Oracle scratch reset -> ingest under a
# CPU cap -> rsync the batch output to the Pi and the local replica -> Cloudflare
# purge of exactly the replaced keys -> CDN byte-size verify -> done-ids.txt.
#
# It writes only inside $R/batches/<NNNN>/ (and $R/backup, $R/done-ids.txt); the
# objects it touches are the ones this batch staged. The only deletes are the two
# Oracle /tmp scratch items the ingest recreates. Nothing is pushed to git and no
# CLIP run happens (POKOIN_SKIP_VERSION_MATCH=1): version sets stay a separate,
# deliberate step.
#
# R=... BATCH=... MAXTEMP=... scripts/lowres-upgrade-driver.sh
# Stops without marking ids done when ingest fails or purge reports ERR; rerun it
# to continue (done-ids.txt is the resume point).
set -eu

R="${R:-$HOME/scratch/lowres-images}"
BATCH="${BATCH:-150}"
WORKTREE="${WORKTREE:-/home/nez/Projects/.worktrees/pokoin-web/lowres-mode}"
MAXTEMP="${MAXTEMP:-90}"

ORACLE="pokoin-marketplace"
PI="pi-home"
PI_OBJECTS="/srv/pokoin/card-images/objects"
REPLICA_OBJECTS="/home/nez/data/pokoin-leftovers/objects"
CDN="https://cdn.pokoin.com"
CF_ENV="$HOME/.config/pokoin/cloudflare.env"
SCRIPT="$WORKTREE/scripts/ingest-missing-product-images.py"
export TMPDIR="$HOME/scratch/tmp"

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() { log "FATAL $*"; exit 1; }

# ct_id per line: reachable scan, at least 700 px wide, in numeric order.
# The ingest takes CardTrader ids only (POKOIN_IDS_ARE_CARD_IDS stays unset), so
# ids.txt matches c.ct_id and never a colliding c.card_id.
list_candidates() {
  {
    for f in "$R"/pkprobe.[0-9][0-9].out; do
      [ -f "$f" ] || continue
      awk -F'\t' '{
        id = $1; code = $2; wh = tolower($3)
        gsub(/[ \t\r]/, "", id); gsub(/[ \t\r]/, "", code)
        sub(/x.*/, "", wh)
        if ((code == "200" || code == "206") && wh + 0 >= 700 && id + 0 > 0) print id + 0
      }' "$f"
    done
  } | sort -n -u
}

# Candidates minus what earlier batches already shipped.
todo_ids() {
  list_candidates | { grep -v -x -F -f "$R/done-ids.txt" || true; }
}

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

# 0001, 0002, ... continuing after the highest existing batch dir.
next_batch_no() {
  high=0
  for d in "$R"/batches/[0-9][0-9][0-9][0-9]; do
    [ -d "$d" ] || continue
    n=$(basename "$d" | sed 's/^0*//')
    [ -n "$n" ] || n=0
    if [ "$n" -gt "$high" ]; then high=$n; fi
  done
  printf '%s\n' $((high + 1))
}

cdn_size() {
  curl -sI "$CDN/$1" | tr -d '\r' \
    | awk 'tolower($1) == "content-length:" { v = $2 } END { print v }'
}

# Keys of $1 whose CDN content-length differs from the staged file.
mismatch_keys() {
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    file="$VERIFY_ROOT/$key"
    [ -f "$file" ] || continue
    want=$(wc -c <"$file" | tr -d ' ')
    got=$(cdn_size "$key")
    if [ "$got" != "$want" ]; then printf '%s\n' "$key"; fi
  done <"$1"
}

stat_field() {
  printf '%s\n' "$2" | tr '=' ' ' \
    | awk -v k="$1" '{ for (i = 1; i < NF; i++) if ($i == k) { print $(i + 1); exit } }'
}

[ -d "$R" ] || die "no probe dir $R"
[ -f "$SCRIPT" ] || die "no ingest script $SCRIPT"
mkdir -p "$R/batches" "$R/backup" "$TMPDIR"
[ -f "$R/done-ids.txt" ] || : >"$R/done-ids.txt"

HWMON=$(find_k10temp || true)
if [ -z "$HWMON" ]; then
  log "warn: no k10temp hwmon found; running without the thermal gate"
fi

log "start R=$R BATCH=$BATCH MAXTEMP=$MAXTEMP done=$(wc -l <"$R/done-ids.txt" | tr -d ' ')"

while :; do
  todo=$(todo_ids)
  if [ -z "$todo" ]; then
    if [ -f "$R/probe.finished" ]; then
      log "no candidates left and $R/probe.finished exists"
      nb=$(next_batch_no)
      log "summary batches=$((nb - 1)) done_ids=$(wc -l <"$R/done-ids.txt" | tr -d ' ') candidates=$(list_candidates | wc -l | tr -d ' ')"
      exit 0
    fi
    log "nothing to do and the probe has not finished; sleeping 300s"
    sleep 300
    continue
  fi

  wait_for_cool

  tag=$(printf '%04d' "$(next_batch_no)")
  bdir="$R/batches/$tag"
  mkdir -p "$bdir/out" "$bdir/tmp"
  ids=$(printf '%s\n' "$todo" | head -n "$BATCH")
  printf '%s\n' "$ids" >"$bdir/ids.txt"
  keys="$bdir/tmp/replaced-keys.txt"
  n_ids=$(printf '%s\n' "$ids" | wc -l | tr -d ' ')
  first=$(printf '%s\n' "$ids" | head -n 1)
  last=$(printf '%s\n' "$ids" | tail -n 1)
  log "batch $tag start ids=$n_ids range=$first..$last out=$bdir/out"

  # The ingest rsyncs the whole remote out dir, so stale scratch would leak in.
  if ! ssh -o BatchMode=yes "$ORACLE" \
    'rm -rf /tmp/pokoin-ct-fetch-out /tmp/pokoin-ct-fetch-jobs.json'; then
    log "batch $tag warn: Oracle scratch reset failed; ingest rewrites both paths"
  fi

  : >"$bdir/run.log"
  rc=0
  POKOIN_INGEST_ID_FILE="$bdir/ids.txt" \
    POKOIN_PRODUCT_IMAGE_DIR="$bdir/out" \
    POKOIN_TMP_DIR="$bdir/tmp" \
    POKOIN_BACKUP_DIR="$R/backup" \
    POKOIN_NO_PUSH=1 \
    POKOIN_MIN_SCAN_WIDTH=500 \
    HOMEPAGE_IMAGE_REFERENCE_WIDTH=480 \
    POKOIN_SKIP_VERSION_MATCH=1 \
    POKOIN_REGEN_PREVIEWS=1 \
    systemd-run --user --scope -p CPUQuota=200% nice -n 19 \
    python3 "$SCRIPT" >>"$bdir/run.log" 2>&1 || rc=$?
  rm -rf "$bdir/tmp/pokoin-ct-fetch-out"
  if [ "$rc" -ne 0 ]; then
    printf 'driver: ingest exit=%s\n' "$rc" >>"$bdir/run.log"
    die "batch $tag ingest exit=$rc; ids NOT marked done; see $bdir/run.log"
  fi

  if ! rsync -a "$bdir/out/" "$PI:$PI_OBJECTS/"; then
    die "batch $tag rsync to $PI:$PI_OBJECTS failed; ids NOT marked done"
  fi
  if ! rsync -a "$bdir/out/" "$REPLICA_OBJECTS/"; then
    die "batch $tag rsync to $REPLICA_OBJECTS failed; ids NOT marked done"
  fi

  if [ -s "$keys" ]; then
    n_keys=$(wc -l <"$keys" | tr -d ' ')
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
      die "batch $tag purge reported ERR lines; ids NOT marked done; see $bdir/purge.log"
    fi
    if [ "$purge_rc" -ne 0 ]; then
      die "batch $tag purge exit=$purge_rc; ids NOT marked done; see $bdir/purge.log"
    fi

    VERIFY_ROOT="$bdir/out"
    : >"$bdir/verify-fail.txt"
    mismatch_keys "$keys" >"$bdir/verify-retry.txt" || true
    if [ -s "$bdir/verify-retry.txt" ]; then
      sleep 20
      mismatch_keys "$bdir/verify-retry.txt" >"$bdir/verify-fail.txt" || true
    fi
    verify_fails=$(wc -l <"$bdir/verify-fail.txt" | tr -d ' ')
  else
    : >"$bdir/verify-fail.txt"
    n_keys=0
    verify_fails=0
    log "batch $tag nothing replaced; skipping purge"
  fi

  # Only a shipped and purged batch is done; verify gaps are reported, not fatal.
  printf '%s\n' "$ids" >>"$R/done-ids.txt"
  left=$(todo_ids | wc -l | tr -d ' ')
  stats=$(grep '^done saved=' "$bdir/run.log" | tail -n 1 || true)
  log "batch $tag done ids=$n_ids range=$first..$last keys=$n_keys saved=$(stat_field saved "$stats") skip=$(stat_field skip "$stats") fail=$(stat_field fail "$stats") verify_fail=$verify_fails candidates_left=$left"
  sleep 20
done
