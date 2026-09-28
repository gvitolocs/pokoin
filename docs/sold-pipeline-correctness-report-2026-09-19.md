# CardTrader sold-history pipeline — correctness report (read-only audit)

Date: 2026-09-19 · Auditor scope: blueprint 115974 (Rapidash 13/112 FRLG, card_id 231948) + global.
No production data was mutated; no deploys. All SQL quoted was run read-only.

---

## 0. Headline answer

**The premise is true, with one refinement.** Pokoin *does* have a composite listing-equivalence
matcher (`public.cardtrader_same_seller_listing_stack`, schema/070 lines 165–201: seller id/name +
blueprint + condition + language + reverse + 1st-ed + graded; no price, no quantity). But it is not a
joinable identity over time — it is a **synchronous classifier evaluated once, at the instant an
archiving refresh notices a disappearance, against only the rows inside that same refresh payload**
(070 lines 504–532). There is no persistent "pending disappearance" state anywhere (verified: the
only CardTrader state tables are `cardtrader_market_listing_snapshots`, `..._removed_history`,
`..._blueprint_listing_cache`, `..._blueprint_population_daily`, `cardtrader_sold_daily`,
`cardtrader_seller_vacation`, user-listing twins). When the archiving refresh does not coincide with
the disappearance, one of two things happens:

- expansion dumps (the only thing scheduled daily) pass `byBlueprint=false`, so
  `shouldArchiveMissingSales` (api/_cardtrader_daily_listings_refresh.js:993–997) forces the
  archive flag off → vanished rows stay in `cardtrader_market_listing_snapshots` as **ghosts with no
  history row at all** (currently 194,825 rows / 662,054 copies across 33,541 blueprints with
  `last_seen_at < now()-48h`);
- when archiving *did* run (cutover replay Sep 12, pre-070 dump Sep 14), classifications were made
  once and frozen; the day-gated observation projection (070:838 `history.removed_day = v_removed_day`)
  never revisits old history, and every repair since has been a **manual, one-off sanitize script**
  (051/052/057/058/059/061/071/075/076).

So the equivalence system serves archive-instant classification and the manual sanitizers — not sale
recognition over time. Delayed confirmation is structurally impossible today: **there is nothing to
confirm with, and nothing scheduled to do the confirming.**

---

## A. Actual pipeline (end-to-end state machine as implemented)

```
CardTrader GET /marketplace/products?expansion_id=…        (Oracle VM, cardtrader-oracle-api)
  nightly 01:00 UTC, systemd pokoin-cardtrader-daily-market-refresh.timer
  → scripts/run-cardtrader-daily-market-refresh.sh
      --by-expansion --complete-book --finalize
      (byBlueprint=false; archiveMissing defaults true but is neutralized below)
  → api/_cardtrader_daily_listings_refresh.js :: runRefresh → fetchMarketplaceRowsForExpansion
      rows normalized by normalizeCardTraderMarketProduct (line 444–479)
  → persistFetchedRows (line 999)
      effective archiveMissing = shouldArchiveMissingSales(options, fetched)   ← line 993:
          archiveMissing && !truncated && byBlueprint    ← byBlueprint=false ⇒ FALSE, always
  → SQL public.refresh_cardtrader_market_listing_snapshots (migration 070; live DB verified:
      prosrc contains listing_id_rotated/quantity_decreased, one tx, advisory lock 872014433)
      1. same-id quantity drop  → removed_history row archive_reason='quantity_decreased',
         quantity = old−new delta, metadata prev/current       (070:379–450; NOT gated by archive flag)
      2. vanish archive + DELETE of vanished snapshot rows     (070:452–598) — only when
         p_archive_missing=true ⇒ NEVER on the expansion dump. Ghosts accumulate instead.
         (When it does run:) reason CASE 070:504–532:
            'listing_id_rotated'  if a same-stack successor exists in THIS payload
                                  (cardtrader_same_seller_listing_stack, 070:165–201)
            'seller_on_vacation'  (cardtrader_seller_is_on_vacation)
            'inferred_sale'       otherwise
      3. upsert incoming rows into snapshots (PK provider+external_listing_id, 070:606–673)
      4. observation projection (070:771–853): removed_history → marketplace_price_observations
         source='cardtrader_removed_sale', source_item_id =
         'cardtrader:<listing_id>:<removed_day>:<archive_reason>'
         GATED ON history.removed_day = v_removed_day (v_removed_day = "yesterday", JS default
         removedDayForRefreshDate) AND cardtrader_market_is_sale_reason(reason)
         (= inferred_sale | quantity_decreased | missing_from_cardtrader_market_snapshot, 026:98–108)
         AND blueprint ∈ this refresh's scope.
      5. finalize (p_finalize) → refresh cache, analytics, price summary
  → finalizeDailyRefresh (JS:733) → finalize_cardtrader_daily_market_refresh (070:882)
      → annotate observations (042 — annotates only, never creates)
      → vacation reclass (075)
      → refresh_cardtrader_sold_daily(v_day) (071 version, live): DELETE+rebuild sold_daily for
        v_day from observations where reason ∈ ('inferred_sale','quantity_decreased');
        inferred_sale observed < '2026-09-13' hard-excluded (071:185–188);
        "sold-once" CTE: listing_id appearing on >1 distinct obs-day is flicker → excluded
        (071:172–180); inferred_sale additionally requires the id absent from snapshots (071:198–204)
  → Pi streaming replica → GET /api/marketplace-card-sales (api/marketplace-card-sales.js:
      cardtrader_sold_daily slices + same sold-once SQL duplicated at lines 462–474)
  → SPA market/src/sold-sales-cache.js (localStorage 'pokoin.cardSales.v11.*', 15-day TTL)
  → desk graph (market/src/pages/Card.jsx SoldGraph)
```

