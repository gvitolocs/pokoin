-- Full pass after 057 (exact live qty). CardTrader marketplace `product.id`
-- rotates when a seller edits a live stack. Persist keys snapshots on that id,
-- so the old id is archived inferred_sale at full qty while a new id appears
-- for the same seller+blueprint+condition+language+qty.
--
-- 1:1 daily id churn (new id almost every day, stable qty). If the seller
-- still has any listing of that facet, drop every day. If the stack is gone,
-- keep only the last day (possible real disappearance).
-- quantity_decreased stays. 11 Sep inferred_sale cutover stays excluded (051).

begin;
set local statement_timeout = 0;
set local lock_timeout = 0;
set local idle_in_transaction_session_timeout = 0;

create temporary table pg_temp.inferred_sale_rows as
select
  h.provider,
  h.external_listing_id,
  h.removed_day,
  h.blueprint_id,
  h.seller_account_id,
  h.condition,
  h.language,
  h.quantity,
  public.cardtrader_listing_is_reverse(h.properties, false, '') as is_reverse,
  public.cardtrader_listing_is_first_edition(h.properties, false) as is_first
from public.cardtrader_market_listing_removed_history h
where h.archive_reason = 'inferred_sale'
  and h.seller_account_id <> ''
  and h.removed_day is distinct from date '2026-09-11';

create index on pg_temp.inferred_sale_rows (
  blueprint_id, seller_account_id, condition, language, quantity, is_reverse, is_first
);

create temporary table pg_temp.listing_id_churn_stacks as
select
  blueprint_id,
  seller_account_id,
  condition,
  language,
  quantity,
  is_reverse,
  is_first,
  max(removed_day) as last_day
from pg_temp.inferred_sale_rows
group by 1, 2, 3, 4, 5, 6, 7
having count(distinct removed_day) >= 2
   and count(distinct external_listing_id) >= 2
   and count(distinct external_listing_id) >= count(distinct removed_day) - 1
   and count(*) <= count(distinct removed_day) + 1;

create index on pg_temp.listing_id_churn_stacks (
  blueprint_id, seller_account_id, condition, language, quantity, is_reverse, is_first
);

create temporary table pg_temp.live_stack_facets as
select distinct
  live.blueprint_id,
  live.seller_account_id,
  live.condition,
  live.language,
  public.cardtrader_listing_is_reverse(live.properties, false, '') as is_reverse,
  public.cardtrader_listing_is_first_edition(live.properties, false) as is_first
from public.cardtrader_market_listing_snapshots live
where live.provider = 'cardtrader'
  and live.seller_account_id <> '';

create index on pg_temp.live_stack_facets (
  blueprint_id, seller_account_id, condition, language, is_reverse, is_first
);

create temporary table pg_temp.listing_id_churn_targets as
select r.provider, r.external_listing_id, r.removed_day
from pg_temp.inferred_sale_rows r
join pg_temp.listing_id_churn_stacks s
  on s.blueprint_id is not distinct from r.blueprint_id
 and s.seller_account_id = r.seller_account_id
 and s.condition is not distinct from r.condition
 and s.language is not distinct from r.language
 and s.quantity = r.quantity
 and s.is_reverse is not distinct from r.is_reverse
 and s.is_first is not distinct from r.is_first
left join pg_temp.live_stack_facets live
  on live.blueprint_id is not distinct from s.blueprint_id
 and live.seller_account_id = s.seller_account_id
 and live.condition is not distinct from s.condition
 and live.language is not distinct from s.language
 and live.is_reverse is not distinct from s.is_reverse
 and live.is_first is not distinct from s.is_first
where r.removed_day < s.last_day
   or live.seller_account_id is not null;

delete from public.marketplace_price_observations o
using pg_temp.listing_id_churn_targets t
where o.source = 'cardtrader_removed_sale'
  and o.source_item_id = 'cardtrader:' || t.external_listing_id || ':' || t.removed_day::text || ':inferred_sale';

update public.cardtrader_market_listing_removed_history h
set
  archive_reason = 'listing_id_rotated',
  archive_metadata = coalesce(h.archive_metadata, '{}'::jsonb) || jsonb_build_object(
    'reclassifiedFrom', 'inferred_sale',
    'reclassifiedBecause', 'daily_product_id_churn'
  )
from pg_temp.listing_id_churn_targets t
where h.provider = t.provider
  and h.external_listing_id = t.external_listing_id
  and h.removed_day = t.removed_day
  and h.archive_reason = 'inferred_sale';

select public.refresh_cardtrader_sold_daily() as sold_daily_rows;
select public.refresh_marketplace_blueprint_price_summary(null) as price_summary_rows;

commit;
