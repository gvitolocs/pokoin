#!/usr/bin/env python3
"""Dump artists and expansions into market/src/data for typeahead.

Names stay in export-suggest-names.py (printing prior). This file is the rest
of the local catalog: illustrators and set titles. Re-run:

  python3 scripts/export-suggest-catalog.py
"""

from __future__ import annotations

import json
import re
import subprocess
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTISTS_OUT = ROOT / "market/src/data/suggest-artists.js"
SETS_OUT = ROOT / "market/src/data/suggest-sets.js"
CONTAINER = "pokoin-marketplace-postgres-15t"

ARTIST_SQL = """
SELECT
  trim(both '-' from regexp_replace(lower(coalesce(normalized_artist, '')), '[^a-z0-9]+', '-', 'g')) AS slug,
  max(coalesce(nullif(artist, ''), illustrator)) AS display,
  max(coalesce(artist_card_count, 0))::int AS prior
FROM marketplace_blueprint_artists
WHERE coalesce(normalized_artist, '') <> ''
GROUP BY 1
ORDER BY prior DESC, display ASC;
"""

SET_SQL = """
SELECT
  coalesce(nullif(counts.slug, ''), '') AS slug,
  expansions.name AS display,
  greatest(coalesce(expansions.catalog_card_count, counts.catalog_card_count, 0), 1)::int AS prior,
  coalesce(nullif(trim(expansions.nationality), ''), '') AS nationality
FROM pokoin_pokemon_expansions expansions
LEFT JOIN marketplace_set_card_counts counts
  ON counts.set_name = expansions.name
WHERE coalesce(expansions.name, '') <> ''
ORDER BY prior DESC, display ASC;
"""


def slugify(value: str) -> str:
    text = unicodedata.normalize("NFKD", value or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def psql(sql: str) -> list[dict]:
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
            sql,
        ],
        text=True,
    )
    rows = []
    seen = set()
    for line in raw.splitlines():
        parts = line.split("\t")
        if len(parts) not in (3, 4):
            continue
        slug, display, prior = parts[0], parts[1], parts[2]
        nationality = (parts[3] if len(parts) > 3 else "").strip().lower()
        display = (display or "").strip()
        slug = slugify(display) or (slug or "").strip()
        if not slug or not display or slug in seen:
            continue
        seen.add(slug)
        row = {"display": display, "slug": slug, "prior": max(1, int(prior or 0))}
        if nationality:
            row["nationality"] = nationality
        rows.append(row)
    return rows


def write_js(path: Path, rows: list[dict], label: str) -> None:
    if len(rows) < 50:
        raise SystemExit(f"too few {label}: {len(rows)}")
    body = ",\n".join(json.dumps(row, ensure_ascii=True, separators=(",", ":")) for row in rows)
    path.write_text("export default [\n" + body + "\n];\n", encoding="utf-8")
    print(f"wrote {len(rows)} {label} to {path}")


def main() -> None:
    write_js(ARTISTS_OUT, psql(ARTIST_SQL), "artists")
    write_js(SETS_OUT, psql(SET_SQL), "sets")


if __name__ == "__main__":
    main()
