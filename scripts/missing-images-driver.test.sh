#!/bin/sh
# Tests scripts/missing-images-driver.sh with stub commands on PATH: no ssh, no
# docker/psql, no rsync, no curl, no ingest and no CDN call is real. The stub psql
# answers the column preflight and the stamp pass from canned rows, so the checks
# cover the driver's own decisions: the LIST guard, the dry default, the apply
# gate, and which objects are stampable. Run: sh scripts/missing-images-driver.test.sh
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
base=$(mktemp -d "${TMPDIR:-$HOME/scratch/tmp}/missing-images-driver-test.XXXXXX")
trap 'rm -rf "$base"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

mkdir -p "$base/bin" "$base/repo/scripts" "$base/replica" "$base/tmp"
cp "$repo/scripts/missing-images-driver.sh" "$base/repo/scripts/"
cp "$repo/scripts/ingest-missing-product-images.py" "$base/repo/scripts/"

export STUB_LOG="$base/calls.log"
export STUB_SQL="$base/sql.log"
: >"$STUB_LOG"
: >"$STUB_SQL"
printf 'CLOUDFLARE_ZONE_ID=stub\n' >"$base/cloudflare.env"
printf '%s\n' 111 222 >"$base/list.txt"

# docker exec -i <container> psql ... -> the stub psql on PATH, SQL on stdin.
cat >"$base/bin/docker" <<'STUB'
#!/bin/sh
echo "docker $*" >>"$STUB_LOG"
if [ "${1:-}" = exec ]; then
  shift
  while [ "$#" -gt 0 ] && [ "$1" != psql ]; do shift; done
  [ "$#" -gt 0 ] || exit 0
  shift
  exec psql "$@"
fi
exit 0
STUB

cat >"$base/bin/psql" <<'STUB'
#!/bin/sh
sql=$(cat)
echo "psql" >>"$STUB_LOG"
printf '%s\n' "$sql" >>"$STUB_SQL"
case "$sql" in
  *information_schema.columns*)
    for pair in \
      cardtrader_pokemon_blueprints.id cardtrader_pokemon_blueprints.cdn_image_url \
      cardtrader_pokemon_blueprints.cdn_object_key cardtrader_pokemon_blueprints.homepage_image_url \
      cardtrader_pokemon_blueprints.homepage_object_key \
      marketplace_search_candidates.card_id marketplace_search_candidates.ct_id \
      marketplace_search_candidates.image_url marketplace_search_candidates.cdn_image_url \
      marketplace_search_candidates.preview_image_url marketplace_search_candidates.homepage_image_url \
      marketplace_cards.card_id marketplace_cards.ct_id marketplace_cards.image_url \
      marketplace_cards.cdn_image_url marketplace_cards.preview_image_url \
      marketplace_card_versions.card_id marketplace_card_versions.ct_id \
      marketplace_card_versions.image_url marketplace_card_versions.cdn_image_url \
      marketplace_card_versions.preview_image_url; do
      printf 'PREFOUND %s\n' "$pair"
    done
    exit 0
    ;;
esac
printf '%s\n' 'COUNT cardtrader_pokemon_blueprints 1'
printf '%s\n' 'COUNT marketplace_search_candidates 1'
printf '%s\n' 'COUNT marketplace_cards 1'
printf '%s\n' 'COUNT marketplace_card_versions 1'
case "$sql" in
  *'mode=apply'*)
    printf '%s\n' 'UNDO UPDATE public.cardtrader_pokemon_blueprints SET cdn_image_url=NULL, cdn_object_key=NULL, homepage_image_url=NULL, homepage_object_key=NULL WHERE id=111;'
    printf '%s\n' 'UNDO UPDATE public.marketplace_search_candidates SET image_url=NULL, cdn_image_url=NULL, preview_image_url=NULL, homepage_image_url=NULL WHERE card_id=222;'
    ;;
esac
exit 0
STUB

