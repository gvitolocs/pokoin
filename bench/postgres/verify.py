#!/usr/bin/env python3
"""Second pass for the version benchmark: what run.py does not measure.

1. settings  - every setting whose value differs between the two servers
2. outputs   - the Pokoin queries with fixed inputs, the nightly sold-daily
               rebuild and the price analytics: one md5 per query and input,
               compared between servers (ORDER BY gains tie-breakers, so a
               match means the same rows in the same order)
3. resources - each workload again, alone on one server at a time: server
               CPU seconds per 1,000 transactions (utime + stime of the
               postmaster and every backend, from /proc) and peak memory
               (sum of PSS over those processes, sampled every 0.25 s, so
               shared_buffers is counted once, not once per backend)

Needs to read /proc of the server processes (run as root or as their owner).

  bench/postgres/verify.py --pgbench .../pgbench --psql .../psql \
      --server 17=host=/sock,port=54317,data=/path/data17 \
      --server 19=host=/sock,port=54319,data=/path/data19 \
      --out bench/postgres/results/<date>-verify.json
"""
import argparse, json, os, re, subprocess, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
TICK = os.sysconf("SC_CLK_TCK")
SAMPLE_N = list(range(1, 70728, 353))  # 201 printings across the catalogue

# Correctness queries, one row set per input n; every ORDER BY ends in a unique key.
OUTPUTS = {
    "card_printing": "select card_id, name, set_name, card_number, rarity from marketplace_search_candidates where card_id = 2 * (100000 + {n})",
    "card_listings": "select id, price_pkn, condition, language, quantity_available from marketplace_user_listings "
                     "where card_id = (2 * (100000 + {n}))::text and status = 'active' and seller_uid <> 'bench' "
                     "order by price_pkn, id limit 50",
    "card_sold_graph": "select observed_day, condition, language, reverse, first_edition, graded, median_pkn, min_pkn, max_pkn, sold_qty, listings "
                       "from cardtrader_sold_daily where blueprint_id = 100000 + {n} "
                       "order by observed_day, condition, language, reverse, first_edition, graded",
    "card_book": "select external_listing_id, condition, language, seller_account_id from cardtrader_market_listing_snapshots "
                 "where coalesce(blueprint_id, cardtrader_blueprint_id) = 100000 + {n} order by external_listing_id limit 100",
    "search_trigram": "select c.card_id, round(similarity(c.search_text, t.q)::numeric, 6) from marketplace_search_candidates c, "
                      "(select left(search_text, 12) as q from marketplace_search_candidates where card_id = 2 * (100000 + {n})) t "
                      "where c.search_text % t.q order by similarity(c.search_text, t.q) desc, c.card_id limit 20",
    "search_prefix": "select card_id from marketplace_search_candidates where name_prefix = "
                     "(select name_prefix from marketplace_search_candidates where card_id = 2 * (100000 + {n})) "
                     "order by search_weight desc, imported_at desc nulls last, card_id limit 20",
    "set_page": "select card_id, card_number from marketplace_search_candidates where expansion_name = "
                "(select expansion_name from marketplace_search_candidates where card_id = 2 * (100000 + {n})) "
                "order by search_weight desc, card_id limit 300",
}
WHOLE = {  # one md5 over the whole result
    "sold_daily_rebuild_output": "select blueprint_id, observed_day, condition, language, reverse, first_edition, graded, "
                                 "median_pkn, min_pkn, max_pkn, sold_qty, listings, sample_count, graded_comments "
                                 "from cardtrader_sold_daily order by 1, 2, 3, 4, 5, 6, 7",
    "observations_analytics": "select blueprint_id, count(*), percentile_cont(0.5) within group (order by price_pkn) "
                              "from marketplace_price_observations group by blueprint_id order by blueprint_id",
}
RESOURCE_WORKLOADS = [
    ("card_desk", ["-f", "workloads/card_desk.sql"], "pokoin_marketplace"),
    ("search", ["-f", "workloads/search.sql"], "pokoin_marketplace"),
    ("set_page", ["-f", "workloads/set_page.sql"], "pokoin_marketplace"),
    ("listing_writes", ["-f", "workloads/listing_writes.sql"], "pokoin_marketplace"),
    ("book_upsert", ["-f", "workloads/book_upsert.sql"], "pokoin_marketplace"),
    ("tpcb", ["-b", "tpcb-like"], "pgbench"),
]


def parse_server(text):
    label, spec = text.split("=", 1)
    parts = dict(p.split("=", 1) for p in spec.split(","))
    return label, parts


def conninfo(parts, db):
    return f"host={parts['host']} port={parts['port']} user=pokoin_marketplace dbname={db}"


def psql(args, parts, db, sql):
    return subprocess.run([args.psql, conninfo(parts, db), "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", sql],
                          check=True, capture_output=True, text=True).stdout.strip()


def server_pids(datadir):
    with open(os.path.join(datadir, "postmaster.pid")) as handle:
        postmaster = int(handle.readline())
    pids = [postmaster]
    for entry in os.listdir("/proc"):
        if entry.isdigit():
            try:
                with open(f"/proc/{entry}/stat") as handle:
                    fields = handle.read().rsplit(")", 1)[1].split()
                if int(fields[1]) == postmaster:
                    pids.append(int(entry))
            except (OSError, IndexError, ValueError):
                pass
    return pids


