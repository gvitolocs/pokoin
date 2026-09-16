-- inferred_sale while the same seller stack is still in the live book is
-- listing_id_rotated, not a sold-graph point. Stack key is seller +
-- blueprint + condition + language + reverse / 1st / graded — not product
-- id and not equal quantity.
--
-- Coalossal Ascended Heroes 120/217 (leftover 370758): Pippo100 vanished
-- ids 422985453 (qty 1) and 424202669 (qty 2) on 13 Sep as inferred_sale
-- while six NM IT rows (14 copies) stayed listed from 1 Sep / 12 Sep.
-- 057 required live.quantity = vanished.quantity, so qty 2 stayed on the
-- graph. 15T persist also required the successor id to be *new* (not
-- already in snapshots), so sibling rows of a split stack did not rotate.
-- quantity_decreased stays. 11–12 Sep cutover inferred_sale stays out.
-- refresh_cardtrader_sold_daily does not seq-scan snapshots for live stacks
-- (4.5 GB heap + jsonb TOAST on 15T HDD). Stack rotation is persist 070
-- plus this sanitizer; sold_daily only drops inferred_sale whose listing id
-- is still in snapshots, plus pre-13 Sep inferred_sale.

begin;
set local statement_timeout = 0;
set local lock_timeout = 0;
set local idle_in_transaction_session_timeout = 0;

create temporary table pg_temp.live_seller_stacks as
select
  live.blueprint_id,
  live.seller_account_id,
  lower(btrim(live.condition)) as condition,
  lower(btrim(live.language)) as language,
  public.cardtrader_listing_is_reverse(live.properties, false, '') as is_reverse,
  public.cardtrader_listing_is_first_edition(live.properties, false) as is_first,
  public.cardtrader_listing_is_graded(live.raw_metadata, live.properties) as is_graded,
  min(live.first_seen_at) as first_seen_at
from public.cardtrader_market_listing_snapshots live
where live.provider = 'cardtrader'
  and live.seller_account_id <> ''
  and live.blueprint_id is not null
group by 1, 2, 3, 4, 5, 6, 7;

create index on pg_temp.live_seller_stacks (
  blueprint_id, seller_account_id, condition, language, is_reverse, is_first, is_graded
);

-- Sibling rows must already have been in the book when the id vanished.
-- A restock after a real sold-out (first_seen after removed_day) stays inferred_sale.
create temporary table pg_temp.same_stack_rotated as
select
  h.provider,
  h.external_listing_id,
  h.removed_day,
  h.blueprint_id,
  h.quantity
from public.cardtrader_market_listing_removed_history h
join pg_temp.live_seller_stacks live
  on live.blueprint_id is not distinct from coalesce(h.blueprint_id, h.cardtrader_blueprint_id)
 and live.seller_account_id = h.seller_account_id
 and live.condition = lower(btrim(h.condition))
 and live.language = lower(btrim(h.language))
 and live.is_reverse is not distinct from public.cardtrader_listing_is_reverse(h.properties, false, '')
 and live.is_first is not distinct from public.cardtrader_listing_is_first_edition(h.properties, false)
 and live.is_graded is not distinct from public.cardtrader_listing_is_graded(h.raw_metadata, h.properties)
 and (live.first_seen_at at time zone 'utc')::date <= h.removed_day
where h.provider = 'cardtrader'
  and h.archive_reason = 'inferred_sale'
  and h.seller_account_id <> '';

create index on pg_temp.same_stack_rotated (external_listing_id, removed_day);

select
  count(*) as events,
  coalesce(sum(quantity), 0) as qty,
  count(distinct blueprint_id) as blueprints
from pg_temp.same_stack_rotated;

delete from public.marketplace_price_observations o
using pg_temp.same_stack_rotated t
where o.source = 'cardtrader_removed_sale'
  and o.source_item_id = 'cardtrader:' || t.external_listing_id || ':' || t.removed_day::text || ':inferred_sale';

update public.cardtrader_market_listing_removed_history h
set
  archive_reason = 'listing_id_rotated',
  archive_metadata = coalesce(h.archive_metadata, '{}'::jsonb) || jsonb_build_object(
    'reclassifiedFrom', 'inferred_sale',
    'reclassifiedBecause', 'same_seller_stack_still_listed_any_qty'
  )
from pg_temp.same_stack_rotated t
where h.provider = t.provider
  and h.external_listing_id = t.external_listing_id
  and h.removed_day = t.removed_day
  and h.archive_reason = 'inferred_sale';

commit;

begin;
set local statement_timeout = 0;
set local lock_timeout = 0;
set local idle_in_transaction_session_timeout = 0;

