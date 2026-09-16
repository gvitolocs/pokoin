#!/usr/bin/env python3
"""Print 15T databases + leftover prefix bytes for the multi-game re-import.

Does not GET CardTrader. Oracle remains the ingest hop; this is inventory
on nezopt only. Map: docs/MULTIGAME_REIMPORT.md
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

PG = "pokoin-marketplace-postgres-15t"
PG_USER = "pokoin_marketplace"
PG_DB = "pokoin_marketplace"
OBJECTS = Path(
    os.environ.get("POKOIN_NVME_LEFTOVERS", "/home/nez/data/pokoin-leftovers")
) / "objects"
GAMES = (
    ("pokoin_marketplace", "", "Pokemon"),
    ("pokoin_one_piece", "one-piece", "One Piece"),
    ("pokoin_riftbound", "riftbound", "Riftbound"),
    ("pokoin_magic", "magic", "Magic"),
    ("pokoin_yugioh", "yugioh", "Yu-Gi-Oh"),
    ("pokoin_lorcana", "lorcana", "Lorcana"),
    ("pokoin_flesh_and_blood", "flesh-and-blood", "Flesh and Blood"),
    ("pokoin_digimon", "digimon", "Digimon"),
    ("pokoin_dragon_ball_super", "dragon-ball-super", "Dragon Ball Super"),
    ("pokoin_vanguard", "vanguard", "Vanguard"),
    ("pokoin_star_wars", "star-wars", "Star Wars Unlimited"),
    ("pokoin_union_arena", "union-arena", "Union Arena"),
    ("pokoin_gundam", "gundam", "Gundam"),
    ("pokoin_sorcery", "sorcery", "Sorcery"),
)


def docker_psql(sql: str) -> str:
    try:
        out = subprocess.run(
            ["docker", "exec", "-i", PG, "psql", "-U", PG_USER, "-d", PG_DB, "-At"],
            input=sql.encode(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=20,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return f"err:{exc}"
    if out.returncode != 0:
        err = (out.stderr or out.stdout).decode().strip().splitlines()
        return err[-1] if err else f"exit {out.returncode}"
    return out.stdout.decode().strip()


def prefix_bytes(prefix: str) -> str:
    path = OBJECTS if not prefix else OBJECTS / prefix
    if not path.is_dir():
        return "-"
    try:
        out = subprocess.run(
            ["du", "-sh", str(path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=60,
            text=True,
        )
    except subprocess.TimeoutExpired:
        return "timeout"
    return (out.stdout.split() or ["?"])[0]


def main() -> int:
    dbs_raw = docker_psql(
        "SELECT datname FROM pg_database WHERE datistemplate = false;"
    )
    if dbs_raw.startswith("err:") or (dbs_raw and "FATAL" in dbs_raw):
        print(dbs_raw)
        dbs = set()
    else:
        dbs = set(line.strip() for line in dbs_raw.splitlines() if line.strip())
    print("15T writer: Oracle GET persists here. Pi replica streams these DBs.")
    print(f"objects: {OBJECTS}")
    print(f"{'game':<22} {'db':<28} {'15T':<8} {'prefix':<22} {'disk'}")
    for db, prefix, label in GAMES:
        present = "yes" if db in dbs else "no"
        print(
            f"{label:<22} {db:<28} {present:<8} {(prefix or '(pokemon)'):<22} {prefix_bytes(prefix)}"
        )
    extra = sorted(name for name in dbs if name.startswith("pokoin_") and name not in {g[0] for g in GAMES})
    if extra:
        print("other pokoin_*:", ", ".join(extra))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