State vocabulary that actually exists:

| Concept | Where it lives today |
| --- | --- |
| present | `cardtrader_market_listing_snapshots` row (stale ghosts **not distinguishable** from live) |
| suspected_missing | implicit only: ghost row with old `last_seen_at`; no flag, no consumer |
| pending_authoritative_confirmation | **does not exist** (no table, no queue, no TTL store) |
| matched_successor | implicit, ephemeral: computed inside one CASE branch at archive instant; no persisted link old-id→new-id |
| confirmed_absent | `removed_history` row (terminal; also written for non-sale reasons) |
| inferred_sale | `removed_history.archive_reason='inferred_sale'` + a day-gated observation; post-cutover **never produced** |
| reappeared/relisted | implicit: snapshot row re-created (first_seen reset); history row untouched; no invalidation link |
| explicitly_removed_or_unknown | reasons `dump_miss`, `dropped_from_cheapest_25`, `complete_book_cutover`, `seller_on_vacation` |

Compared to the robust model in the request: everything between "ordinary snapshot misses listing"
and "authoritative response arrives" is missing, and steps 5–8 of that model (equivalent-fingerprint
search at T2, quantity reconciliation, immutable evidence) exist only inside the single atomic
archive CASE.

## B. Invariants currently enforced

| Invariant | Where | Status |
| --- | --- | --- |
| Dump disappearance ⇒ not a sale (D000041) | `shouldArchiveMissingSales` (JS:993) requires `byBlueprint`; comment JS:1003–1006; SQL delete gated by `p_archive_missing` (070:452,585) | ✅ enforced (over-enforced: nothing else ever confirms) |
| quantity_decreased is a sale-shaped event without full vanish | 070:379–450, writes delta + prev/cur metadata | ✅ |
| Vacations are not sales | vacation freeze in refresh (070:445–446, 527–530, 576–579) + 075 reclass in finalize | ✅ |
| Same-stack successor ⇒ not a sale (anti-false-positive) | 070:504–526 at archive time; sanitizer 071 retro-fixes (manual) | ⚠️ only at archive instant / by manual script |
| Sold-once (anti-duplicate) | once_sold CTE 071:172–180 (key: **CardTrader listing id, count of distinct obs-days = 1**, quantity_decreased excluded) + still-in-snapshots check 071:198–204 + API copy 462–474 | ⚠️ keyed on raw listing id, no generation; currently vacuous (0 non-qty observations exist) |
| Observation idempotency | not-exists on `source_item_id` (070:848–853) | ✅ |
| sold_daily idempotency | delete+rebuild per day (071:113–118) | ✅ |
| Single writer | flock -n on Oracle + advisory lock 872014433 (JS:122–169, 070 refresh call) | ✅ for persist; finalize is a separate later transaction (see C5) |
| Liveness: pending ⇒ eventually resolved | — | ❌ **violated by construction** (no pending state, no queue, no re-scan) |

## C. Violations / incoherences

