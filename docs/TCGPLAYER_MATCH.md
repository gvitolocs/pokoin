# TCGplayer product matcher

CardTrader supplies explicit `tcg_player_ids` for 45,967 of the 69,740
Pokémon singles. `pokoin-tcgplayer-match` (Rust, `pokoin-rust/apps/tcgplayer-match`)
links the remaining western and Japanese printings to TCGplayer products. It
writes to the same crosswalk the desk, Poko and the pricer already read:
`pokoin_product_links` in the `tcgprices` database (see [TCGCSV_PRICES.md](TCGCSV_PRICES.md)).

## Crosswalk column

`pokoin_product_links.match_source` records who owns a row:

| value | writer | meaning |
| --- | --- | --- |
| `cardtrader` | `tcgprices/sync_pokoin_links.py` | CardTrader `tcg_player_ids` or the reviewed `verified_product_links.json` |
| `pokoin-matcher` | `pokoin-tcgplayer-match --apply` | set group + collector number + name match |

The daily CardTrader sync only retires `cardtrader` rows. The matcher retires
and rewrites only its own rows, under the same advisory lock (817482942). It
never links a card that already has an active CardTrader link. When CardTrader
later supplies an explicit id, the next run drops the matcher row for that card.

## Rules (precision first)

1. **Category.** Expansion nationality `western`/`american` → TCGplayer
   *Pokemon* (3); `japanese` → *Pokemon Japan* (85). Chinese, Korean,
   Indonesian, Thai and French printings are not on TCGplayer and stay unlinked.
2. **Set → groups**, in tier order:
   - *linked*: groups the expansion's CardTrader-linked cards already resolve to;
   - *named*: group title (minus its `SV3:` / `SM -` code) or set code equals
     the CardTrader expansion's;
   - *evidence*: the one group holding ≥3 and ≥40% of the expansion's
     (number, name) pairs, 1.5× ahead of the runner-up.
3. **Card.** Same normalized collector number (`Rare | 019/214` → `19`,
   `TG03` → `TG3`; a half-deck suffix `003h` falls back to `3`; 5+ digit
   catalog ids and `No.123` Pokédex numbers are not numbers), set totals must
   not contradict, then the name:
   exact (3) > same base name with level/variant/δ/☆ markers dropped (2) >
   TCGplayer variant name such as `(Pikachu Stamped)` (1, accepted only when it
   is the single product printed at that number in the tier). Unnumbered old
   JP printings match unnumbered products by exact name in linked/named groups only.
4. **Guards.** Ties stay `ambiguous`. A product that CardTrader already links
   to another printing (`product_taken`) or that two printings pick
   (`shared_product`) is never assigned.

## Measured (2026-10-16)

- 9,678 new links (9,477 Japanese, 201 western). Pokémon singles with a TCGplayer
  link went from 45,967 to 55,645. Load takes 0.7 s, matching 0.2 s, and the
  whole run with writes 1.3–1.5 s.
- Blind holdout against CardTrader's own ids: hiding every 10th linked card,
  3,576 of 3,577 agree (99.97%). Hiding every 5th whole expansion,
  4,681 of 4,685 agree (99.91%).

## Run

On nezopt (`scripts/pokoin-tcgplayer-match-env.sh`, installed as
`~/.local/bin/pokoin-tcgplayer-match-env`, builds the writer and tcgprices URLs
from the container env files without printing them):

```sh
pokoin-tcgplayer-match-env --out /tmp/tcgmatch                 # dry run: report + TSVs
pokoin-tcgplayer-match-env --holdout 10 [--holdout-sets] --out /tmp/h   # precision check
pokoin-tcgplayer-match-env --apply --out /home/nez/mnt/mybook/tcgprices/matcher
```

`tcgprices/daily_update.py` runs `--apply` right after `sync_pokoin_links.py`.
The binary is `~/.local/bin/pokoin-tcgplayer-match`
(`cargo build --release -p tcgplayer-match`). If it fails, the previous matcher rows stay
active. Outputs: `tcgplayer-matches.tsv` (one line per link, with both names
and numbers), `tcgplayer-unresolved.tsv` (status + candidate groups),
`tcgplayer-match-report.json`.

## Desk

`GET /api/tcgplayer-redirect?id=<public id>` reads `pokoin_product_links`
through `TCGCSV_DATABASE_URL` (the read-only `tcgcsv_pokoin_reader` role:
SELECT on `pokoin_product_links`, `latest_prices`, `pokoin_tcgplayer_latest`,
`default_transaction_read_only`). The desk's Silver **TP** pill
(`solid/src/components/desk/SilverHead.jsx`) opens that URL and falls back to
a TCGplayer search only when no row exists.
