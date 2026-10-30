#!/usr/bin/env python3
"""Markdown report from run.py (and optionally verify.py) results.

A difference is called only when it is at least 5% AND the two servers'
rounds do not overlap (every round of one beats every round of the other);
anything else is reported as inconclusive, with every round shown.

  bench/postgres/report.py results/<run>.json [results/<verify>.json] [results/<writes>.json] > results/<date>.md
  bench/postgres/report.py results/<writes>.json > results/<date>-writes.md
"""
import json, statistics, sys

THRESHOLD = 0.05


def fmt(value, digits=2):
    return "–" if value is None else f"{value:,.{digits}f}"


def verdict(old, new, higher_is_better):
    """old/new: lists of per-round values."""
    if not old or not new:
        return "–", None
    m_old, m_new = statistics.median(old), statistics.median(new)
    delta = (m_new - m_old) / m_old if m_old else 0.0
    better = (delta > 0) == higher_is_better
    # Every round of one server beyond every round of the other, in the direction of the change.
    separated = min(new) > max(old) if delta > 0 else max(new) < min(old)
    if abs(delta) < THRESHOLD or not separated:
        return f"{delta:+.1%} inconclusive", delta
    return f"**{delta:+.1%} {'better' if better else 'worse'}**", delta


def spread(values):
    m = statistics.median(values)
    return (max(values) - min(values)) / m if m else 0.0


def render_writes(data, w):
    old, new = list(data["meta"]["servers"])
    meta = data["meta"]
    w(f"## Writes from identical snapshots: {meta['servers'][old]} vs {meta['servers'][new]}\n")
    w(f"Every run starts from the same database (recreated from one template, checkpointed, touched tables "
      f"prewarmed) and runs the same seeded transactions: {meta['clients']} clients, seed {meta['seed']}, "
      f"{meta['rounds']} rounds alternating which server goes first.\n")
    rows = [("tps", "tps", True, 0), ("p50 ms", "p50_ms", False, 2), ("p95 ms", "p95_ms", False, 2),
            ("p99 ms", "p99_ms", False, 2), ("server CPU ms/tx", "cpu_ms_per_tx", False, 3),
            ("WAL bytes/tx", "wal_bytes_per_tx", False, 0), ("table growth MB", "table_growth_mb", False, 2),
            ("index growth MB", "index_growth_mb", False, 2), ("dead tuples after", "dead_tuples_after", False, 0),
            ("autovacuum runs", "autovacuum_runs", False, 0), ("checkpoints", "checkpoints", False, 0)]
    for name, workload in data["workloads"].items():
        runs = workload["runs"]
        w(f"### `{name}`: {runs[old][0]['transactions']:,} transactions per run, end state identical everywhere: "
          f"{'yes' if workload['same_end_state_everywhere'] else '**NO**'}\n")
        w(f"| measure | {old} rounds | {new} rounds | {new} vs {old} |")
        w("| --- | --- | --- | --- |")
        for label, key, higher, digits in rows:
            a, b = [r[key] for r in runs[old]], [r[key] for r in runs[new]]
            text = verdict(a, b, higher)[0] if any(a) and key in ("tps", "p50_ms", "p95_ms", "p99_ms", "cpu_ms_per_tx", "wal_bytes_per_tx") else "–"
            w(f"| {label} | {', '.join(fmt(x, digits) for x in a)} | {', '.join(fmt(x, digits) for x in b)} | {text} |")
        failed = sum(r["failed"] for side in runs.values() for r in side)
        w(f"\nFailed transactions: {failed}. End state: `{workload['end_states'][0][:160]}`\n")


