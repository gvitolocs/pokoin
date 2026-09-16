#!/usr/bin/env python3
"""CREATE isolated 15T databases for non-Pokemon CardTrader ingest APIs.

Pokemon stays `pokoin_marketplace`. These DBs stream to the Pi replica.
Does not GET CardTrader. Does not write leftover JPEGs.
"""
from __future__ import annotations

import subprocess
import sys

PG = "pokoin-marketplace-postgres-15t"
USER = "pokoin_marketplace"
OWNER = "pokoin_marketplace"
DATABASES = (
    "pokoin_magic",
    "pokoin_yugioh",
    "pokoin_flesh_and_blood",
    "pokoin_digimon",
    "pokoin_dragon_ball_super",
    "pokoin_vanguard",
    "pokoin_one_piece",
    "pokoin_lorcana",
    "pokoin_star_wars",
    "pokoin_union_arena",
    "pokoin_riftbound",
    "pokoin_gundam",
    "pokoin_sorcery",
)


def psql(database: str, sql: str) -> str:
    proc = subprocess.run(
        ["docker", "exec", "-i", PG, "psql", "-U", USER, "-d", database, "-At"],
        input=sql.encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=30,
    )
    text = (proc.stdout or b"").decode().strip()
    err = (proc.stderr or b"").decode().strip()
    if proc.returncode != 0:
        raise RuntimeError(err or text or f"psql exit {proc.returncode}")
    return text


def main() -> int:
    apply = "--apply" in sys.argv
    existing = set(
        line.strip()
        for line in psql(
            "pokoin_marketplace",
            "SELECT datname FROM pg_database WHERE datistemplate = false;",
        ).splitlines()
        if line.strip()
    )
    planned = [name for name in DATABASES if name not in existing]
    print(f"existing={len(existing)} missing={len(planned)}")
    for name in DATABASES:
        state = "yes" if name in existing else "CREATE"
        print(f"  {name:<32} {state}")
    if not apply:
        print("dry-run; pass --apply to CREATE DATABASE on 15T")
        return 0
    for name in planned:
        ident = name.replace("'", "''")
        psql("pokoin_marketplace", f'CREATE DATABASE {ident} OWNER {OWNER};')
        print(f"created {name}")
    if not planned:
        print("nothing to create")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
