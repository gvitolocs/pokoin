#!/usr/bin/env bash
# End-to-end: dump → zstd → age → logical restore test, against a throwaway Postgres
# container (never a production database). Needs docker, zstd and a built pokoin-ops.
#   bash tools/pokoin-ops/tests/e2e-backup.sh [path/to/pokoin-ops]
set -euo pipefail
bin="${1:-$HOME/pokoin-deploy/target-ops/release/pokoin-ops}"
image="${POKOIN_RESTORE_IMAGE:-postgres:17.11-alpine}"
src=pokoin-ops-e2e-src
tmp="$(mktemp -d)"
cleanup() {
  docker rm -f "$src" >/dev/null 2>&1 || true
  docker run --rm --network none -v "$tmp:/w" "$image" sh -c 'rm -rf /w/*' >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

docker rm -f "$src" >/dev/null 2>&1 || true
docker run -d --name "$src" --network none -e POSTGRES_USER=pokoin_marketplace \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$image" >/dev/null
for _ in $(seq 60); do
  docker logs "$src" 2>&1 | grep -q 'init process complete' && docker exec "$src" pg_isready -q -U pokoin_marketplace && break
  sleep 1
done
psql() { docker exec -i "$src" psql -X -q -v ON_ERROR_STOP=1 -U pokoin_marketplace "$@"; }
psql -d postgres -c "create database pokoin_magic"
psql -d pokoin_marketplace <<'SQL'
create extension pg_trgm;
create role pokoin_scan_language login;
create table cards (id bigint primary key, name text, note text);
insert into cards select g, 'card ' || g, case when g % 7 = 0 then E'two\nlines' end from generate_series(1, 25000) g;
create index cards_name_trgm on cards using gin (name gin_trgm_ops);
create schema "Odd Schema";
create table "Odd Schema"."it's ""quoted""" (v text);
insert into "Odd Schema"."it's ""quoted""" values ('a'), (E'tab\there');
create table empty_table (x int);
grant select on cards to pokoin_scan_language;
SQL
psql -d pokoin_magic -c "create table m (id int); insert into m select generate_series(1, 1234);"

export HOME="$tmp/home" POKOIN_OPS_DRY_RUN=1 POKOIN_OPS_STATE_DIR="$tmp/state"
export POKOIN_BACKUP_DIR="$tmp/backups" POKOIN_BACKUP_EXEC="docker exec -i $src"
export POKOIN_BACKUP_MIN_FREE_GB=1 POKOIN_BACKUP_RETRIES=1 POKOIN_RESTORE_MEMORY=1g POKOIN_BACKUP_KIND=weekly
mkdir -p "$HOME"
"$bin" backup keygen >/dev/null

# Backups never touch a primary.
if "$bin" backup dump 2>"$tmp/refuse.log"; then fail "dump of a primary must be refused"; fi
grep -q 'not a standby' "$tmp/refuse.log" || fail "refusal message: $(cat "$tmp/refuse.log")"

POKOIN_BACKUP_ALLOW_PRIMARY=1 "$bin" backup dump
set_dir="$(find "$POKOIN_BACKUP_DIR/dumps" -mindepth 1 -maxdepth 1 -name '2*Z')"
[[ -f "$set_dir/MANIFEST.json" ]] || fail "no manifest"
for f in globals.sql.zst.age pokoin_marketplace.dump.zst.age pokoin_magic.dump.zst.age postgres.dump.zst.age; do
  [[ -s "$set_dir/$f" ]] || fail "missing $f"
done
if zstd -t "$set_dir/pokoin_magic.dump.zst.age" 2>/dev/null; then fail "file is not encrypted"; fi

"$bin" backup verify 2>&1 | tee "$tmp/verify.log"
grep -q 'PASSED' "$tmp/verify.log" || fail "verify did not pass"
grep -qE 'pokoin_marketplace +[0-9]+ tables +25002 rows' "$tmp/verify.log" || fail "row total for pokoin_marketplace"
grep -qE 'pokoin_magic +1 tables +1234 rows' "$tmp/verify.log" || fail "row total for pokoin_magic"
[[ -z "$(docker ps -aq -f name=pokoin-restore-test-)" ]] || fail "restore container left behind"

# A tampered file fails the checksum before anything is restored.
printf 'x' >>"$set_dir/pokoin_magic.dump.zst.age"
if "$bin" backup verify >/dev/null 2>&1; then fail "tampered set must fail"; fi

"$bin" backup prune --dry-run | grep -q '1 sets kept' || fail "prune"
echo "e2e-backup: ok"
