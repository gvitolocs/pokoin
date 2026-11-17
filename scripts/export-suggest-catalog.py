#!/usr/bin/env python3
"""Dump artists and expansions into market/src/data for typeahead.

Names stay in export-suggest-names.py (printing prior). This file is the rest
of the local catalog: illustrators, set titles and each set's `tcg_shortnames`
codes from marketplace_expansion_aliases (DEX, PLF, SVI…), which the typeahead
reads as set intent. Re-run:

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
  coalesce(nullif(trim(expansions.nationality), ''), '') AS nationality,
  coalesce(short_names.codes, '') AS codes
FROM pokoin_pokemon_expansions expansions
LEFT JOIN marketplace_set_card_counts counts
  ON counts.set_name = expansions.name
LEFT JOIN LATERAL (
  SELECT string_agg(DISTINCT alias.compact_alias, ' ' ORDER BY alias.compact_alias) AS codes
  FROM marketplace_expansion_aliases alias
  WHERE alias.normalized_expansion_name = expansions.normalized_name
    AND alias.source = 'tcg_shortnames'
    AND alias.compact_alias ~ '^[a-z0-9]{3,7}$'
) short_names ON true
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
        if len(parts) not in (3, 4, 5):
            continue
        slug, display, prior = parts[0], parts[1], parts[2]
        nationality = (parts[3] if len(parts) > 3 else "").strip().lower()
        codes = (parts[4] if len(parts) > 4 else "").split()
        display = (display or "").strip()
        slug = slugify(display) or (slug or "").strip()
        if not slug or not display or slug in seen:
            continue
        seen.add(slug)
        row = {"display": display, "slug": slug, "prior": max(1, int(prior or 0))}
        if nationality:
            row["nationality"] = nationality
        if codes:
            row["codes"] = codes
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
    # Derived first-paint table (market/src/expansion-nationality.js reads it).
    subprocess.run(["node", str(ROOT / "scripts/export-expansion-nationality.mjs")], check=True)


if __name__ == "__main__":
    main()
