#!/usr/bin/env python3
"""Measure default vs c1 payload sizes, compressed and not.

Runs the Rust `c1_measure` example over the captured fixtures in this
directory (which also asserts the byte-for-byte round trip), then compresses
both bodies with brotli and zstd and prints the markdown table that lives in
`docs/rust-migration/COMPACT_ENCODING.md`.

    python3 docs/handoff/compact-c1/measure-sizes.py [--out DIR]

Needs `brotli` and `zstandard` (`pip install brotli zstandard`); either one
missing just leaves its columns out.
"""

from __future__ import annotations

import argparse
import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[2]
RUST = REPO / "pokoin-rust"

# Brotli 11 / zstd 19 are the levels a CDN uses for a cacheable text response.
BROTLI_QUALITY = 11
ZSTD_LEVEL = 19

try:
    import brotli
except ImportError:
    brotli = None

try:
    import zstandard
except ImportError:
    zstandard = None


def delta(after: int | None, before: int | None) -> str:
    """`after` as a signed percentage change from `before`."""
    if not before or after is None:
        return "—"
    change = (after / before - 1) * 100
    if abs(change) < 0.05:
        return "±0%"
    return f"{'+' if change > 0 else '−'}{abs(change):.1f}%"


def human(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / 1024 / 1024:.2f} MB"
    if n >= 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n} B"


def brotli_size(data: bytes) -> int | None:
    if brotli is None:
        return None
    return len(brotli.compress(data, quality=BROTLI_QUALITY))


def zstd_size(data: bytes) -> int | None:
    if zstandard is None:
        return None
    return len(zstandard.ZstdCompressor(level=ZSTD_LEVEL).compress(data))


def zstd_dictionary_sizes(samples: list[bytes]) -> tuple[int, list[int]] | None:
    """Train one zstd dictionary over every sample and recompress with it.

    This is the "shared dictionary" row of the comparison: it is what
    Compression Dictionary Transport (`dcz`) would buy on these payloads if
    every browser supported it.
    """
    if zstandard is None or len(samples) < 2:
        return None
    try:
        trained = zstandard.train_dictionary(110 * 1024, samples)
    except Exception:  # pragma: no cover - training needs enough similar input
        return None
    compressor = zstandard.ZstdCompressor(level=ZSTD_LEVEL, dict_data=trained)
    return len(trained.as_bytes()), [len(compressor.compress(s)) for s in samples]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=None, help="where to keep the encoded bodies")
    args = parser.parse_args()

    fixtures = sorted((HERE / "fixtures").glob("*.json"))
    if not fixtures:
        print(f"no fixtures in {HERE / 'fixtures'}", file=sys.stderr)
        return 1

    temporary = None
    if args.out:
        out = pathlib.Path(args.out)
    else:
        temporary = tempfile.mkdtemp(prefix="c1-measure-")
        out = pathlib.Path(temporary)

    try:
        run = subprocess.run(
            [
                "cargo",
                "run",
                "--release",
                "--quiet",
                "--example",
                "c1_measure",
                "--",
                str(out),
                *[str(path) for path in fixtures],
            ],
            cwd=RUST,
            capture_output=True,
            text=True,
            check=False,
        )
        if run.returncode != 0:
            sys.stderr.write(run.stderr)
            return run.returncode

        rows = []
        lines = [line for line in run.stdout.splitlines() if line.strip()]
        header = lines[0].split("\t")
        for line in lines[1:]:
            rows.append(dict(zip(header, line.split("\t"))))

        defaults: list[bytes] = []
        compacts: list[bytes] = []
        for row in rows:
            name = row["name"]
            defaults.append((out / f"{name}.default.json").read_bytes())
            compacts.append((out / f"{name}.c1.json").read_bytes())

        print(f"brotli q{BROTLI_QUALITY}, zstd level {ZSTD_LEVEL}\n")
        print(
            "| fixture | rows | default | c1 | c1 vs default | default+br | c1+br "
            "| c1+br vs default+br | serialize | encode | decode |"
        )
        print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")

        totals = dict.fromkeys(["default", "c1", "default_br", "c1_br"], 0)
        for row, raw_default, raw_compact in zip(rows, defaults, compacts):
            plain = len(raw_default)
            compact = len(raw_compact)
            br_default = brotli_size(raw_default)
            br_compact = brotli_size(raw_compact)
            totals["default"] += plain
            totals["c1"] += compact
            if br_default and br_compact:
                totals["default_br"] += br_default
                totals["c1_br"] += br_compact
            ratio = delta(compact, plain)
            br_ratio = delta(br_compact, br_default)
            print(
                f"| `{row['name']}` | {row['rows']} | {human(plain)} | {human(compact)} "
                f"| {ratio} | {human(br_default) if br_default else '—'} "
                f"| {human(br_compact) if br_compact else '—'} | {br_ratio} "
                f"| {int(row['serialize_us']) / 1000:.2f} ms "
                f"| {int(row['encode_us']) / 1000:.2f} ms "
                f"| {int(row['decode_us']) / 1000:.2f} ms |"
            )

        total_ratio = delta(totals["c1"], totals["default"])
        total_br = delta(totals["c1_br"], totals["default_br"])
        print(
            f"| **all {len(rows)}** | | {human(totals['default'])} | {human(totals['c1'])} "
            f"| **{total_ratio}** | {human(totals['default_br'])} | {human(totals['c1_br'])} "
            f"| **{total_br}** | | | |"
        )

        print("\n### Other encodings, same bodies\n")
        print("| encoding | all 11 fixtures | vs default raw | vs default+brotli |")
        print("| --- | --- | --- | --- |")
        base_raw = totals["default"]
        base_br = totals["default_br"]

        def compare(label: str, total: int | None) -> None:
            if not total:
                return
            print(
                f"| {label} | {human(total)} | {delta(total, base_raw)} "
                f"| {delta(total, base_br)} |"
            )

        compare("default JSON", base_raw)
        compare(f"default JSON + brotli q{BROTLI_QUALITY}", base_br)
        compare(
            f"default JSON + zstd {ZSTD_LEVEL}",
            sum(filter(None, (zstd_size(b) for b in defaults))) or None,
        )
        trained = zstd_dictionary_sizes(defaults)
        if trained:
            size, sizes = trained
            compare(
                f"default JSON + zstd {ZSTD_LEVEL} + shared dictionary ({human(size)})",
                sum(sizes),
            )
        compare("c1", totals["c1"])
        compare(f"c1 + brotli q{BROTLI_QUALITY}", totals["c1_br"])
        compare(
            f"c1 + zstd {ZSTD_LEVEL}",
            sum(filter(None, (zstd_size(b) for b in compacts))) or None,
        )
        return 0
    finally:
        if temporary:
            shutil.rmtree(temporary, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