create or replace function public.refresh_cardtrader_sold_daily(
  target_day date default null
)
returns integer
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
as $$
declare
  refreshed_count integer := 0;
begin
  perform set_config('statement_timeout', '0', true);

  if target_day is not null then
    delete from public.cardtrader_sold_daily
    where observed_day = target_day;
  else
    truncate public.cardtrader_sold_daily;
  end if;

  insert into public.cardtrader_sold_daily (
    blueprint_id,
    observed_day,
    condition,
    language,
    reverse,
    first_edition,
    graded,
    median_pkn,
    min_pkn,
    max_pkn,
    sold_qty,
    listings,
    sample_count,
    graded_comments,
    refreshed_at
  )
  select
    obs.blueprint_id,
    (obs.observed_at at time zone 'utc')::date as observed_day,
    public.cardtrader_sold_condition(obs.condition) as condition,
    public.cardtrader_sold_language(obs.language) as language,
    public.cardtrader_listing_is_reverse(
      coalesce(history.properties, '{}'::jsonb),
      obs.reverse,
      obs.foil_state
    ) as reverse,
    public.cardtrader_listing_is_first_edition(
      coalesce(history.properties, '{}'::jsonb),
      obs.first_edition
    ) as first_edition,
    obs.graded,
    percentile_cont(0.5) within group (order by obs.price_pkn) as median_pkn,
    min(obs.price_pkn) as min_pkn,
    max(obs.price_pkn) as max_pkn,
    coalesce(sum(obs.quantity), 0)::integer as sold_qty,
    count(*)::integer as listings,
    count(*)::integer as sample_count,
    case
      when obs.graded then coalesce(
        array_remove(array_agg(distinct nullif(obs.metadata->>'sellerComment', '')), null),
        '{}'::text[]
      )
      else '{}'::text[]
    end as graded_comments,
    now()
  from public.marketplace_price_observations obs
  left join public.cardtrader_market_listing_removed_history history
    on history.provider = split_part(obs.source_item_id, ':', 1)
   and history.external_listing_id = split_part(obs.source_item_id, ':', 2)
   and history.removed_day = (split_part(obs.source_item_id, ':', 3))::date
   and history.archive_reason = split_part(obs.source_item_id, ':', 4)
  left join (
    select split_part(source_item_id, ':', 2) as listing_id
    from public.marketplace_price_observations
    where source = 'cardtrader_removed_sale'
      and source_item_id like 'cardtrader:%'
      and split_part(source_item_id, ':', 4) is distinct from 'quantity_decreased'
    group by 1
    having count(distinct (observed_at at time zone 'utc')::date) = 1
  ) once_sold
    on once_sold.listing_id = split_part(obs.source_item_id, ':', 2)
  where obs.source = 'cardtrader_removed_sale'
    and obs.source_item_id like 'cardtrader:%'
    and split_part(obs.source_item_id, ':', 4) in ('inferred_sale', 'quantity_decreased')
    and not (
      split_part(obs.source_item_id, ':', 4) = 'inferred_sale'
      and (obs.observed_at at time zone 'utc')::date < date '2026-09-13'
    )
    and obs.price_pkn > 0
    and obs.blueprint_id is not null
    and (target_day is null or (obs.observed_at at time zone 'utc')::date = target_day)
    and public.cardtrader_sold_condition(obs.condition) is not null
    and public.cardtrader_sold_language(obs.language) is not null
    and (
      split_part(obs.source_item_id, ':', 4) = 'quantity_decreased'
      or (
        once_sold.listing_id is not null
        and not exists (
          select 1
          from public.cardtrader_market_listing_snapshots live
          where live.provider = 'cardtrader'
            and live.external_listing_id = split_part(obs.source_item_id, ':', 2)
        )
      )
    )
  group by
    obs.blueprint_id,
    (obs.observed_at at time zone 'utc')::date,
    public.cardtrader_sold_condition(obs.condition),
    public.cardtrader_sold_language(obs.language),
    public.cardtrader_listing_is_reverse(
      coalesce(history.properties, '{}'::jsonb),
      obs.reverse,
      obs.foil_state
    ),
    public.cardtrader_listing_is_first_edition(
      coalesce(history.properties, '{}'::jsonb),
      obs.first_edition
    ),
    obs.graded;

  get diagnostics refreshed_count = row_count;
  return coalesce(refreshed_count, 0);
end;
$$;

select public.refresh_cardtrader_sold_daily() as sold_daily_rows;
select public.refresh_marketplace_blueprint_price_summary(null) as price_summary_rows;

commit;