# The ingest: stage one accepted 400 px scan for the first id of the batch, leave
# the second id with nothing, and report it the way the real ingest does.
cat >"$base/bin/python3" <<'STUB'
#!/bin/sh
echo "python3 $*" >>"$STUB_LOG"
case "${1:-}" in
  -c) printf '%s\n' "${STUB_WIDTH:-400}"; exit 0 ;;
esac
case "$*" in
  *purge.py*)
    while read -r key; do
      [ -n "$key" ] || continue
      printf '200 {"success":true,"errors":null}\n'
    done <"$2"
    exit 0
    ;;
esac
if [ -n "${STUB_INGEST_NONE:-}" ]; then
  # Nothing usable for any id, the way the real ingest reports it.
  printf 'missing_rows=1 out=%s\n' "$POKOIN_PRODUCT_IMAGE_DIR"
  printf 'done saved=0 skip=0 fail=0\n'
  exit 1
fi
first=$(head -n 1 "$POKOIN_INGEST_ID_FILE")
mkdir -p "$POKOIN_PRODUCT_IMAGE_DIR"
printf 'stub jpeg bytes\n' >"$POKOIN_PRODUCT_IMAGE_DIR/${first}_abra.jpg"
printf 'stub webp bytes\n' >"$POKOIN_PRODUCT_IMAGE_DIR/${first}_abra_homepage.webp"
printf '%s_abra.jpg\n%s_abra_homepage.webp\n' "$first" "$first" >"$POKOIN_TMP_DIR/replaced-keys.txt"
printf '[%s]\n' "$first" >"$POKOIN_PLACEHOLDER_ID_FILE"
printf 'missing_rows=2 out=%s\n' "$POKOIN_PRODUCT_IMAGE_DIR"
printf 'done saved=1 skip=0 fail=0\n'
exit 0
STUB

cat >"$base/bin/ssh" <<'STUB'
#!/bin/sh
echo "ssh $*" >>"$STUB_LOG"
exit 0
STUB
cat >"$base/bin/rsync" <<'STUB'
#!/bin/sh
echo "rsync $*" >>"$STUB_LOG"
exit 0
STUB
cat >"$base/bin/curl" <<'STUB'
#!/bin/sh
echo "curl $*" >>"$STUB_LOG"
printf '200'
exit 0
STUB
cat >"$base/bin/identify" <<'STUB'
#!/bin/sh
printf '%s\n' "${STUB_WIDTH:-400}"
exit 0
STUB
cat >"$base/bin/sleep" <<'STUB'
#!/bin/sh
exit 0
STUB
cat >"$base/bin/hostname" <<'STUB'
#!/bin/sh
printf '%s\n' "${STUB_HOSTNAME:-nezopt}"
exit 0
STUB
# systemd-run --user --scope -p CPUQuota=200% nice -n 19 <cmd...> -> run <cmd>.
cat >"$base/bin/systemd-run" <<'STUB'
#!/bin/sh
echo "systemd-run $*" >>"$STUB_LOG"
while [ "$#" -gt 0 ] && [ "$1" != nice ]; do shift; done
while [ "$#" -gt 0 ] && [ "$1" != python3 ]; do shift; done
exec "$@"
STUB
chmod +x "$base/bin/"*
PATH="$base/bin:$PATH"
export PATH

new_r() { # $1 = case name -> a fresh scratch root with the driver's inputs
  mkdir -p "$base/R-$1"
  : >"$base/R-$1/purge.py"
  printf '%s\n' "$base/R-$1"
}

# run_driver <R> [VAR=value ...]: every external is stubbed, nothing real runs.
run_driver() {
  r="$1"
  shift
  env R="$r" WORKTREE="$base/repo" CF_ENV="$base/cloudflare.env" \
    REPLICA_OBJECTS="$base/replica" PI=stub-pi ORACLE=stub-oracle \
    TMPDIR="$base/tmp" LIST="$base/list.txt" "$@" \
    sh "$base/repo/scripts/missing-images-driver.sh" 2>&1
}

