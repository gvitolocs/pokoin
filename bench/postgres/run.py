#!/usr/bin/env python3
"""Benchmark two Postgres servers holding the same marketplace data.

Runs each workload on both servers in alternating order (A,B then B,A ...) so
drift on a shared host does not favour one side, and reports the median of the
rounds with min/max. pgbench workloads report throughput and per-transaction
latency percentiles from pgbench's own transaction log; batch jobs (the
nightly sold-daily rebuild, index build, vacuum, analytics) report seconds.

  bench/postgres/run.py --pgbench /path/to/pgbench --psql /path/to/psql \
      --server 17=host=/sock,port=54317 --server 19=host=/sock,port=54319 \
      --rounds 3 --seconds 30 --out bench/postgres/results/2026-10-12.json

Every server needs the same data: load-schema.sh + seed.sql on the old one,
then pg_upgrade (or a second seed) for the new one. The script creates and
initialises a `pgbench` database on each server for the TPC-B workloads.
"""
import argparse, glob, json, os, re, shutil, statistics, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
WORKLOADS = [  # name, pgbench args, database, kind
    ("card_desk", ["-f", "workloads/card_desk.sql"], "pokoin_marketplace", "read"),
    ("search", ["-f", "workloads/search.sql"], "pokoin_marketplace", "read"),
    ("set_page", ["-f", "workloads/set_page.sql"], "pokoin_marketplace", "read"),
    ("listing_writes", ["-f", "workloads/listing_writes.sql"], "pokoin_marketplace", "write"),
    ("book_upsert", ["-f", "workloads/book_upsert.sql"], "pokoin_marketplace", "write"),
    ("tpcb", ["-b", "tpcb-like"], "pgbench", "write"),
    ("select_only", ["-b", "select-only"], "pgbench", "read"),
]
BATCH = [  # name, sql (timed as one statement)
    ("sold_daily_rebuild", "select public.refresh_cardtrader_sold_daily(null)"),
    ("observations_analytics",
     "select blueprint_id, count(*), percentile_cont(0.5) within group (order by price_pkn) "
     "from marketplace_price_observations group by blueprint_id order by 2 desc limit 100"),
    ("book_create_index",
     "create index bench_book_price_idx on cardtrader_market_listing_snapshots (price, last_seen_at); "
     "drop index bench_book_price_idx"),
    ("book_vacuum_analyze", "vacuum (analyze) cardtrader_market_listing_snapshots"),
]


def conninfo(spec, db):
    return " ".join(spec.split(",")) + f" user=pokoin_marketplace dbname={db}"


def psql(args, spec, db, sql):
    started = time.monotonic()
    subprocess.run([args.psql, conninfo(spec, db), "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
                   check=True, stdout=subprocess.DEVNULL)
    return time.monotonic() - started


def percentile(sorted_values, q):
    if not sorted_values:
        return None
    index = min(len(sorted_values) - 1, max(0, round(q * (len(sorted_values) - 1))))
    return sorted_values[index]


def pgbench(args, spec, db, extra, seconds, log_dir=None):
    cmd = [args.pgbench, "-n", "-c", str(args.clients), "-j", str(args.threads), "-T", str(seconds), *extra]
    if log_dir:
        cmd += ["-l", "--log-prefix", os.path.join(log_dir, "tx")]
    cmd.append(conninfo(spec, db))
    out = subprocess.run(cmd, cwd=HERE, check=True, capture_output=True, text=True).stdout
    tps = float(re.search(r"tps = ([\d.]+)", out).group(1))
    failed = int(re.search(r"number of failed transactions: (\d+)", out).group(1)) if "failed transactions" in out else 0
    latencies = []
    if log_dir:
        for path in glob.glob(os.path.join(log_dir, "tx*")):
            with open(path) as handle:
                latencies += [int(line.split()[2]) for line in handle if line.strip()]
            os.unlink(path)
        latencies.sort()
    return {"tps": tps, "failed": failed,
            "p50_ms": percentile(latencies, 0.50) / 1000 if latencies else None,
            "p95_ms": percentile(latencies, 0.95) / 1000 if latencies else None,
            "p99_ms": percentile(latencies, 0.99) / 1000 if latencies else None}


def summary(values):
    values = [v for v in values if v is not None]
    return {"median": statistics.median(values), "min": min(values), "max": max(values)} if values else None


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--pgbench", required=True)
    parser.add_argument("--psql", required=True)
    parser.add_argument("--server", action="append", required=True, help="label=libpq,kv,pairs (exactly two)")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--seconds", type=int, default=30)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--clients", type=int, default=8)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--tpcb-scale", type=int, default=50)
    parser.add_argument("--only", help="comma-separated workload/batch names")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    servers = [tuple(s.split("=", 1)) for s in args.server]
    if len(servers) != 2:
        sys.exit("give exactly two --server")
    only = set(args.only.split(",")) if args.only else None
    results = {"meta": {"started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "rounds": args.rounds,
                        "seconds": args.seconds, "clients": args.clients, "threads": args.threads,
                        "tpcb_scale": args.tpcb_scale, "cpus": os.cpu_count(), "servers": {}},
               "pgbench": {}, "batch": {}}
    for label, spec in servers:
        version = subprocess.run([args.psql, conninfo(spec, "postgres"), "-XAtc", "show server_version"],
                                 check=True, capture_output=True, text=True).stdout.strip()
        results["meta"]["servers"][label] = version
        exists = subprocess.run([args.psql, conninfo(spec, "postgres"), "-XAtc",
                                 "select 1 from pg_database where datname = 'pgbench'"],
                                capture_output=True, text=True).stdout.strip()
        if not exists and (not only or only & {"tpcb", "select_only"}):
            psql(args, spec, "postgres", "create database pgbench")
            subprocess.run([args.pgbench, "-i", "-q", "-s", str(args.tpcb_scale), conninfo(spec, "pgbench")],
                           check=True, capture_output=True)
        print(f"{label}: {version}", flush=True)

    def order(round_no):
        return servers if round_no % 2 == 0 else list(reversed(servers))

    for name, sql in BATCH:
        if only and name not in only:
            continue
        runs = {label: [] for label, _ in servers}
        for round_no in range(args.rounds):
            for label, spec in order(round_no):
                runs[label].append(psql(args, spec, "pokoin_marketplace", sql))
                print(f"batch {name} {label} round {round_no + 1}: {runs[label][-1]:.2f}s", flush=True)
        results["batch"][name] = {label: {"seconds": summary(v), "runs": v} for label, v in runs.items()}

    for name, extra, db, kind in WORKLOADS:
        if only and name not in only:
            continue
        runs = {label: [] for label, _ in servers}
        for round_no in range(args.rounds):
            for label, spec in order(round_no):
                pgbench(args, spec, db, extra, args.warmup)
                with tempfile.TemporaryDirectory() as log_dir:
                    run = pgbench(args, spec, db, extra, args.seconds, log_dir)
                runs[label].append(run)
                print(f"{name} {label} round {round_no + 1}: {run['tps']:.0f} tps, p95 {run['p95_ms']:.2f} ms", flush=True)
        results["pgbench"][name] = {
            "kind": kind,
            **{label: {key: summary([r[key] for r in v]) for key in ("tps", "p50_ms", "p95_ms", "p99_ms")}
               | {"failed": sum(r["failed"] for r in v), "runs": v} for label, v in runs.items()}}

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as handle:
        json.dump(results, handle, indent=1)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
