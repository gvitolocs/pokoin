-- Withdrawn joke-price listings are not sales.
--
-- A seller listed a 22 PKN Energy Retrieval (blueprint 111585, reverse NM EN)
-- at EUR 16,215.10 and removed it on 2026-09-22; the three-dump rule turned
-- the vanish into inferred_sale and cardtrader_sold_daily printed a
-- 3,243,020 PKN "sale". It put a 3.25M PKN spike on the seller dashboard of
-- everyone holding that card. Listing 449121679 (blueprint 139076, EUR
-- 10,001.64 for a card that sells at 200-1,216 PKN) is the same pattern.
--
-- Marking the history rows invalid keeps the daily refresh from projecting
-- them again (only confirmed|provisional rows project), then the observations
-- and those sold_daily days are rebuilt. The dashboard also ignores any sold
-- price above 20x the same variant's other sales (_portfolio_history_core.js).
-- Idempotent.

begin;

set local statement_timeout = 0;
set local lock_timeout = 0;
set local idle_in_transaction_session_timeout = 0;

update public.cardtrader_market_listing_removed_history h
set status = 'invalid',
    resolved_at = now(),
    archive_metadata = coalesce(h.archive_metadata, '{}'::jsonb) || jsonb_build_object(
      'reclassifiedBecause', 'withdrawn_joke_price_listing'
    )
where h.provider = 'cardtrader'
  and h.archive_reason = 'inferred_sale'
  and (h.external_listing_id, h.removed_day) in (
    ('428261086', date '2026-09-22'),
    ('449121679', date '2026-09-08')
  )
  and h.status in ('confirmed', 'provisional');

delete from public.marketplace_price_observations o
where o.source = 'cardtrader_removed_sale'
  and o.source_item_id in (
    'cardtrader:428261086:2026-09-22:inferred_sale',
    'cardtrader:449121679:2026-09-08:inferred_sale'
  );

select public.refresh_cardtrader_sold_daily(date '2026-09-22');
select public.refresh_cardtrader_sold_daily(date '2026-09-08');
select public.refresh_marketplace_blueprint_price_summary(id)
from unnest(array['111585', '139076']) as id;

commit;