# 1. POSIX syntax of the driver and of this test.
sh -n "$repo/scripts/missing-images-driver.sh" || fail "sh -n failed on the driver"
sh -n "$repo/scripts/missing-images-driver.test.sh" || fail "sh -n failed on this test"

# 2. An id outside LIST refuses before any ingest, CDN or database call.
R2=$(new_r outside)
code=0
out=$(run_driver "$R2" IDS=999) || code=$?
[ "$code" -ne 0 ] || fail "an id outside LIST must refuse (exit=$code)"
case "$out" in
  *"not in LIST"*) ;;
  *) fail "no refusal message: $out" ;;
esac
if grep -Eq '^(docker|psql|python3|rsync|curl|systemd-run|ssh)( |$)' "$STUB_LOG"; then
  fail "the LIST guard ran something real: $(cat "$STUB_LOG")"
fi
if [ -d "$R2/missing-batches/0001" ]; then
  fail "the LIST guard opened a batch dir"
fi

# 3. STAMP=dry is the default: per-table WOULD-change counts, no UPDATE, no undo.
R3=$(new_r dry)
: >"$STUB_LOG"
: >"$STUB_SQL"
out=$(run_driver "$R3") || fail "dry run failed: $out"
case "$out" in
  *"stamp=dry"*) ;;
  *) fail "default STAMP is not dry: $out" ;;
esac
for table in cardtrader_pokemon_blueprints marketplace_search_candidates marketplace_cards marketplace_card_versions; do
  case "$out" in
    *"stamp=dry table=$table rows=1"*) ;;
    *) fail "no dry count for $table: $out" ;;
  esac
done
case "$out" in
  *"wrote nothing"*) ;;
  *) fail "dry run did not report that it wrote nothing: $out" ;;
esac
if grep -q 'UPDATE public' "$STUB_SQL"; then
  fail "dry mode sent an UPDATE to the database"
fi
if ! grep -q 'ROLLBACK;' "$STUB_SQL"; then
  fail "dry mode did not roll its transaction back"
fi
# Postgres wants ON COMMIT before AS: `CREATE TEMP TABLE x AS SELECT ... ON COMMIT
# DROP` is a syntax error, so the stamp pass must never emit that order.
if grep -Eq 'AS SELECT.*ON COMMIT' "$STUB_SQL"; then
  fail "ON COMMIT DROP after the query: $(grep -E 'AS SELECT.*ON COMMIT' "$STUB_SQL")"
fi
for temp_table in missing_stamped missing_touch_cand missing_touch_cards missing_touch_vers; do
  grep -q "CREATE TEMP TABLE $temp_table ON COMMIT DROP AS SELECT" "$STUB_SQL" ||
    fail "no ON COMMIT DROP before AS SELECT for $temp_table"
done
if [ -n "$(ls -A "$R3/missing-undo" 2>/dev/null)" ]; then
  fail "dry mode wrote an undo file: $(ls -A "$R3/missing-undo")"
fi
case "$out" in
  *"results replaced=1 skipped=0 failed=1"*) ;;
  *) fail "unexpected results split: $out" ;;
esac
case "$out" in
  *"verify keys=2 all=200"*) ;;
  *) fail "the staged keys were not verified: $out" ;;
esac
# stamp-keys.tsv pairs a main JPEG with its own WebP and lists only the main key.
webp_rows=$(awk -F'\t' '$2 ~ /_homepage\.webp$/ { n++ } END { print n + 0 }' \
  "$R3/missing-batches/0001/stamp-keys.tsv")
[ "$webp_rows" = 0 ] || fail "a homepage webp was stamped as the main image"
[ "$(wc -l <"$R3/missing-batches/0001/stamp-keys.tsv" | tr -d ' ')" = 1 ] ||
  fail "stamp-keys.tsv should hold exactly the one main key: $(cat "$R3/missing-batches/0001/stamp-keys.tsv")"