**C1 (critical, false negatives, systemic): full vanishings of grouped blueprints are never recorded.**
Expansion dumps run with `byBlueprint=false` ⇒ archive+delete disabled (JS:993–997; verified live on
Oracle: Sep 18 01:00 run logs `byBlueprint: false, archiveMissing: true, completeBook: true`;
`shouldArchiveMissingSales` present in deployed code at line 993). The only byBlueprint scheduler
(`pokoin-cardtrader-market-refresh-worker`) is **inactive**, and it would have covered ungrouped
blueprints only (worker:331–360). DB evidence: post-Sep-13 `removed_history` = 21,759
quantity_decreased + reclass-tagged Sep-13 artifacts, **zero inferred_sale** (max removed_day for
inferred_sale = 2026-09-11); 194,825 ghost snapshot rows (662k copies, 33,541 blueprints) with
`last_seen_at` >48h old and no history row. sold_daily September is 100% quantity_decreased
(17,814 blueprints, 87,219 copies). The desk sold graph currently measures only same-id partial
quantity drips; the dominant real-world sale shape (qty-1 listing vanishes) is invisible.

**C2 (critical, stale-unresolved): one true Rapidash candidate exists and is unresolvable by the
machine.** `375012097` (DRaconis, Played/it, €5.08, qty 1): first seen Sep 1, last seen Sep 11
14:31, archived by the Sep 12 13:51 byBlueprint cutover replay as `inferred_sale`,
`removed_day=2026-09-11`. Its observation was either never projected or deleted by 051:136–138
(`delete … like 'cardtrader:%:2026-09-11:inferred_sale'` — "History rows stay", 051:8). sold_daily
additionally excludes pre-Sep-13 inferred_sale (071:185–188). The seller has fully exited the
blueprint (no same-stack row today; verified). Net: a likely genuine sale that no automated path
can ever count. Root mechanism: day-gated projection (070:838) + terminal history + manual sanitizers.

**C3 (high, stale-unresolved + classification debt): `removed_day` is "detection day − 1", not sale
day.** `removedDayForRefreshDate()` (JS:66–75) and the archive insert stamp the day the *archiver*
ran; a ghost archived weeks late would be attributed to the wrong day. Any future confirmation pass
inherits this misattribution.

**C4 (high, false negatives): rotation swallows quantity.** When an id vanishes but a same-stack
successor exists, the full old quantity is archived as `listing_id_rotated` (not a sale) and the
successor starts fresh at its own qty. Case qty 4 → successor qty 3 is one real sale, counted 0.
(Conservative — no false positives — but systematically under-counts; the matcher deliberately
ignores quantity, 070:165–201, and nothing reconciles the delta across the id change.)

**C5 (medium, crash window): persist and finalize are separate transactions.** History rows for
removed_day D are written inside the persist tx; observations are projected at finalize with
`v_removed_day` defaulting to "yesterday". If a run dies after persist and before finalize, or
finalize runs with a shifted day, the D observations are never created — and nothing retries
(day-gate 070:838). The Sep 11/12 cutover + 051/059 deletions are the realized version of this.

**C6 (medium, over-broad dedup risk): sold-once is keyed on the raw CardTrader listing id.**
A listing that legitimately reappears and later sells would have observations on ≥2 distinct days →
once_sold kills both (071:172–180, API 462–474). Currently dormant (0 non-quantity observations
exist in the whole table) but structural. Also `removed_history` conflict target
`(provider, external_listing_id, removed_day)` means two same-day episodes of one id collapse.

**C7 (low, data hygiene): contradictory state demonstrated.** `444258301` has a Sep 9 history row
(`dropped_from_cheapest_25`, tag `listing_still_in_snapshots` from 052) while the listing was live —
cheap-25-era archive without the snapshot delete — and it is still listed today at €13.71.

## D. Rapidash 115974 — September trace (all 14 removed_history rows, 12 unique ids)

Book context: population_daily flips 25 listings/23 sellers (Sep 6–10, cheap-25 cap) → 53/44
(Sep 11, complete book) → 52/42 (Sep 18). Current cache: 42 eligible listings/44 units, cheapest
€4.83 = 1,166 PKN.

