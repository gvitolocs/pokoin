#!/usr/bin/env python3
"""Roll CardTrader removed/sold + native listing events into Oracle card weights.

Does not copy snapshot rows. Safe to run during the daily CardTrader refresh:
statement/lock timeouts are short; a busy box skips until the next timer.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import subprocess
import sys

PSQL = [
    "docker",
    "exec",
    "-i",
    "pokoin-marketplace-postgres",
    "psql",
    "-U",
    "pokoin_marketplace",
    "-d",
    "pokoin_marketplace",
    "-At",
    "-P",
    "pager=off",
]


def psql(sql: str, timeout: int = 70) -> str:
    return subprocess.check_output(PSQL, input=sql.encode(), timeout=timeout).decode()


def run_one(label: str, sql: str) -> str:
    try:
        out = psql(
            "SET statement_timeout = '45s';\nSET lock_timeout = '4s';\n" + sql,
            timeout=70,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as error:
        print(f"{label} skipped: {error}", file=sys.stderr)
        return ""
    return out.strip()


def main() -> None:
    today = datetime.now(timezone.utc).date()
    yesterday = today - timedelta(days=1)
    parts = [
        run_one("stats_yesterday", f"SELECT 'stats_yesterday=' || public.refresh_marketplace_listing_stats('{yesterday}'::date);"),
        run_one("stats_today", f"SELECT 'stats_today=' || public.refresh_marketplace_listing_stats('{today}'::date);"),
        run_one("weights", "SELECT 'weights=' || public.refresh_marketplace_card_weights();"),
        run_one(
            "counts",
            "SELECT 'weight_rows=' || count(*) FROM public.marketplace_card_weights;\n"
            "SELECT 'sold_7d_cards=' || count(*) FROM public.marketplace_card_weights WHERE sold_7d > 0;",
        ),
    ]
    text = "\n".join(part for part in parts if part)
    print(text or "listing weights ok")


if __name__ == "__main__":
    main()
