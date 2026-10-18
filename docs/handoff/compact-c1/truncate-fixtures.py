#!/usr/bin/env python3
"""Shrink the captured responses to a committable test corpus.

The full captures are 2.0 MB — far more than the tests need, and more than
belongs on `main`. The tests care about response *shapes* (which columns exist,
which codecs they drive, how the envelope nests), not about row count, so each
row array is cut to its first few rows and everything else is copied verbatim.

    python3 docs/handoff/compact-c1/truncate-fixtures.py --rows 8 \\
        --src <full-captures-dir> --dest docs/handoff/compact-c1/fixtures

What is kept deliberately:

- **Scalar id arrays are left whole** (`sections.featuredIds` and friends). They
  are a few hundred bytes and they are the only thing that exercises the `c1`
  vector codec, which needs 8+ entries to kick in.
- **Scalar metadata is left exactly as captured** (`count`, `total`,
  `hasMore`). A truncated file therefore says `total: 244` while holding 8
  cards. That is on purpose: editing those numbers would invent a response the
  API never served. Each file is a faithful *prefix* of a real response, not a
  re-synthesised one.
- **Files with no row array, or already short, are copied unchanged** — the
  single-row `card-versions-card` and the `{"error": ...}` body of
  `card-versions-pikachu` are what cover the below-threshold and no-table
  paths.

Row count is the only knob. It must stay at or above the encoder's
`TABLE_MIN_ROWS` (4) for an array to become a table at all; 8 leaves room for
palettes to repeat and for `hasMore`-style pagination shapes to stay sane.

Re-running this needs the full captures, which are not in the repo. They are
read-only public GETs against api.pokoin.com — see the README for the routes.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

def truncate(value: object, rows: int) -> object:
    """Copy `value`, cutting every array of objects down to `rows` entries.

    Any all-object array is a row array, wherever it sits — the top-level
    `cards`, the `expansions` listing, the nested `facets.products`. An array
    holding anything else is an id list or a gradient pair and stays whole.
    """
    if isinstance(value, list):
        if value and all(isinstance(item, dict) for item in value):
            value = value[:rows]
        return [truncate(item, rows) for item in value]
    if isinstance(value, dict):
        return {key: truncate(item, rows) for key, item in value.items()}
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", type=int, default=8, help="rows to keep (min 4)")
    parser.add_argument("--src", required=True, help="directory of full captures")
    parser.add_argument("--dest", required=True, help="directory to write into")
    args = parser.parse_args()

    if args.rows < 4:
        print("--rows must be >= 4 (the encoder's TABLE_MIN_ROWS)", file=sys.stderr)
        return 2

    src = pathlib.Path(args.src)
    dest = pathlib.Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)

    captures = sorted(src.glob("*.json"))
    if not captures:
        print(f"no *.json in {src}", file=sys.stderr)
        return 1

    for path in captures:
        original = path.read_bytes()
        body = json.loads(original)
        shrunk = truncate(body, args.rows)
        # Compact separators: these are wire captures, not documents to read.
        text = json.dumps(shrunk, ensure_ascii=False, separators=(",", ":"))
        target = dest / path.name
        target.write_text(text, encoding="utf-8")
        print(
            f"{path.name}: {len(original) / 1024:7.1f} KB -> "
            f"{len(text.encode()) / 1024:6.1f} KB"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