| listing id | seller | cond/lang | price | qty | first/last seen | removed_day | detected by (refreshImportedAt) | final reason | reclass tag | back in book? | same-stack today? | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 440234245 | GoldLionGames (US) | NM/en | 80.33 | 1 | 09-11/09-12 | 09-12 | pre-070 dump era → 059 | complete_book_cutover | 2026-09-12_complete_book_remainder | ✅ 09-14, same id, €80.89 | ✅ live | not a sale (reappearance proves it) |
| 375012097 | DRaconis | Played/it | 5.08 | 1 | 09-10/09-11 | **09-11** | **Sep 12 13:51 byBlueprint replay** | **inferred_sale** | — | ❌ never | ❌ seller exited | **genuine candidate; observation deleted by 051:136–138; sold_daily excludes pre-09-13 inferred_sale (071:185). C2** |
| 424724537 | Raritex | Poor/it | 5.09 | 1 | 09-02/09-10 | 09-10 | 03:21 nightly (cheap-25 era) | dropped_from_cheapest_25 | cheap25_left_window_not_sold (061) | ❌ | ❌ stack gone | genuine candidate, unrecorded (C1-era artifact) |
| 435948660 | Raritex | MP/it | 6.04 | 1 | 09-02/09-10 | 09-10 | 03:21 nightly | dropped_from_cheapest_25 | cheap25_left_window_not_sold | ❌ | ❌ stack gone | genuine candidate, unrecorded |
| 444254301* | Alzatebrianza | SP/it | 13.71 | 1 | 09-09/09-09 | 09-09 | 03:21 nightly | dropped_from_cheapest_25 | listing_still_in_snapshots (052) | ✅ 09-11, live €13.71 | ✅ | not a sale (C7 contradiction) |
| 445374079 | Valle97 | Poor/it | 4.52 | 1 | 09-01/09-06 | 09-08 | 06:16 nightly | dropped_from_cheapest_25 | cheap25_left_window_not_sold | ❌ | ❌ | genuine candidate, unrecorded |
| 375012097 | DRaconis | Played/it | 5.08 | 1 | 09-01/09-04 | 09-04 | 03:25 nightly | dropped_from_cheapest_25 | cheap25_left_window_not_sold | (re-appeared 09-10, see above) | — | earlier episode of the same id; flicker, not a separate sale |
| 448230769 | NordicCollect | MP/en | 13.41 | 1 | 09-03/09-03 | 09-03 | 03:28 nightly | dropped_from_cheapest_25 | cheap25_left_window_not_sold | ❌ | ❌ | genuine candidate, unrecorded |
| 419582940 | Retrogametcg | SP/it | 11.21 | 1 | 09-01/09-03 | 09-03 | 03:28 nightly | dropped_from_cheapest_25 | cheap25_left_window_not_sold | ❌ | ❌ | genuine candidate, unrecorded |
| 440733392 | Pokedk8736 | Poor/en | 5.11 | 1 | 09-02/09-02 | 09-02 | 03:24 nightly | dropped_from_cheapest_25 | cheap25_left_window_not_sold | ❌ | ❌ | genuine candidate, unrecorded |
| 315899127 | Multiverse of Games | SP/it | 13.66 | 1 | 09-01/09-01 | 09-01 | 03:23 nightly | dropped_from_cheapest_25 | — | ✅ 09-04, live | ✅ | not a sale |
| 417422333 | DwightPollo | SP/it | 13.70 | 1 | 09-01/09-01 | 09-01 | 03:23 nightly | dropped_from_cheapest_25 | — | ✅ 09-04, live | ✅ | not a sale |
| 431641638 | CerberusTCG | SP/it | 13.71 | 1 | 09-01/09-01 | 09-01 | 03:23 nightly | dropped_from_cheapest_25 | — | ✅ 09-05, live | ✅ | not a sale |
| 444258301 | Alzatebrianza | SP/it | 13.71 | 1 | 09-01/09-01 | 09-01 | 03:23 nightly | dropped_from_cheapest_25 | — | ✅ (same row as 09-09 entry) | ✅ | not a sale |

(*typo guard: 444254301 above = 444258301.)

Pending candidate rows created: **none** — the concept does not exist. Later complete fetches: only
the Sep 12 13:02–13:51 byBlueprint cutover replay ever re-examined this blueprint (journal, Oracle);
nothing since Sep 14. Fingerprint results survive only as the archive_reason text chosen at that
instant. Reappearance handling: re-created snapshot rows with reset `first_seen_at`; no link to the
history row, no invalidation step — correct outcomes here are accidental (the ids simply returned).

