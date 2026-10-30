#!/usr/bin/env bash
# The full comparison after the main run.py pass, unattended, in order:
#   1. verify.py on the production-like settings (outputs, CPU per tx, peak PSS, settings diff)
#   2. writes.py: template from the old server, then writes from identical snapshots
#   3. reset pokoin_marketplace on both servers to that same template
#   4. default vs default: stock settings on both, Pokoin reads and batch jobs
#   5. control: the new server with io_method=sync against the old one, production-like settings
#   6. the same control for the writes: writes.py from identical snapshots, and pgbench TPC-B
#   7. back to production-like settings on both
# Every configuration's relevant settings are saved next to its results.
#
# Disk: the template and the per-run copy add about 2 x the database per
# server, so the generic pgbench database and pokoin_marketplace are dropped
# while they are not needed (step 3 recreates pokoin_marketplace).
#
#   bench/postgres/sequence.sh <work dir with data17/ data19/ run sockets> <inst17> <inst19> <results dir> <date tag> [first step]
set -euo pipefail
W=${1:?work dir} I17=${2:?inst17} I19=${3:?inst19} R=${4:?results dir} TAG=${5:?date tag} FROM=${6:-1}
HERE=$(cd "$(dirname "$0")" && pwd)
export LD_LIBRARY_PATH=$I19/lib
PSQL=$I19/bin/psql PGBENCH=$I19/bin/pgbench
S17="17=host=$W,port=54317,data=$W/data17,bin=$I17/bin"
S19="19=host=$W,port=54319,data=$W/data19,bin=$I19/bin"
RUN17="17=host=$W,port=54317" RUN19="19=host=$W,port=54319"
READS=card_desk,search,set_page,sold_daily_rebuild,observations_analytics,book_create_index,book_vacuum_analyze
say() { echo "== $(date -u +%H:%M:%S) $*"; }

restart() {  # restart <label> <inst>
  su pgrun -c "LD_LIBRARY_PATH=$2/lib $2/bin/pg_ctl -D $W/data$1 -l $W/pg$1.log -m fast -w restart" >/dev/null
}
settings() {  # settings <out.json>
  {
    echo "{"
    for port in 54317 54319; do
      "$PSQL" "host=$W port=$port user=pokoin_marketplace dbname=postgres" -XAtc "select '\"' || current_setting('server_version') || '\": ' || json_object_agg(name, current_setting(name))::text from pg_settings where name in ('io_method','io_workers','io_combine_limit','io_max_combine_limit','effective_io_concurrency','maintenance_io_concurrency','shared_buffers','work_mem','maintenance_work_mem','effective_cache_size','max_wal_size','checkpoint_timeout','jit','max_parallel_workers_per_gather','random_page_cost','wal_buffers','autovacuum_worker_slots','data_checksums')"
      [[ $port == 54317 ]] && echo ","
    done
    echo "}"
  } >"$1"
}

on_both() { for port in 54317 54319; do "$PSQL" "host=$W port=$port user=pokoin_marketplace dbname=postgres" -Xq "$@"; done; }

if (( FROM <= 1 )); then
  say "1. verify (production-like settings)"
  settings "$R/$TAG-settings-production-like.json"
  python3 "$HERE/verify.py" --pgbench "$PGBENCH" --psql "$PSQL" --server "$S17" --server "$S19" --out "$R/$TAG-verify.json"
fi

if (( FROM <= 2 )); then
  say "2. writes from identical snapshots"
  on_both -c "drop database if exists pgbench with (force)"
  python3 "$HERE/writes.py" --setup --server "$S17" --server "$S19" --dump-dir "$W/dump"
  on_both -c "drop database if exists pokoin_marketplace with (force)" -c "checkpoint"
  python3 "$HERE/writes.py" --pgbench "$PGBENCH" --server "$S17" --server "$S19" --rounds 3 --out "$R/$TAG-writes.json"
  on_both -c "drop database if exists pokoin_write with (force)"
fi

say "3. reset pokoin_marketplace to the same snapshot on both servers"
on_both -c "drop database if exists pokoin_marketplace with (force)" \
  -c "create database pokoin_marketplace template pokoin_tpl strategy file_copy"

use_conf() {  # use_conf <17 conf> <19 conf> [extra line for 19]
  for v in 17 19; do
    [[ -f $W/data$v/postgresql.bench.conf.production ]] \
      || cp "$W/data$v/postgresql.bench.conf" "$W/data$v/postgresql.bench.conf.production"
  done
  cp "$1" "$W/data17/postgresql.bench.conf"
  cp "$2" "$W/data19/postgresql.bench.conf"
  [[ -z ${3:-} ]] || echo "$3" >>"$W/data19/postgresql.bench.conf"
  restart 17 "$I17"; restart 19 "$I19"
}
PROD17=$W/data17/postgresql.bench.conf.production PROD19=$W/data19/postgresql.bench.conf.production
[[ -f $PROD17 ]] || cp "$W/data17/postgresql.bench.conf" "$PROD17"
[[ -f $PROD19 ]] || cp "$W/data19/postgresql.bench.conf" "$PROD19"

if (( FROM <= 4 )); then
  say "4. default vs default"
  use_conf "$HERE/postgresql.default.conf" "$HERE/postgresql.default.conf"
  settings "$R/$TAG-settings-default.json"
  python3 "$HERE/run.py" --pgbench "$PGBENCH" --psql "$PSQL" --server "$RUN17" --server "$RUN19" \
    --only "$READS" --rounds 3 --seconds 30 --warmup 5 --out "$R/$TAG-default.json"
fi

if (( FROM <= 5 )); then
  say "5. control: 19 with io_method=sync, production-like settings"
  use_conf "$PROD17" "$PROD19" "io_method = sync"
  settings "$R/$TAG-settings-19-io-sync.json"
  python3 "$HERE/run.py" --pgbench "$PGBENCH" --psql "$PSQL" --server "$RUN17" --server "$RUN19" \
    --only "$READS" --rounds 3 --seconds 30 --warmup 5 --out "$R/$TAG-19-io-sync.json"
fi

if (( FROM <= 6 )); then
  say "6. control for the writes: 19 with io_method=sync"
  use_conf "$PROD17" "$PROD19" "io_method = sync"
  python3 "$HERE/writes.py" --pgbench "$PGBENCH" --server "$S17" --server "$S19" --rounds 3 \
    --out "$R/$TAG-writes-19-io-sync.json"
  on_both -c "drop database if exists pokoin_write with (force)"
  python3 "$HERE/run.py" --pgbench "$PGBENCH" --psql "$PSQL" --server "$RUN17" --server "$RUN19" \
    --only tpcb --rounds 3 --seconds 30 --warmup 5 --out "$R/$TAG-tpcb-19-io-sync.json"
  on_both -c "drop database if exists pgbench with (force)"
fi

say "7. back to production-like settings"
use_conf "$PROD17" "$PROD19"
settings "$R/$TAG-settings-production-like.json"
say "done"
