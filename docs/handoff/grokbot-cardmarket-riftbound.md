# GrokBot handoff: Cardmarket prices without CardTrader's commission, and the new Riftbound cards

From: the Pokoin pricing session, 2026-10-21. For: GrokBot, working in Giuseppe's
signed-in Cardmarket account in his browser. **Do not submit anything on
Cardmarket until Giuseppe has confirmed the dry-run summary in step 3.**

## What changed and why

Pokoin's "CardTrader" prices used to be CardTrader asks: the price a seller
lists at. A seller does not receive that. CardTrader keeps a commission per
item sold, plus VAT on that commission (CardTrader, "Payments, fees and refunds",
<https://static.cardtrader.com/en/pages/payments-fees-and-refunds>, read 2026-10-21):

| EU seller | Direct sale | CardTrader Zero sale |
| --- | --- | --- |
| Subscriptions before March 2026 (guaranteed to active sellers until 2026-12-31) | 5.0 %, min €0.01 | 7.0 %, min €0.01 |
| Subscriptions from March 2026 | 5.3 %, min €0.01 | 7.3 %, min €0.01 |

VAT (22 % in Italy) is added to the commission. The buyer pays a separate
"CardTrader Safeguard" fee per item (€0.09–€0.64 by price). That is not part
of the seller's price and does not change it.

Pokoin now prices every CardTrader comp **net of the seller commission**:

```text
fee      = max(€0.01, ask × rate)        rate: 7 % for CardTrader Zero asks (Riftbound and every
                                          game except Pokémon), 5 % for the Pokémon professional floor
net      = ask − fee × 1.22              (22 % VAT on the commission)
```

Example: Blade Twirler (Vendetta 002, EN, NM), cheapest CardTrader Zero ask
€0.11. 7 % of that is €0.0077, so the €0.01 minimum applies; with VAT the fee
is €0.0122, and the net is €0.0978, which rounds to €0.10 (20 PKN; 200 PKN = €1).

## Part 1: the new Riftbound cards (list them on Cardmarket)

Card list: `grokbot-riftbound-cardmarket.csv`. It is in the shared notes folder
next to this handoff, and on nezopt at
`~/scratch/inventory-price-store/grokbot-riftbound-cardmarket.csv`. It has
84 Cardmarket articles, 1,391 copies, €140.23 in total. Columns:

| Column | Meaning |
| --- | --- |
| `card_name`, `set_name`, `collector_number` | The printing (all Vendetta, EN). |
| `language` | Pokoin code: `EN` = Cardmarket "English". |
| `cm_condition` | Cardmarket condition, already mapped (below). |
| `foil` | `t` = foil, `f` = non-foil. All rows are non-foil. |
| `quantity` | Copies Giuseppe has: one Pokoin listing per physical copy, grouped. |
| `price_eur` | **The price to list at, per copy**: the net CardTrader value above. |
| `cardmarket_url` | The product page, from Pokoin's verified link table (`marketplace_cm_verified_links`). Use it. Never pick a product by name search. |
| `pokoin_card_id`, `locations`, `pokoin_listing_ids` | Where the copies are (box·row·slot) and their Pokoin rows, for the report. |

Mapping used (Pokoin → Cardmarket): NM → NM, M → MT, SP/LP → EX, MP → GD, PL/HP → PL, PO → PO.
Language EN → English. Foil only when `foil = t`.

Not in the file, so do not list them:

- **91 copies of 14 cards on the Riftbound "Promos" printing.** On CardTrader that
  printing only has foil copies, but the Pokoin listings say non-foil. Giuseppe
  must check whether these copies are the Vendetta print or foil promos.
- **229 Battle Spirits Saga copies and 41 more Battle Spirits cards stored as
  "pokemon".** There is no CardTrader price for them.

## Part 2: update the existing Cardmarket prices

For each article already in Giuseppe's Cardmarket stock that is one of his
Pokoin listings (same product, language, condition, foil), set the price to the
fee-exclusive CardTrader value. Pokoin shows it on MyPokoin → Listings in the
CARDTRADER MARKET column once the change is live; the tooltip says
"Net of CardTrader's 7% seller fee + 22% VAT (ask N PKN)". PKN ÷ 200 = euro.

- The CSV of the recalculated values for the existing listings is generated
  only after Giuseppe approves the Pokoin side (see the session report). Do
  not reprice from a guess. If an article has no CardTrader value (`—` on
  Pokoin), leave its Cardmarket price alone and list it in the report.
- Never lower a price below €0.02 (Cardmarket's minimum). Never change a
  quantity in Part 2.

## Doing it without duplicates

1. **Read the current stock first.** Export Giuseppe's Cardmarket stock
   (Stock → Export, CSV) or read the Stock page of each product in the file.
   An existing article is the same product URL + language + condition + foil
   (+ signed/altered/first edition, all "no" here).
2. **Plan, per article key:**
   - absent → **add** it with `quantity` and `price_eur`;
   - present → **edit** that article: set the price, and raise its quantity
     only up to the file's `quantity`; never add a second article for the
     same key;
   - present more than once → touch none of them, and report it.
3. **Dry run first.** Send Giuseppe the plan: how many adds, how many edits,
   the copies, the euro total, and the first 10 rows. **Wait for his OK.**
4. **Run it once, in order, and record each key as you go** (added / edited /
   skipped and why). A key already recorded as done is never added again, so
   a retry after an interruption cannot double-list. If a submit is in doubt
   (timeout, page error), reload that product's stock and check before
   trying again.
5. Do not touch CardTrader or Pokoin. Pokoin pushes its own listings to
   CardTrader once each; Cardmarket is separate and only GrokBot writes it.

## What to report back

- Counts: articles added, edited, skipped (and why), copies listed, € total.
- Any product whose Cardmarket page did not match the row: wrong name,
  number or set, or no English option.
- Articles that already existed more than once.
- The record file (key → action → Cardmarket article id, if shown), so a later
  run can update the same articles instead of creating new ones.

## Open question for Giuseppe

His message was cut off after "…mettere le nuove carte riftbound su cardmarket
con quei …". This handoff assumes "con quei prezzi" (with those prices: the
fee-exclusive CardTrader values). If he meant something else (those quantities,
those locations, another markup), change the price rule before step 3.