**Bottom line for September: 0 sales counted; ≥6 vanish events (5 sellers' stacks gone with no
successor, excluding the two flicker episodes of 375012097) are plausibly real sales that the
pipeline cannot count, plus 1 (`375012097`/09-11) that is even tagged `inferred_sale` in history but
is dead everywhere downstream.**

## E. Coverage analysis — why 31 FRLG printings have sold data and 115974 has none

- 122 FRLG printings; **31** with September sold rows, **84** with history but zero sold rows, rest
  no history at all.
- All 31 are fed **exclusively** by `quantity_decreased` observations (45 obs / 50 copies; e.g.
  Rattata 77/112 "4 sold" = 4 copies dripped out of still-live stacks; Bulbasaur 55/112's id
  429486286 went qty 2→1 with prev/cur in metadata). This event type is produced by the daily dump
  regardless of the byBlueprint gate (070:379–450) — the only sale-shaped channel still alive.
- Rapidash simply had no same-id partial drips; its churn was full-stack vanishes — the channel that
  is switched off. Same pattern globally: sold_daily September = 100% quantity_decreased.

## F. Root cause

**Primary:** architectural collapse of "detect disappearance" and "authoritatively confirm sale" into
one atomic step that additionally requires `byBlueprint` scheduling (JS:993–997 + 070:452). Because
the scheduled daily job is expansion-mode, the confirmation step never runs, and because nothing
persists a pending state, delayed confirmation is impossible — not merely unscheduled. D000041's
safety rule (docs/MARKET.md; schema/076 header; JS comment 1003–1006) is correctly enforced but has
no liveness counterpart.

**Secondary:** (a) day-gated observation projection (070:838) makes any missed finalize permanent;
(b) repair strategy is per-incident manual sanitizers with hardcoded dates (051:136–138, 059:17,
071:187) rather than a resolution engine — these also delete evidence while keeping classifications;
(c) `removed_day` = detection-day−1 semantics; (d) sold-once keyed on bare listing id without a
generation/episode; (e) rotation swallows quantity deltas (C4); (f) ghosts pollute the live-book
table that also feeds the listing cache (indistinguishable from present).

## G. Proposed minimal correction (preserves D000041 safety)

1. **Persist the pending state.** New table `cardtrader_listing_absence_candidates`:
   `(provider, external_listing_id, blueprint_id, seller_account_id, condition, language,
   is_reverse, is_first, is_graded, price_cents, currency, quantity, properties, raw_metadata,
   first_seen_at, last_seen_at, detected_at, status pending|matched_successor|confirmed_absent|
   invalidated_reappeared, resolved_at, evidence jsonb)` with PK
   `(provider, external_listing_id, detected_at)` (episodic generations kept distinct).
   In `refresh_cardtrader_market_listing_snapshots`, on **every** refresh (dump included): rows in
   scope absent from the incoming payload move to candidates (status pending) and out of snapshots —
   this simultaneously cleans ghosts from the live book/cache. Reappearance (id present again)
   resolves the open candidate as `invalidated_reappeared`.
2. **Keep sale inference authoritative-only (D000041 intact):** only a byBlueprint,
   untruncated, complete-book response may resolve pending → `confirmed_absent` and emit an
   `inferred_sale` observation. At resolution, search the authoritative payload: original id →
   present; else `cardtrader_same_seller_listing_stack` successor → `matched_successor` (optionally
   emit a quantity_decreased-style delta event when successor qty < old qty, fixing C4); else
   confirmed sale with `observed_at = last_seen_at`'s date (or detected day) and immutable evidence
   (payload excerpt + refresh job id).
3. **Make the dump enqueue confirmations.** The dump already visits every expansion daily; when it
   creates/pends candidates for a blueprint, upsert that blueprint_id into a small
   `cardtrader_blueprint_confirm_queue` (dedup, attempt_count, backoff, last_error). Drain it
   (worker or the same Oracle API) at bounded CardTrader rate; failures increment backoff — never
   drop. This is the liveness fix: disappearance ⇒ guaranteed eventual authoritative GET.
4. **Remove the day gate for resolution:** projection of a *resolved* candidate writes its
   observation at resolution time (evidence carries the day), so `removed_day`/finalize timing can
   no longer orphan events; keep `removed_day` purely historical.
5. **Key sold-once per generation:** extend once_sold to
   `(external_listing_id, min(removed_day) of the episode)` or simply keep observations unique per
   candidate episode (PK above) — a relisted-and-later-sold id must be countable again.
