#!/usr/bin/env python3
"""Pin leftover Japanese products Giuseppe marked jpko on /ocr.

English Jungle (ju), Fossil (fo), EX Holon Phantoms (hp) stay western.
Pokémon Jungle / Mystery of the Fossils / Holon Phantoms leftovers are JP.
Ascended Heroes stays western: leftover thumbs are English Mega ex boxes.
"""
from __future__ import annotations

import subprocess
import sys

JP_NAMES = [
    "Bastiodon the Defender",
    "Blastoise Battle Starter Deck",
    "Entry Pack",
    "Expansion Pack & Starter Pack No Rarity",
    "Fighting Quick Construction Pack",
    "Fire Quick Construction Pack",
    "Gengar VMAX High-Class Deck",
    "Gift Box Mew • Lucario",
    "Grass Quick Construction Pack",
    "Hanada City Gym",
    "Holon Phantoms",
    "Imprison! Gardevoir ex Constructed Standard Deck",
    "Intro Pack Bulbasaur",
    "Intro Pack Neo Chikorita",
    "Intro Pack Squirtle",
    "Kuchiba City Gym",
    "Leafeon Expert Deck",
    "Lightning Quick Construction Pack",
    "M Master Deck Build Box Power Style",
    "Magmortar Battle Starter Deck",
    "Master Kit",
    "Master Kit: Bulbasaur Quarter Deck",
    "Master Kit: Torchic Quarter Deck",
    "Melee! Pokémon Scramble",
    "Metagross Expert Deck",
    "Moonlit Pursuit",
    "Mystery of the Fossils",
    "Pokémon Jungle",
    "Pokémon-e Starter Deck",
    "Psychic Quick Construction Pack",
    "Quick Starter Gift Set 1998",
    "Raichu Battle Starter Deck",
    "Rockruff Full Power Deck",
    "Shockwave! Tyranitar ex Constructed Standard Deck",
    "T Promos",
    "Tamamushi City Gym",
    "Torterra Battle Starter Deck",
    "Water Quick Construction Pack",
    "Zygarde EX Perfect Battle Deck",
]

PSQL = [
    "docker", "exec", "-i", "pokoin-marketplace-postgres-15t",
    "psql", "-U", "pokoin_marketplace", "-d", "pokoin_marketplace",
    "-v", "ON_ERROR_STOP=1", "-At",
]
CLASSIFIER_MARKER = (
    "        'gym booster 2: challenge from the darkness'\n"
    "      )\n"
    "      then 'japanese'"
)
CLASSIFIER_INSERT = (
    "        'gym booster 2: challenge from the darkness',\n"
    + ",\n".join(f"        {name.lower()!r}" for name in JP_NAMES)
    + "\n      )\n      then 'japanese'"
)
REFRESH_MARKER = (
    "          'gym booster 2: challenge from the darkness'\n"
    "        ) then 'japanese'"
)
REFRESH_INSERT = (
    "          'gym booster 2: challenge from the darkness',\n"
    + ",\n".join(f"          {name.lower()!r}" for name in JP_NAMES)
    + "\n        ) then 'japanese'"
)


def psql(sql: str) -> str:
    proc = subprocess.run(PSQL, input=sql, text=True, capture_output=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        raise SystemExit(proc.returncode)
    return proc.stdout


def patch_fn(proname: str, args: str, marker: str, insert: str) -> None:
    defn = psql(
        "select pg_get_functiondef(oid) from pg_proc "
        f"where proname = {proname!r} "
        f"and pg_get_function_identity_arguments(oid) = {args!r};"
    ).strip()
    if "hanada city gym" in defn.lower():
        print(f"{proname} already pinned", flush=True)
        return
    if marker not in defn:
        raise SystemExit(f"{proname} missing gym booster marker")
    psql(defn.replace(marker, insert, 1) + ";\n")
    print(f"patched {proname}", flush=True)


def main() -> None:
    values = ", ".join("'" + name.replace("'", "''").lower() + "'" for name in JP_NAMES)
    patch_fn(
        "pokoin_expansion_nationality",
        "code text, name text",
        CLASSIFIER_MARKER,
        CLASSIFIER_INSERT,
    )
    patch_fn(
        "pokoin_refresh_expansion_nationality",
        "",
        REFRESH_MARKER,
        REFRESH_INSERT,
    )
    out = psql(f"""
begin;
set local statement_timeout = 0;
update public.pokoin_pokemon_expansions
set nationality = 'japanese',
    milo_gallery = public.pokoin_expansion_milo_gallery('japanese', kind),
    updated_at = now()
where lower(name) in ({values.lower()})
  and nationality is distinct from 'japanese';
select public.pokoin_refresh_expansion_nationality() as expansions_updated;
commit;
select name, code, nationality, milo_gallery, kind, listed
from public.pokoin_pokemon_expansions
where lower(name) in ({values.lower()})
order by name;
""")
    print(out, flush=True)


if __name__ == "__main__":
    main()