if [ -z "$(awk -F'\t' -v q=111 '$1 == q && $2 == "abra" && $3 == 400' "$R3/missing-under500.txt" 2>/dev/null)" ]; then
  fail "under-500 report missing: $(cat "$R3/missing-under500.txt" 2>/dev/null)"
fi
grep -qx 111 "$R3/missing-done-ids.txt" || fail "111 was not marked done"
grep -qx 222 "$R3/missing-done-ids.txt" || fail "222 was not marked done"
grep -q '111_abra.jpg' "$R3/missing-shipped.tsv" || fail "no shipped record for 111"

# 4. STAMP=apply off nezopt refuses before anything runs.
R4=$(new_r offhost)
: >"$STUB_LOG"
code=0
out=$(run_driver "$R4" STUB_HOSTNAME=pi-home STAMP=apply) || code=$?
[ "$code" -ne 0 ] || fail "STAMP=apply must refuse off nezopt"
case "$out" in
  *"only on nezopt"*) ;;
  *) fail "no host refusal message: $out" ;;
esac
if grep -Eq '^(docker|psql|python3|rsync|curl|systemd-run|ssh)( |$)' "$STUB_LOG"; then
  fail "the host gate ran something real: $(cat "$STUB_LOG")"
fi

# 5. STAMP=apply on nezopt prints its dry counts first, then one transaction that
#    UPDATEs, and saves the undo of exactly the rows it touched.
R5=$(new_r apply)
: >"$STUB_LOG"
: >"$STUB_SQL"
out=$(run_driver "$R5" STAMP=apply) || fail "apply run failed: $out"
case "$out" in
  *"stamp=dry table=cardtrader_pokemon_blueprints"*"stamp=apply table=cardtrader_pokemon_blueprints"*) ;;
  *) fail "apply did not follow its own dry counts: $out" ;;
esac
grep -q 'UPDATE public.cardtrader_pokemon_blueprints' "$STUB_SQL" ||
  fail "apply sent no blueprint UPDATE"
grep -q 'homepage_image_url=b.homepage_image_url' "$STUB_SQL" ||
  fail "apply did not overlay candidates homepage_image_url"
grep -q 'preview_image_url=coalesce(b.preview_image_url,b.cdn_image_url)' "$STUB_SQL" ||
  fail "apply did not set preview_image_url from the blueprint"
grep -q 'COMMIT;' "$STUB_SQL" || fail "apply did not commit"
grep -qF "cdn_image_url='https://cdn.pokoin.com/'||s.main_key" "$STUB_SQL" ||
  fail "the blueprint stamp did not build the CDN URL from the key"
# The overlay reads b.cdn_image_url, so the blueprints row must be stamped first.
bp_line=$(grep -n 'UPDATE public.cardtrader_pokemon_blueprints b SET' "$STUB_SQL" | head -n 1 | cut -d: -f1)
ov_line=$(grep -n 'UPDATE public.marketplace_search_candidates c SET' "$STUB_SQL" | head -n 1 | cut -d: -f1)
[ -n "$bp_line" ] && [ -n "$ov_line" ] && [ "$bp_line" -lt "$ov_line" ] ||
  fail "the overlay did not run after the blueprint stamp (bp=$bp_line overlay=$ov_line)"
undo=$(find "$R5/missing-undo" -type f -name '*.sql' | sort | head -n 1)
if [ -z "$undo" ]; then
  fail "apply wrote no undo file"