6. sold_daily and the API need no structural change (they already read observations), but drop the
   hardcoded pre-2026-09-13 exclusion once history is re-derived from candidates.

This is a strict superset of today's behavior: the CASE branch stays, but its inputs persist and its
verdict becomes revisitable.

## H. Backfill possibility

**Mostly yes for Rapidash, and partially globally — with explicit limits.**

Safe to backfill (evidence complete and persistent):
- removed_history rows carry the full fingerprint (seller id/name, condition, language, price,
  cents, currency, properties, raw_metadata) — verified for all 14 rows; current book is in
  snapshots (refreshed daily) and a fresh blueprint GET is authoritative.
- Cases where the id is absent from snapshots today, no same-stack successor exists for the seller
  (071-style check), seller not on vacation, and the row is not tagged as artifact
  (`complete_book_cutover`, `cheap25_left_window_not_sold` + reappeared, `listing_still_in_snapshots`,
  `dump_miss`): Rapidash ⇒ 375012097 (Sep 11), 424724537 + 435948660 (Sep 10), 445374079 (Sep 8),
  448230769 (Sep 3), 419582940 (Sep 3), 440733392 (Sep 2) — 7 events. Emit one inferred_sale
  observation each, attributed to `removed_day` (or `last_seen_at::date`), with evidence jsonb.
  Caveat: pre-cutover rows for cheap-25-tagged ids whose stacks never returned are "probable sales
  with wider uncertainty" (they left a 25-trimmed view, not a proven whole-book absence) — decide
  policy: mark them `sample_kind='cheap25_exit'` rather than silently blending.
Must remain unknown:
- 440234245 (reappeared same id), 444258301 (was never really gone), 315899127/417422333/431641638
  (reappeared, same stack live) — not sales.
- Any day-precision beyond the [last_seen, first_confirmed_absent] interval: inter-day books were
  not retained pre-cutover (cheap-25 era only kept 25 rows/blueprint; population_daily is
  blueprint-level). Sale *day* is unknowable; only the interval is.
- Quantities that dripped through unobserved same-id decreases during gap days (Sep 6–7 have no
  observations at all — the dump did not run/project those days).
- Any case where the listing id already has (or would get) observations on 2+ distinct days:
  the once_sold rule would nuke the plot; backfills must respect generation keying (G5) first.
  Example: 375012097 has TWO history rows (Sep 4 + Sep 11); only the terminal Sep 11 episode may be
  backfilled.

## I. Test plan

Unit level (existing harness `api/*.test.js`; SQL functions via a throwaway Postgres + pgTAP or a
temp-schema fixture runner; no production):

1. `shouldArchiveMissingSales` — expansion mode never archives even with archiveMissing=true;
   truncated byBlueprint never archives (JS test, file exists: `_cardtrader_daily_listings_refresh`
   exports it).
2. Rotation/same fingerprint → no sale: seed snapshots id A + successor id B, same seller/cond/lang
   flags, run refresh → A gets `listing_id_rotated`, 0 observations.
3. Genuine disappearance via byBlueprint complete fetch → exactly 1 `inferred_sale` observation,
   source_item_id `cardtrader:A:<day>:inferred_sale`, quantity = old qty.
4. **Delayed confirmation (the new liveness test):** create pending candidate on day D; run the
   authoritative byBlueprint refresh on day D+5 without the listing → candidate resolves, observation
   created, evidence persisted; rerun → idempotent (no second observation).
5. Disappearance then reappearance → candidate resolves `invalidated_reappeared`; no observation.
6. Disappearance / reappearance / later genuine sale → second episode yields its own candidate and,
   on later authoritative absence, its own observation (sold-once must not block: generation keying).
7. Quantity 4 → 3 same id → one `quantity_decreased` event with quantity=1, prev=4, cur=3.
8. ID rotation + qty 4→3 → matched_successor + one delta event quantity=1 (G2 behavior; today this
   is the C4 gap — test documents the target).
9. Two identical offers by one seller (same stack, two ids) → both vanish, one successor id appears
   → both matched_successor, no sales; successor later vanishes with no successor → exactly 1 sale.
10. Price mutation alone (same id) → no sale, no event (price not part of identity; upsert only).
11. Currency handling: price_cents/currency preserved; PKN conversion via
    `marketplace_price_pkn_from_cardtrader` non-null gate verified.