def cluster_cpu_seconds(datadir):
    """All CPU the server has used: the postmaster's own, its reaped children's
    (cutime + cstime, where an exited backend's total lands) and every live
    child's. A backend alive at both ends, or born or gone in between, is
    counted exactly once in the difference of two readings."""
    pids = server_pids(datadir)
    total = 0
    for pid in pids:
        try:
            with open(f"/proc/{pid}/stat") as handle:
                fields = handle.read().rsplit(")", 1)[1].split()
            total += int(fields[11]) + int(fields[12])  # utime + stime
            if pid == pids[0]:
                total += int(fields[13]) + int(fields[14])  # cutime + cstime
        except (OSError, IndexError, ValueError):
            pass
    return total / TICK


def pss_mb(pids):
    total = 0
    for pid in pids:
        try:
            with open(f"/proc/{pid}/smaps_rollup") as handle:
                total += next(int(line.split()[1]) for line in handle if line.startswith("Pss:"))
        except (OSError, StopIteration):
            pass
    return total / 1024


def measured(datadir, action):
    """Run action() while sampling the server's memory every 0.25 s; return
    its result, the server CPU it cost, and the peak PSS."""
    stop = threading.Event()
    peak = {"pss": 0.0}

    def sampler():
        while not stop.is_set():
            peak["pss"] = max(peak["pss"], pss_mb(server_pids(datadir)))
            time.sleep(0.25)

    before = cluster_cpu_seconds(datadir)
    thread = threading.Thread(target=sampler)
    thread.start()
    started = time.monotonic()
    result = action()
    elapsed = time.monotonic() - started
    stop.set()
    thread.join()
    time.sleep(0.5)  # let the postmaster reap the backends that just disconnected
    return result, {"server_cpu_s": round(cluster_cpu_seconds(datadir) - before, 3),
                    "peak_pss_mb": round(peak["pss"], 1), "elapsed_s": round(elapsed, 3)}


def pgbench(args, parts, db, extra, seconds):
    out = subprocess.run([args.pgbench, "-n", "-c", str(args.clients), "-j", str(args.threads), "-T", str(seconds),
                          *extra, conninfo(parts, db)], cwd=HERE, check=True, capture_output=True, text=True).stdout
    return int(re.search(r"number of transactions actually processed: (\d+)", out).group(1))


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--pgbench", required=True)
    parser.add_argument("--psql", required=True)
    parser.add_argument("--server", action="append", required=True)
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--seconds", type=int, default=20)
    parser.add_argument("--clients", type=int, default=8)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    servers = [parse_server(s) for s in args.server]
    report = {"settings": {}, "outputs": {}, "resources": {}}

    # 1. settings that differ
    settings = {label: dict(line.split("|", 1) for line in psql(args, parts, "postgres",
                "select name, setting || coalesce(' ' || unit, '') from pg_settings order by name").splitlines())
                for label, parts in servers}
    (a, sa), (b, sb) = settings.items()
    ignore = {"server_version", "server_version_num", "data_directory", "port", "config_file", "hba_file",
              "ident_file", "unix_socket_directories", "external_pid_file", "lc_messages"}
    report["settings"] = {name: {a: sa.get(name), b: sb.get(name)}
                          for name in sorted(set(sa) | set(sb)) if name not in ignore and sa.get(name) != sb.get(name)}
    print(f"settings that differ: {len(report['settings'])}", flush=True)

    # 2. outputs
    for name, template in OUTPUTS.items():
        sql = "select string_agg(md5, ',' order by n) from (" + " union all ".join(
            f"select {n} as n, md5(coalesce(string_agg(r::text, '|'), '')) as md5 from ({template.format(n=n)}) r"
            for n in SAMPLE_N) + ") s"
        hashes = {label: psql(args, parts, "pokoin_marketplace", sql) for label, parts in servers}
        same = len(set(hashes.values())) == 1
        report["outputs"][name] = {"inputs": len(SAMPLE_N), "identical": same}
        print(f"outputs {name}: {'identical' if same else 'DIFFERENT'} over {len(SAMPLE_N)} inputs", flush=True)
    for name, sql in WHOLE.items():
        hashes = {label: psql(args, parts, "pokoin_marketplace",
                              f"select count(*) || ' rows ' || md5(coalesce(string_agg(r::text, '|'), '')) from ({sql}) r")
                  for label, parts in servers}
        same = len(set(hashes.values())) == 1
        report["outputs"][name] = {"result": hashes, "identical": same}
        print(f"outputs {name}: {'identical' if same else 'DIFFERENT'} {hashes}", flush=True)

    # 3. resources, one server at a time, alternating order
    def order(round_no):
        return servers if round_no % 2 == 0 else list(reversed(servers))

    for name, extra, db in RESOURCE_WORKLOADS:
        runs = {label: [] for label, _ in servers}
        for round_no in range(args.rounds):
            for label, parts in order(round_no):
                pgbench(args, parts, db, extra, 3)
                tx, usage = measured(parts["data"], lambda: pgbench(args, parts, db, extra, args.seconds))
                usage.update(transactions=tx, cpu_ms_per_tx=round(usage["server_cpu_s"] * 1000 / max(tx, 1), 4))
                runs[label].append(usage)
                print(f"resources {name} {label} round {round_no + 1}: {usage}", flush=True)
        report["resources"][name] = runs
    runs = {label: [] for label, _ in servers}
    for round_no in range(args.rounds):
        for label, parts in order(round_no):
            _, usage = measured(parts["data"], lambda: psql(args, parts, "pokoin_marketplace",
                                                            "select public.refresh_cardtrader_sold_daily(null)"))
            runs[label].append(usage)
            print(f"resources sold_daily_rebuild {label} round {round_no + 1}: {usage}", flush=True)
    report["resources"]["sold_daily_rebuild"] = runs

    with open(args.out, "w") as handle:
        json.dump(report, handle, indent=1)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