fi
grep -q 'WHERE id=111;' "$undo" || fail "undo file lacks the blueprint row"
grep -q 'WHERE card_id=222;' "$undo" || fail "undo file lacks the candidate row"
grep -q 'ON_ERROR_STOP=1 <' "$R5"/missing-batches/*/batch.log ||
  fail "batch log lacks the undo command line"
grep -q "nullif(b.cdn_image_url,'') IS NULL" "$STUB_SQL" ||
  fail "stamp did not restrict to empty cdn_image_url"

# 6. A malformed LIST line refuses the whole input instead of a partial run, and
#    an unusable STAMP or BATCH refuses before anything else happens.
R6=$(new_r badlist)
: >"$STUB_LOG"
printf '%s\n' 111 oops >"$base/list-bad.txt"
code=0
out=$(run_driver "$R6" LIST="$base/list-bad.txt") || code=$?
[ "$code" -ne 0 ] || fail "a malformed LIST line must refuse (exit=$code)"
case "$out" in
  *"not a positive ct_id"*) ;;
  *) fail "no malformed-LIST message: $out" ;;
esac
if grep -Eq '^(docker|psql|python3|rsync|curl|systemd-run|ssh)( |$)' "$STUB_LOG"; then
  fail "the LIST parser ran something real: $(cat "$STUB_LOG")"
fi
code=0
out=$(run_driver "$R6" STAMP=maybe) || code=$?
[ "$code" -ne 0 ] || fail "STAMP=maybe must refuse"
case "$out" in *"STAMP must be dry or apply"*) ;; *) fail "no STAMP message: $out" ;; esac

# 7. A replica object that is only the CardTrader placeholder is never stamped,
#    even when the CDN serves it.
R7=$(new_r placeholder)
: >"$STUB_LOG"
: >"$STUB_SQL"
printf '%s\n' 333 >"$base/list-one.txt"
printf 'stub bytes\n' >"$base/replica/333_logo.jpg"
printf 'stub bytes\n' >"$base/replica/333_logo_homepage.webp"
out=$(run_driver "$R7" LIST="$base/list-one.txt" STAMP=apply STUB_INGEST_NONE=1 STUB_WIDTH=186) ||
  fail "a placeholder-only batch must still finish: $out"
if [ -z "$(awk -F'\t' -v q=333 '$1 == q && $2 == "failed" && $3 == "placeholder_object"' \
  "$R7/missing-batches/0001/results.tsv" 2>/dev/null)" ]; then
  fail "placeholder not reported: $(cat "$R7/missing-batches/0001/results.tsv")"
fi
if [ -s "$R7/missing-batches/0001/stamp-keys.tsv" ]; then
  fail "a placeholder object was stamp-keyed: $(cat "$R7/missing-batches/0001/stamp-keys.tsv")"
fi
if grep -q 'UPDATE public' "$STUB_SQL"; then
  fail "a placeholder object reached the database"
fi
grep -qx 333 "$R7/missing-done-ids.txt" || fail "the placeholder id was not marked done"

# 8. The same object at a usable width is adopted and stamped as-is, so an image
#    that is already live but whose rows are empty gets fixed without a fetch.
R8=$(new_r adopt)
: >"$STUB_SQL"
out=$(run_driver "$R8" LIST="$base/list-one.txt" STAMP=apply STUB_INGEST_NONE=1 STUB_WIDTH=700) ||
  fail "adoption of a real replica object failed: $out"
if [ -z "$(awk -F'\t' -v q=333 '$1 == q && $2 == "skipped" && $3 == "already_shipped" && $4 == 700' \
  "$R8/missing-batches/0001/results.tsv" 2>/dev/null)" ]; then
  fail "real replica object not adopted: $(cat "$R8/missing-batches/0001/results.tsv")"
fi
grep -q '333_logo.jpg' "$R8/missing-batches/0001/stamp-keys.tsv" ||
  fail "real replica object not stamp-keyed: $(cat "$R8/missing-batches/0001/stamp-keys.tsv")"
grep -qF "'333_logo.jpg'" "$STUB_SQL" ||
  fail "the adopted key never reached the stamp SQL"
if grep -q '111_abra' "$STUB_SQL"; then
  fail "the stamp reached a key outside the batch"
fi

printf 'missing-images-driver: ok\n'