12. CardTrader API failure/timeout during confirmation → candidate stays pending, attempt_count+1,
    backoff respected; no observation; no snapshot deletion race (persist tx atomicity).
13. Pagination/incomplete response (`truncated=true`) → never confirms absence, never deletes.
14. Repeated confirmation fetches idempotent (same payload twice → one observation; snapshot rows
    stable; candidate counts stable).
15. sold_daily rerun idempotent for a target day (delete+rebuild equality).
16. Crash between persist and finalize → next resolution pass still resolves pending (no day-gate
    orphan) — regression test for C5.
17. Blueprint not refreshed for N days, then refreshed → all episodes resolved in one pass (bulk
    resolution, ordering by detected_at).
18. Two simultaneous workers → advisory lock serializes; second worker no-ops (existing flock +
    lock 872014433; add integration test).
19. Vacation seller vanish → `seller_on_vacation`, frozen, never sold; on return, re-classified.
20. API contract: `/api/marketplace-card-sales` slice filters (condition/language/reverse/1st/graded)
    return exactly the sold_daily rows for the fixture; duplicated SOLD_ONCE SQL stays consistent
    with the sold_daily CTE (extract to shared SQL or test both).

## J. Explicit answer to the closing question

"Why does Pokoin have a composite listing-equivalence system if a listing that disappears before the
right by-blueprint fetch can apparently never be recognized as sold later?"

Because the matcher was built to answer a different, narrower question — "at the moment I am forced
to archive this vanished row, is there a successor standing in the same payload right now?" — and it
does that well (plus it powers the manual sanitize passes). It was never wired into a persistent
identity join, so it cannot answer "does the economic listing represented by this old record exist in
the book I fetched today?". The trace proves the consequence: Rapidash 375012097 is tagged
`inferred_sale` in history (the matcher *did* run and found no successor on Sep 12), yet the sale is
unreachable because the observation projection is day-gated, the sanitizers deleted the Sep 11
evidence, and sold_daily excludes that period by hardcoded dates. The equivalence data needed to
resolve it correctly still sits in `removed_history` and `cardtrader_market_listing_snapshots` —
the pipeline just has no step that looks.

---

# ADDENDUM — same day, policy reversal (Codevira D000070 supersedes D000041)

Giuseppe 2026-09-19 reversed the product default: **disappearance from a VALID market observation is
an inferred sale unless stored evidence shows continuity or the observation is invalid.** D000041's
strict reading is outdated as a product rule; it survives only as the observation-validity
requirement. Section A–J above describe the OLD intended behavior — the corrected model and the
measured data are:

- **September vanish-row classes** (389,077 vanish rows in removed_history, writer DB):
  SAFE_INFERRED_SALE_CANDIDATE 88,598 rows / 149,023 units (never returned, no stack continuity,
  seller not on vacation, pre-cutover days) · REAPPEARED_SAME_ID 113,328 / 253,970 ·
  CONTINUITY_STACK_LIVE 15,529 / 29,279 · SUPPRESSED_VACATION 59 / 86 ·
  INVALID_CUTOVER_ARTIFACT (removed_day Sep 11–13) 171,563 / 682,096.
- **Reappearance dynamics**: 32,208 ids had 2+ vanish episodes in September (median gap 4d, p90 8d,
  max 16d); same-id reappearances are front-loaded (~68% within ~6 days, ~95% within ~12d) → a
  bounded correction window of ~10 days captures the overwhelming majority.
- **Validity evidence**: Beedrill ex 389944 Sep 16→17 (1,277→345, recovered 1,294 next day) had ZERO
  vanish events and rising listing/seller counts → invalid observation, must fire 0 sales. Grass
  Energy 111246 Sep 15→16 (3,770→2,925, no recovery) had ZERO events too (post-cutover gate), but the
  disappearance is fully reconstructable from 19 ghost snapshot rows / 847 qty / 4 sellers with
  `last_seen_at = Sep 15`. The client (api/_cardtrader_client.js:61–74) does a single unpaginated GET
  with no completeness validation — validity gating must be added, not assumed.
- **Stack-quantity reconciliation is the missing matcher half**: existence of ANY same-stack sibling
  currently classifies a vanish as `listing_id_rotated` even when the stack's total quantity dropped
  (split stacks, bulk trims) — under the corrected model that must emit `inferred_sale(delta)`.
