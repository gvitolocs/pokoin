-- Cheap-25 inferred_sale (through 10 Sep) is leftover stacks that left the
-- 25-wide window, not sold units. Persist keyed snapshots on CardTrader
-- product.id, so a price edit archived the old id at full qty while the
-- seller still listed the card. Psyduck Ascended Heroes (public 741354)
-- plotted 121 copies on 8 Sep from one inferred_sale row.
-- 11–12 Sep complete-book cutover already dropped those days. Keep
-- quantity_decreased. From 13 Sep, complete-book inferred_sale may stand
-- when the listing id is gone and no same-seller successor id appeared.
-- SPA cache pokoin.cardSales.v8.

begin;
set local statement_timeout = 0;
set local lock_timeout = 0;
set local idle_in_transaction_session_timeout = 0;

delete from public.marketplace_price_observations
where source = 'cardtrader_removed_sale'
  and source_item_id like 'cardtrader:%'
  and split_part(source_item_id, ':', 4) = 'inferred_sale'
  and split_part(source_item_id, ':', 3)::date < date '2026-09-11';

update public.cardtrader_market_listing_removed_history
set
  archive_reason = 'dropped_from_cheapest_25',
  archive_metadata = coalesce(archive_metadata, '{}'::jsonb) || jsonb_build_object(
    'reclassifiedFrom', 'inferred_sale',
    'reclassifiedBecause', 'cheap25_left_window_not_sold'
  )
where provider = 'cardtrader'
  and archive_reason = 'inferred_sale'
  and removed_day < date '2026-09-11';

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
    on history.provider || ':' || history.external_listing_id || ':' || history.removed_day::text || ':' || history.archive_reason
      = obs.source_item_id
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
        and not exists (
          select 1
          from public.cardtrader_market_listing_snapshots live
          where live.provider = 'cardtrader'
            and live.blueprint_id is not distinct from coalesce(history.blueprint_id, obs.blueprint_id)
            and live.seller_account_id <> ''
            and live.seller_account_id = history.seller_account_id
            and live.quantity = history.quantity
            and live.condition is not distinct from history.condition
            and live.language is not distinct from history.language
            and public.cardtrader_listing_is_reverse(live.properties, false, '')
                is not distinct from public.cardtrader_listing_is_reverse(history.properties, false, '')
            and public.cardtrader_listing_is_first_edition(live.properties, false)
                is not distinct from public.cardtrader_listing_is_first_edition(history.properties, false)
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
