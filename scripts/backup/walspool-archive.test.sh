#!/usr/bin/env bash
# Tests scripts/backup/walspool-archive.sh with the host's sh. Run: bash scripts/backup/walspool-archive.test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/walspool-archive.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export POKOIN_WAL_SPOOL="$tmp/spool"
mkdir -p "$POKOIN_WAL_SPOOL" "$tmp/pg_wal"
fail() { echo "FAIL: $*" >&2; exit 1; }

seg=0000000100000095000000AC
head -c 65536 /dev/urandom >"$tmp/pg_wal/$seg"
sh "$script" "$tmp/pg_wal/$seg" "$seg" || fail "first archive"
cmp -s "$tmp/pg_wal/$seg" "$POKOIN_WAL_SPOOL/$seg" || fail "copy differs"
[ -z "$(find "$POKOIN_WAL_SPOOL" -name '.*.part')" ] || fail "temp file left"

sh "$script" "$tmp/pg_wal/$seg" "$seg" || fail "identical re-archive must succeed"

head -c 65536 /dev/urandom >"$tmp/other"
if sh "$script" "$tmp/other" "$seg" 2>/dev/null; then fail "different content must fail"; fi

seg2=0000000100000095000000AD
head -c 65536 /dev/urandom >"$tmp/pg_wal/$seg2"
if POKOIN_WAL_SPOOL_MAX_KB=1 sh "$script" "$tmp/pg_wal/$seg2" "$seg2" 2>/dev/null; then fail "full spool must fail"; fi
[ ! -e "$POKOIN_WAL_SPOOL/$seg2" ] || fail "full spool must not copy"

if sh "$script" "$tmp/pg_wal/$seg2" "../x" 2>/dev/null; then fail "path in name must fail"; fi
if sh "$script" "$tmp/missing" "$seg2" 2>/dev/null; then fail "missing source must fail"; fi
[ ! -e "$POKOIN_WAL_SPOOL/$seg2" ] || fail "failed copy must not appear"
echo "walspool-archive: ok"
