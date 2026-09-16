#!/usr/bin/env python3
"""Apply Qwen leftover-print CJK labels onto pokoin_pokemon_expansions.

Only japanese / chinese / korean. Never flip a set to western from Qwen
english. Never touch indonesian / thai / idth / french / german / american.
Pins leftover_print so pokoin_refresh_expansion_nationality keeps them.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

BOARD = Path("/home/nez/Projects/pokoin-web/market/public/review/ocr-expansions.json")
EXCLUSIVE = {
    "indonesian", "thai", "idth", "french", "german", "american", "product",
}
CJK = {"japanese", "chinese", "korean"}
PSQL = [
    "docker", "exec", "-i", "pokoin-marketplace-postgres-15t",
    "psql", "-U", "pokoin_marketplace", "-d", "pokoin_marketplace", "-v", "ON_ERROR_STOP=1",
]


def qwen_print_to_nationality(print_lang: str) -> str:
    value = str(print_lang or "").strip().lower()
    if value == "english":
        return "western"
    if value in CJK:
        return value
    return ""


def should_apply(nationality: str, print_lang: str) -> bool:
    db = str(nationality or "").strip().lower()
    if db in EXCLUSIVE:
        return False
    next_nat = qwen_print_to_nationality(print_lang)
    return next_nat in CJK and db != next_nat


def psql(sql: str) -> str:
    proc = subprocess.run(PSQL, input=sql, text=True, capture_output=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        raise SystemExit(proc.returncode)
    return proc.stdout


def main() -> None:
    board = json.loads(BOARD.read_text())
    rows = [
        row for row in board["expansions"]
        if row.get("ocr_junk") and should_apply(row.get("nationality"), row.get("qwen_print"))
    ]
    print(f"apply {len(rows)} of {len(board['expansions'])}", flush=True)
    for row in rows:
        print(f"  {row['name']} {row['nationality']} -> {row['qwen_print']}  {row.get('qwen_why')}", flush=True)

    defn = psql(
        "select pg_get_functiondef(oid) from pg_proc "
        "where proname = 'pokoin_refresh_expansion_nationality' "
        "and pg_get_function_identity_arguments(oid) = '';"
    ).strip()
    needle = (
        "when public.pokoin_expansion_nationality(e.code, e.name) = 'american' "
        "then 'american'"
    )
    insert = (
        needle
        + "\n        when e.leftover_print in ('japanese', 'chinese', 'korean') "
        "then e.leftover_print"
    )
    if "e.leftover_print in" not in defn:
        if needle not in defn:
            raise SystemExit("refresh function missing american pin; refuse to patch")
        defn = defn.replace(needle, insert, 1)

    values = []
    for row in rows:
        eid = int(row["expansion_id"])
        nxt = qwen_print_to_nationality(row["qwen_print"])
        values.append(f"({eid}, {json.dumps(nxt)})")

    sql = """
begin;
set local statement_timeout = 0;
alter table public.pokoin_pokemon_expansions
  add column if not exists leftover_print text not null default '';
"""
    if values:
        sql += f"""
update public.pokoin_pokemon_expansions e
set leftover_print = v.print,
    nationality = v.print,
    milo_gallery = public.pokoin_expansion_milo_gallery(v.print, e.kind),
    updated_at = now()
from (values {", ".join(values)}) as v(expansion_id, print)
where e.expansion_id = v.expansion_id;
"""
    sql += f"""
{defn};

select public.pokoin_refresh_expansion_nationality() as expansions_updated;
commit;
"""
    print(psql(sql), flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    main()
