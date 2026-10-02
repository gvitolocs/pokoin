#!/usr/bin/env python3
"""Summarize the daily CardTrader stages without changing their import result."""
import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import subprocess
import sys

DEFAULT_NOTIFIER = "/home/nez/Projects/tcgprices/notify_flareon.py"
ANALYTICS_SQL = """
select json_build_object(
  'dumpDay', observed_day, 'sourceTimestamp', max(refreshed_at),
  'printings', count(*)
)
from public.cardtrader_blueprint_daily_analytics
where observed_day = (
  select observed_day from public.cardtrader_blueprint_daily_analytics
  order by observed_day desc limit 1
)
group by observed_day;
"""


def timestamp(value):
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(dt.timezone.utc)
    except (ValueError, TypeError):
        return None


def read_report(path):
    try:
        report = json.loads(path.read_text())
        return report if isinstance(report, dict) else {}
    except (OSError, ValueError):
        return {}


def count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def probe_analytics(started_at):
    """Read the newest daily bucket on the local writer, with bounded locks/time."""
    command = [
        "docker", "exec", "-e", "PGOPTIONS=-c statement_timeout=5000 -c lock_timeout=1000",
        "pokoin-marketplace-postgres-15t", "psql", "-X", "-At",
        "-U", "pokoin_marketplace", "-d", "pokoin_marketplace",
        "-v", "ON_ERROR_STOP=1", "-c", ANALYTICS_SQL,
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=12)
        if result.returncode:
            return {"state": "unknown"}
        if not result.stdout.strip():
            return {"state": "missing"}
        row = json.loads(result.stdout)
        source_time = timestamp(row.get("sourceTimestamp"))
        run_time = timestamp(started_at)
        if not source_time or not run_time:
            return {"state": "unknown"}
        row["state"] = "fresh" if source_time >= run_time else "stale"
        return row
    except (OSError, ValueError, AttributeError, subprocess.TimeoutExpired):
        return {"state": "unknown"}


def build_summary(root, started_at, exit_code, stages, analytics):
    listing = read_report(root / "listing-dump-status.json")
    catalog = read_report(root / "status.json")
    total = count(listing.get("totalExpansions"))
    completed = count(listing.get("completed"))
    run_time = timestamp(started_at)
    listing_start = timestamp(listing.get("startedAt"))
    listing_finish = timestamp(listing.get("finishedAt"))
    current_report = bool(run_time and listing_start and listing_finish
                          and listing_start >= run_time and listing_finish >= listing_start)
    raw_complete = bool(current_report and total > 0 and completed == total
                        and isinstance(listing.get("errors"), list) and not listing["errors"]
                        and stages.get("dump") == 0)
    failed_stages = [name for name, code in stages.items() if code != 0]
    status = "complete" if raw_complete and not failed_stages and exit_code == 0 \
        and analytics.get("state") == "fresh" else "partial" if raw_complete else "failed"
    lines = [f"CardTrader daily update: {status} ({root.name})."]
    if raw_complete:
        lines.append(f"Raw listing dump complete: {completed}/{total} expansions, "
                     f"{count(listing.get('listings'))} listings. Finished {listing['finishedAt']}.")
    elif current_report:
        lines.append(f"Raw listing dump incomplete: {completed}/{total} expansions; "
                     f"{len(listing.get('errors', [])) if isinstance(listing.get('errors'), list) else 'unknown'} errors.")
    else:
        lines.append("Raw listing dump completion is unverified (missing, incomplete or stale report).")
    state = analytics.get("state", "unknown")
    if state in ("fresh", "stale"):
        label = "fresh" if state == "fresh" else "not refreshed during this run"
        lines.append(f"Pokemon daily price analytics: {label}; source refresh "
                     f"{analytics['sourceTimestamp']}, dump bucket {analytics.get('dumpDay', 'unknown')}, "
                     f"{count(analytics.get('printings'))} printings.")
    elif state == "missing":
        lines.append("Pokemon daily price analytics: no daily rows found.")
    else:
        lines.append("Pokemon daily price analytics: freshness unknown (writer probe unavailable).")
    if failed_stages:
        lines.append("Failed stages: " + ", ".join(failed_stages) + ".")
    errors = catalog.get("errors")
    if isinstance(errors, list) and errors:
        games = sorted({str(row.get("database", "unknown game")) for row in errors if isinstance(row, dict)})
        lines.append("Catalogue failures: " + ", ".join(games) + ".")
    if status == "complete":
        lines.append("Catalogue, pictures, artwork and search stages completed.")
    lines.append("Daily prices are listing asks; inferred sold prices remain separate.")
    return {
        "source": "cardtrader", "status": status, "message": "\n".join(lines)[:3500],
        "eventKey": f"cardtrader:{root.name}:{started_at}",
        "importExitCode": exit_code, "stages": stages,
        "rawDumpComplete": raw_complete, "analytics": analytics,
    }


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".part")
    temporary.write_text(json.dumps(payload, indent=2) + "\n")
    temporary.replace(path)


def send_summary(summary, notifier):
    try:
        result = subprocess.run([
            sys.executable, notifier, "--source", summary["source"],
            "--status", summary["status"], "--message", summary["message"],
            "--event-key", summary["eventKey"],
        ], capture_output=True, text=True, timeout=30)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-root", required=True, type=pathlib.Path)
    parser.add_argument("--started-at", required=True)
    parser.add_argument("--exit-code", required=True, type=int)
    parser.add_argument("--stage-result", action="append", default=[])
    parser.add_argument("--notifier", default=os.environ.get("POKOIN_PRICE_NOTIFIER", DEFAULT_NOTIFIER))
    args = parser.parse_args(argv)
    stages = {}
    for value in args.stage_result:
        name, code = value.split("=", 1)
        stages[name] = int(code)
    summary = build_summary(args.run_root, args.started_at, args.exit_code, stages,
                            probe_analytics(args.started_at))
    # Retain the exact payload before delivery, even if the shared notifier is missing.
    event_hash = hashlib.sha256(summary["eventKey"].encode()).hexdigest()
    event_path = args.run_root / "notification-outbox" / (event_hash + ".json")
    write_json(event_path, summary)
    delivered = send_summary(summary, args.notifier)
    summary["delivery"] = "delivered" if delivered else "pending"
    write_json(event_path, summary)
    write_json(args.run_root / "notification-status.json", summary)
    print(f"CardTrader notification {summary['delivery']}; update status {summary['status']}.")
    return 0 if delivered else 1


if __name__ == "__main__":
    raise SystemExit(main())
