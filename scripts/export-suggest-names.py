#!/usr/bin/env python3
"""Dump unique blueprint names into market/src/data/suggest-names.js.

Typeahead scores the whole compact query against these rows (printing count
as prior). Re-run after a catalog name refresh:

  python3 scripts/export-suggest-names.py
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "market/src/data/suggest-names.js"
CONTAINER = "pokoin-marketplace-postgres-15t"
SQL = """
SELECT compact_name,
       (array_agg(name ORDER BY printings DESC, length(name) ASC, name ASC))[1] AS display,
       max(printings) AS prior
FROM (
  SELECT n.compact_name, n.name, count(c.card_id)::int AS printings
  FROM marketplace_card_names n
  LEFT JOIN marketplace_cards c ON c.name = n.name
  GROUP BY n.compact_name, n.name
) s
GROUP BY compact_name
ORDER BY prior DESC, display ASC;
"""


def main() -> None:
    raw = subprocess.check_output(
        [
            "docker",
            "exec",
            "-i",
            CONTAINER,
            "psql",
            "-U",
            "pokoin_marketplace",
            "-d",
            "pokoin_marketplace",
            "-t",
            "-A",
            "-F",
            "\t",
            "-c",
            SQL,
        ],
        text=True,
    )
    rows = []
    seen = set()
    for line in raw.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        compact, display, prior = parts
        if not compact or compact in seen:
            continue
        seen.add(compact)
        rows.append(
            {
                "display": display,
                "prior": max(1, int(prior or 0)),
            }
        )
    if len(rows) < 1000:
        raise SystemExit(f"too few names: {len(rows)}")
    body = ",\n".join(json.dumps(row, ensure_ascii=True, separators=(",", ":")) for row in rows)
    OUT.write_text("export default [\n" + body + "\n];\n", encoding="utf-8")
    print(f"wrote {len(rows)} names to {OUT}")


if __name__ == "__main__":
    main()