def main():
    first = json.load(open(sys.argv[1]))
    extra = [json.load(open(path)) for path in sys.argv[2:]]
    out = []
    w = out.append
    if "workloads" in first:
        render_writes(first, w)
        print("\n".join(out))
        return
    run = first
    verify = next((x for x in extra if "outputs" in x), None)
    writes = next((x for x in extra if "workloads" in x), None)
    labels = list(run["meta"]["servers"])
    old, new = labels
    meta = run["meta"]
    w(f"# Postgres {meta['servers'][old]} vs {meta['servers'][new]}: Pokoin workloads\n")
    w(f"Started {meta['started']}. {meta['rounds']} rounds per workload, servers alternating first; "
      f"pgbench {meta['clients']} clients / {meta['threads']} threads, {meta['seconds']} s measured after a warm-up; "
      f"{meta['cpus']} CPUs shared, one server measured at a time. A difference is called only at ≥5% "
      f"with no overlap between the two servers' rounds.\n")

    w("## Batch jobs (seconds, lower is better)\n")
    w(f"| job | {old} rounds | {new} rounds | {old} median | {new} median | {new} vs {old} |")
    w("| --- | --- | --- | ---: | ---: | --- |")
    for name, data in run["batch"].items():
        a, b = data[old]["runs"], data[new]["runs"]
        text, _ = verdict(a, b, higher_is_better=False)
        w(f"| `{name}` | {', '.join(fmt(x) for x in a)} | {', '.join(fmt(x) for x in b)} | "
          f"{fmt(statistics.median(a))} | {fmt(statistics.median(b))} | {text} |")

    w("\n## Query workloads\n")
    w(f"Throughput in transactions per second (higher is better); latency per transaction in ms (lower is better).\n")
    w(f"| workload | {old} tps rounds | {new} tps rounds | tps {new} vs {old} | "
      f"{old} p50 / p95 / p99 | {new} p50 / p95 / p99 | p95 {new} vs {old} | failed tx |")
    w("| --- | --- | --- | --- | --- | --- | --- | ---: |")
    for name, data in run["pgbench"].items():
        a, b = data[old]["runs"], data[new]["runs"]
        tps_text, _ = verdict([r["tps"] for r in a], [r["tps"] for r in b], True)
        p95_text, _ = verdict([r["p95_ms"] for r in a], [r["p95_ms"] for r in b], False)
        lat = lambda side: " / ".join(fmt(side[k]["median"]) for k in ("p50_ms", "p95_ms", "p99_ms"))
        w(f"| `{name}`{' *(generic)*' if name in ('tpcb', 'select_only') else ''} | "
          f"{', '.join(fmt(r['tps'], 0) for r in a)} | {', '.join(fmt(r['tps'], 0) for r in b)} | {tps_text} | "
          f"{lat(data[old])} | {lat(data[new])} | {p95_text} | {data[old]['failed'] + data[new]['failed']} |")

    w("\n## Round-to-round spread\n")
    w("(max − min) / median of each server's rounds; a difference smaller than this is noise.\n")
    w(f"| measure | {old} | {new} |")
    w("| --- | ---: | ---: |")
    for name, data in run["batch"].items():
        w(f"| `{name}` seconds | {spread(data[old]['runs']):.1%} | {spread(data[new]['runs']):.1%} |")
    for name, data in run["pgbench"].items():
        w(f"| `{name}` tps | {spread([r['tps'] for r in data[old]['runs']]):.1%} | "
          f"{spread([r['tps'] for r in data[new]['runs']]):.1%} |")

    if verify:
        w("\n## Correctness: identical outputs\n")
        w("| check | inputs | identical |")
        w("| --- | --- | --- |")
        for name, data in verify["outputs"].items():
            inputs = data.get("inputs") or " ".join(sorted(set(data.get("result", {}).values())))[:60]
            w(f"| `{name}` | {inputs} | {'yes' if data['identical'] else '**NO**'} |")

        w("\n## Resources\n")
        w("Server CPU per 1,000 transactions (postmaster, backends and reaped children, from /proc) and peak memory "
          "(sum of PSS over the server's processes, so shared_buffers counts once). Median of the rounds, with all rounds.\n")
        w(f"| workload | {old} CPU ms/tx | {new} CPU ms/tx | CPU {new} vs {old} | {old} peak MB | {new} peak MB |")
        w("| --- | --- | --- | --- | ---: | ---: |")
        for name, runs in verify["resources"].items():
            key = "cpu_ms_per_tx" if "cpu_ms_per_tx" in runs[old][0] else "server_cpu_s"
            a, b = [r[key] for r in runs[old]], [r[key] for r in runs[new]]
            text, _ = verdict(a, b, False)
            unit = "" if key == "cpu_ms_per_tx" else " (CPU s, whole job)"
            w(f"| `{name}`{unit} | {', '.join(fmt(x, 3) for x in a)} | {', '.join(fmt(x, 3) for x in b)} | {text} | "
              f"{fmt(max(r['peak_pss_mb'] for r in runs[old]), 0)} | {fmt(max(r['peak_pss_mb'] for r in runs[new]), 0)} |")

        w("\n## Settings that differ between the two servers\n")
        w("Both load the same `postgresql.bench.conf`; these are the remaining differences (new defaults and new settings).\n")
        w(f"| setting | {old} | {new} |")
        w("| --- | --- | --- |")
        for name, values in verify["settings"].items():
            w(f"| `{name}` | {values.get(old) or '(absent)'} | {values.get(new) or '(absent)'} |")
    if writes:
        w("")
        render_writes(writes, w)
    print("\n".join(out))


if __name__ == "__main__":
    main()
