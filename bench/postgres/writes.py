#!/usr/bin/env python3
"""Write benchmark from an identical starting state on every run.

Each measured run starts from the same database: `pokoin_write` is recreated
from the template `pokoin_tpl` (one pg_dump of the reference server, restored
into every server with that server's own pg_restore), checkpointed, and the
tables the workload touches are prewarmed. The workload is a fixed number of
transactions with a fixed pgbench random seed, so every server does the same
work and the costs compare directly:

  latency p50/p95/p99 and throughput   (pgbench transaction log)
  WAL bytes                            (pg_current_wal_lsn before/after)
  dead tuples, autovacuum runs         (pg_stat_user_tables of the touched tables)
  table and index growth               (pg_relation_size)
  server CPU                           (verify.py: postmaster + backends from /proc)
  checkpoints and buffers written      (pg_stat_checkpointer)

and the end state must agree between servers (same counts and sums), which
shows the same work committed with nothing lost.

  bench/postgres/writes.py --setup  --server 17=host=..,port=..,data=..,bin=.. --server 19=...
  bench/postgres/writes.py --rounds 3 --server ... --out results/<date>-writes.json
"""
import argparse, glob, json, os, re, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from verify import cluster_cpu_seconds, parse_server  # noqa: E402

WORKLOADS = {
    "listing_writes": {
        "script": "workloads/listing_writes.sql", "per_client": 2000,
        "tables": ["marketplace_user_listings", "marketplace_user_listing_events", "marketplace_listing_stats_daily"],
        "invariants": {
            "bench_listings": "select count(*) || ' ' || sum(price_pkn) from marketplace_user_listings where seller_uid = 'bench'",
            "events": "select string_agg(event_type || '=' || n, ' ' order by event_type) from "
                      "(select event_type, count(*) n from marketplace_user_listing_events where seller_uid = 'bench' group by 1) e",
            "daily_stats": "select count(*) || ' ' || sum(listed_count) || ' ' || sum(listed_quantity) || ' ' || sum(new_listings) "
                           "|| ' ' || sum(new_quantity) from marketplace_listing_stats_daily",
        },
    },
    "book_upsert": {
        "script": "workloads/book_upsert.sql", "per_client": 25000,
        "tables": ["cardtrader_market_listing_snapshots"],
        "invariants": {
            "book": "select count(*) || ' ' || md5(string_agg(external_listing_id || ':' || quantity || ':' || price, ',' "
                    "order by external_listing_id)) from cardtrader_market_listing_snapshots",
        },
    },
}


def conninfo(parts, db):
    return f"host={parts['host']} port={parts['port']} user=pokoin_marketplace dbname={db}"


def env_for(parts):
    lib = os.path.join(os.path.dirname(parts["bin"]), "lib")
    return {**os.environ, "LD_LIBRARY_PATH": lib}


def psql(parts, db, sql):
    return subprocess.run([os.path.join(parts["bin"], "psql"), conninfo(parts, db), "-XAtq", "-v", "ON_ERROR_STOP=1",
                           "-c", sql], check=True, capture_output=True, text=True, env=env_for(parts)).stdout.strip()


def setup(servers, source_db, dump_dir):
    ref_label, ref = servers[0]
    subprocess.run(["rm", "-rf", dump_dir], check=True)
    subprocess.run([os.path.join(ref["bin"], "pg_dump"), "-Fd", "-j4", "-f", dump_dir, conninfo(ref, source_db)],
                   check=True, env=env_for(ref))
    for label, parts in servers:
        psql(parts, "postgres", "drop database if exists pokoin_write with (force)")
        if psql(parts, "postgres", "select 1 from pg_database where datname = 'pokoin_tpl'"):
            psql(parts, "postgres", "alter database pokoin_tpl is_template false")
        psql(parts, "postgres", "drop database if exists pokoin_tpl with (force)")
        psql(parts, "postgres", "create database pokoin_tpl")
        restore = subprocess.run([os.path.join(parts["bin"], "pg_restore"), "-j4", "--no-owner", "-d",
                                  conninfo(parts, "pokoin_tpl"), dump_dir], env=env_for(parts), capture_output=True, text=True)
        if restore.returncode != 0:
            errors = [line for line in restore.stderr.splitlines() if "error" in line.lower()]
            raise SystemExit(f"{label}: pg_restore failed:\n  " + "\n  ".join(errors[:20]))
        psql(parts, "pokoin_tpl", "create extension if not exists pg_prewarm")
        psql(parts, "pokoin_tpl", "vacuum analyze")
        psql(parts, "postgres", "alter database pokoin_tpl is_template true")
        print(f"{label}: pokoin_tpl restored from {ref_label}'s {source_db}", flush=True)


def stats(parts, tables):
    names = ",".join(f"'{t}'" for t in tables)
    row = psql(parts, "pokoin_write", f"""
      select pg_current_wal_lsn(),
             (select coalesce(sum(n_dead_tup), 0) from pg_stat_user_tables where relname in ({names})),
             (select coalesce(sum(autovacuum_count + autoanalyze_count), 0) from pg_stat_user_tables where relname in ({names})),
             (select coalesce(sum(pg_relation_size(c.oid)), 0) from pg_class c where c.relname in ({names})),
             (select coalesce(sum(pg_relation_size(i.indexrelid)), 0) from pg_index i join pg_class c on c.oid = i.indrelid
               where c.relname in ({names})),
             (select num_timed + num_requested from pg_stat_checkpointer),
             (select buffers_written from pg_stat_checkpointer)""")
    lsn, dead, av, table_bytes, index_bytes, checkpoints, buffers = row.split("|")
    return {"lsn": lsn, "dead": int(dead), "autovacuum": int(av), "table_bytes": int(table_bytes),
            "index_bytes": int(index_bytes), "checkpoints": int(checkpoints), "ckpt_buffers": int(buffers)}


def percentile(values, q):
    return values[min(len(values) - 1, round(q * (len(values) - 1)))] / 1000 if values else None


def one_run(args, parts, name, spec):
    psql(parts, "postgres", "drop database if exists pokoin_write with (force)")
    psql(parts, "postgres", "create database pokoin_write template pokoin_tpl strategy file_copy")
    psql(parts, "pokoin_write", "checkpoint")
    names = ",".join(f"'{t}'" for t in spec["tables"])
    psql(parts, "pokoin_write", f"select sum(pg_prewarm(c.oid)) from pg_class c where c.relname in ({names}) "
                                f"or c.oid in (select indexrelid from pg_index i join pg_class t on t.oid = i.indrelid "
                                f"where t.relname in ({names}))")
    time.sleep(1.5)
    before = stats(parts, spec["tables"])
    cpu_before = cluster_cpu_seconds(parts["data"])
    with tempfile.TemporaryDirectory() as logs:
        started = time.monotonic()
        out = subprocess.run([args.pgbench, "-n", "-c", str(args.clients), "-j", str(args.threads), "-t", str(spec["per_client"]),
                              "--random-seed", str(args.seed), "-l", "--log-prefix", os.path.join(logs, "tx"),
                              "-f", spec["script"], conninfo(parts, "pokoin_write")],
                             cwd=HERE, check=True, capture_output=True, text=True).stdout
        elapsed = time.monotonic() - started
        latencies = sorted(int(line.split()[2]) for path in glob.glob(os.path.join(logs, "tx*"))
                           for line in open(path) if line.strip())
    time.sleep(1.5)  # backends reaped, statistics flushed
    cpu = cluster_cpu_seconds(parts["data"]) - cpu_before
    after = stats(parts, spec["tables"])
    wal = int(psql(parts, "pokoin_write", f"select pg_wal_lsn_diff('{after['lsn']}', '{before['lsn']}')::bigint"))
    tx = int(re.search(r"number of transactions actually processed: (\d+)", out).group(1))
    failed = int(re.search(r"number of failed transactions: (\d+)", out).group(1)) if "failed transactions" in out else 0
    invariants = {key: psql(parts, "pokoin_write", sql) for key, sql in spec["invariants"].items()}
    return {"transactions": tx, "failed": failed, "elapsed_s": round(elapsed, 3), "tps": round(tx / elapsed, 1),
            "p50_ms": percentile(latencies, 0.5), "p95_ms": percentile(latencies, 0.95), "p99_ms": percentile(latencies, 0.99),
            "wal_mb": round(wal / 2**20, 1), "wal_bytes_per_tx": round(wal / max(tx, 1)),
            "dead_tuples_after": after["dead"], "autovacuum_runs": after["autovacuum"] - before["autovacuum"],
            "table_growth_mb": round((after["table_bytes"] - before["table_bytes"]) / 2**20, 2),
            "index_growth_mb": round((after["index_bytes"] - before["index_bytes"]) / 2**20, 2),
            "server_cpu_s": round(cpu, 2), "cpu_ms_per_tx": round(cpu * 1000 / max(tx, 1), 4),
            "checkpoints": after["checkpoints"] - before["checkpoints"],
            "checkpoint_buffers": after["ckpt_buffers"] - before["ckpt_buffers"], "invariants": invariants}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--server", action="append", required=True, help="label=host=..,port=..,data=..,bin=..")
    parser.add_argument("--pgbench")
    parser.add_argument("--setup", action="store_true", help="dump the first server's database into pokoin_tpl everywhere")
    parser.add_argument("--source-db", default="pokoin_marketplace")
    parser.add_argument("--dump-dir", default="/tmp/pokoin-bench-dump")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--clients", type=int, default=8)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--only", help="comma-separated workloads")
    parser.add_argument("--out")
    args = parser.parse_args()
    servers = [parse_server(s) for s in args.server]
    if args.setup:
        setup(servers, args.source_db, args.dump_dir)
        return
    results = {"meta": {"started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "rounds": args.rounds,
                        "clients": args.clients, "threads": args.threads, "seed": args.seed,
                        "servers": {label: psql(parts, "postgres", "show server_version") for label, parts in servers}},
               "workloads": {}}
    for name, spec in WORKLOADS.items():
        if args.only and name not in args.only.split(","):
            continue
        runs = {label: [] for label, _ in servers}
        for round_no in range(args.rounds):
            for label, parts in (servers if round_no % 2 == 0 else list(reversed(servers))):
                run = one_run(args, parts, name, spec)
                runs[label].append(run)
                print(f"{name} {label} round {round_no + 1}: {run['tps']} tps, p95 {run['p95_ms']} ms, "
                      f"WAL {run['wal_mb']} MB, CPU {run['cpu_ms_per_tx']} ms/tx, {run['invariants']}", flush=True)
        signatures = {json.dumps(r["invariants"], sort_keys=True) for side in runs.values() for r in side}
        results["workloads"][name] = {"runs": runs, "same_end_state_everywhere": len(signatures) == 1,
                                      "end_states": sorted(signatures)}
        print(f"{name}: end state identical on every run and server: {len(signatures) == 1}", flush=True)
    with open(args.out, "w") as handle:
        json.dump(results, handle, indent=1)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
