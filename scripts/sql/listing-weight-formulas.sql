-- Weight formulas. Applied on top of listing-pipeline.sql.
--
-- Homepage rails ask different questions. Do not reuse one GMV score, and do
-- not filter by expansion nationality — that is merchandising, not a weight.
--
-- Best sellers (Cardmarket EN singles, WooCommerce "sold count", Layers):
--   7-day *units*. Revenue/GMV ranks expensive SKUs and reads as a price list.
--   A tiny log-GMV term only breaks ties. Window is 7d (trend catalog).
-- Featured / trending (Algolia, Shopify "What's Hot", Rankify 48h–7d):
--   recent velocity + sell-through, *not* lifetime GMV and not 50% of best-seller.
-- Demand (OP.LOG): (weekly_units/7)/supply, min sales floor, no GMV multiply.
--   That is a tightness metric, not a homepage sort by itself.

alter table public.marketplace_listing_stats_daily
  add column if not exists sold_value_eur numeric not null default 0;

alter table public.marketplace_listing_stats_daily
  add column if not exists median_sold_eur numeric;

alter table public.marketplace_card_weights
  add column if not exists sold_value_eur_7d numeric not null default 0;

alter table public.marketplace_card_weights
  add column if not exists median_sold_eur numeric;

alter table public.marketplace_card_weights
  add column if not exists sell_through numeric not null default 0;

alter table public.marketplace_card_weights
  add column if not exists days_of_supply numeric;

alter table public.marketplace_card_weights
  add column if not exists demand_score numeric not null default 0;

alter table public.marketplace_card_weights
  add column if not exists best_seller_score numeric not null default 0;

alter table public.marketplace_card_weights
  add column if not exists featured_score numeric not null default 0;

create index if not exists marketplace_card_weights_best_seller_idx
  on public.marketplace_card_weights (best_seller_score desc, combined_weight desc);

create index if not exists marketplace_card_weights_featured_idx
  on public.marketplace_card_weights (featured_score desc, combined_weight desc);

create or replace function public.refresh_marketplace_listing_stats(
  target_day date default ((timezone('utc', now()))::date)
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := coalesce(target_day, (timezone('utc', now()))::date);
  refreshed_count integer := 0;
  n integer;
begin
  perform set_config('lock_timeout', '4s', true);
  perform set_config('statement_timeout', '45s', true);

  delete from public.marketplace_listing_stats_daily
  where observed_day = v_day
    and source = 'cardtrader';

  insert into public.marketplace_listing_stats_daily (
    card_id,
    observed_day,
    source,
    sold_listings,
    sold_quantity,
    sold_value_eur,
    median_sold_eur,
    refreshed_at
  )
  select
    public.pokoin_public_card_id(
      history.pokoin_card_id,
      history.blueprint_id,
      history.cardtrader_blueprint_id
    ) as card_id,
    v_day,
    'cardtrader',
    count(*)::integer,
    coalesce(sum(history.quantity), 0)::integer,
    coalesce(sum(
      coalesce(history.price, history.price_cents::numeric / 100) * coalesce(history.quantity, 1)
    ), 0),
    percentile_cont(0.5) within group (
      order by coalesce(history.price, history.price_cents::numeric / 100)
    ),
    now()
  from public.cardtrader_market_listing_removed_history history
  where history.removed_day = v_day
    and public.cardtrader_market_is_sale_reason(history.archive_reason)
    and public.pokoin_public_card_id(
      history.pokoin_card_id,
      history.blueprint_id,
      history.cardtrader_blueprint_id
    ) is not null
  group by 1
  on conflict (card_id, observed_day, source) do update set
    sold_listings = excluded.sold_listings,
    sold_quantity = excluded.sold_quantity,
    sold_value_eur = excluded.sold_value_eur,
    median_sold_eur = excluded.median_sold_eur,
    refreshed_at = now();

  get diagnostics n = row_count;
  refreshed_count := refreshed_count + coalesce(n, 0);

  insert into public.marketplace_listing_stats_daily (
    card_id,
    observed_day,
    source,
    listed_count,
    listed_quantity,
    refreshed_at
  )
  select
    coalesce(nullif(cache.pokoin_card_id, ''), (cache.blueprint_id * 2)::text),
    v_day,
    'cardtrader',
    coalesce(cache.eligible_listing_count, 0),
    coalesce(cache.eligible_quantity, 0),
    now()
  from public.cardtrader_blueprint_listing_cache cache
  where coalesce(nullif(cache.pokoin_card_id, ''), (cache.blueprint_id * 2)::text) is not null
  on conflict (card_id, observed_day, source) do update set
    listed_count = excluded.listed_count,
    listed_quantity = excluded.listed_quantity,
    refreshed_at = now();

  insert into public.marketplace_listing_stats_daily (
    card_id,
    observed_day,
    source,
    listed_count,
    listed_quantity,
    seller_count,
    refreshed_at
  )
  select
    listing.card_id,
    v_day,
    'native',
    count(*)::integer,
    coalesce(sum(listing.quantity_available), 0)::integer,
    count(distinct listing.seller_uid)::integer,
    now()
  from public.marketplace_user_listings listing
  where listing.status = 'active'
    and coalesce(listing.quantity_available, 0) > 0
    and listing.card_id is not null
    and listing.card_id <> ''
  group by listing.card_id
  on conflict (card_id, observed_day, source) do update set
    listed_count = excluded.listed_count,
    listed_quantity = excluded.listed_quantity,
    seller_count = excluded.seller_count,
    refreshed_at = now();

  get diagnostics n = row_count;
  refreshed_count := refreshed_count + coalesce(n, 0);
  return refreshed_count;
end;
$$;

create or replace function public.refresh_marketplace_card_weights(
  p_card_id text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  refreshed_count integer := 0;
  v_from date := (timezone('utc', now()))::date - 6;
  v_today date := (timezone('utc', now()))::date;
  v_run timestamptz := now();
begin
  perform set_config('lock_timeout', '4s', true);
  perform set_config('statement_timeout', '90s', true);

  if p_card_id is not null and p_card_id <> '' then
    delete from public.marketplace_card_weights where card_id = p_card_id;
  end if;

  insert into public.marketplace_card_weights (
    card_id,
    ct_id,
    sold_1d,
    sold_7d,
    sold_qty_7d,
    sold_value_eur_7d,
    median_sold_eur,
    sell_through,
    days_of_supply,
    demand_score,
    best_seller_score,
    featured_score,
    new_1d,
    new_7d,
    listed_now,
    native_listed,
    native_sold_7d,
    native_new_7d,
    ct_sold_7d,
    ct_new_7d,
    hot_score_24h,
    catalog_search_weight,
    combined_weight,
    updated_at
  )
  with keys as (
    select distinct card_id
    from public.marketplace_listing_stats_daily
    where observed_day >= v_from
      and (p_card_id is null or card_id = p_card_id)
    union
    select distinct card_id
    from public.marketplace_user_listings
    where status = 'active'
      and coalesce(quantity_available, 0) > 0
      and (p_card_id is null or card_id = p_card_id)
    union
    select blueprint_id::text
    from public.marketplace_hot_blueprints
    where (p_card_id is null or blueprint_id::text = p_card_id)
    union
    select (blueprint_id * 2)::text
    from public.marketplace_hot_blueprints
    where (p_card_id is null or (blueprint_id * 2)::text = p_card_id)
  ),
  rolled as (
    select
      stats.card_id,
      coalesce(sum(stats.sold_listings) filter (where stats.observed_day = v_today), 0)::integer as sold_1d,
      coalesce(sum(stats.sold_listings), 0)::integer as sold_7d,
      coalesce(sum(stats.sold_quantity), 0)::integer as sold_qty_7d,
      coalesce(sum(stats.sold_value_eur), 0) as sold_value_eur_7d,
      coalesce(sum(stats.new_listings) filter (where stats.observed_day = v_today), 0)::integer as new_1d,
      coalesce(sum(stats.new_listings), 0)::integer as new_7d,
      coalesce(sum(stats.listed_count) filter (
        where stats.observed_day = v_today and stats.source = 'cardtrader'
      ), 0)::integer as ct_listed,
      coalesce(sum(stats.listed_quantity) filter (
        where stats.observed_day = v_today and stats.source = 'cardtrader'
      ), 0)::integer as ct_listed_qty,
      coalesce(sum(stats.sold_listings) filter (where stats.source = 'native'), 0)::integer as native_sold_7d,
      coalesce(sum(stats.new_listings) filter (where stats.source = 'native'), 0)::integer as native_new_7d,
      coalesce(sum(stats.sold_listings) filter (where stats.source = 'cardtrader'), 0)::integer as ct_sold_7d,
      coalesce(sum(stats.new_listings) filter (where stats.source = 'cardtrader'), 0)::integer as ct_new_7d,
      (
        array_agg(stats.median_sold_eur order by stats.observed_day desc)
          filter (where stats.median_sold_eur is not null)
      )[1] as median_sold_eur
    from public.marketplace_listing_stats_daily stats
    join keys on keys.card_id = stats.card_id
    where stats.observed_day >= v_from
    group by stats.card_id
  ),
  native_live as (
    select
      listing.card_id,
      count(*)::integer as native_listed
    from public.marketplace_user_listings listing
    join keys on keys.card_id = listing.card_id
    where listing.status = 'active'
      and coalesce(listing.quantity_available, 0) > 0
    group by listing.card_id
  ),
  scored as (
    select
      keys.card_id,
      case
        when keys.card_id ~ '^[0-9]+$' and (keys.card_id::bigint % 2) = 0
        then keys.card_id::bigint / 2
        when keys.card_id ~ '^[0-9]+$'
        then keys.card_id::bigint
        else null
      end as ct_id,
      coalesce(rolled.sold_1d, 0) as sold_1d,
      coalesce(rolled.sold_7d, 0) as sold_7d,
      coalesce(rolled.sold_qty_7d, 0) as sold_qty_7d,
      coalesce(rolled.sold_value_eur_7d, 0) as sold_value_eur_7d,
      rolled.median_sold_eur,
      coalesce(rolled.new_1d, 0) as new_1d,
      coalesce(rolled.new_7d, 0) as new_7d,
      coalesce(rolled.ct_listed, 0) as listed_now,
      coalesce(rolled.ct_listed_qty, 0) as listed_qty,
      coalesce(native_live.native_listed, 0) as native_listed,
      coalesce(rolled.native_sold_7d, 0) as native_sold_7d,
      coalesce(rolled.native_new_7d, 0) as native_new_7d,
      coalesce(rolled.ct_sold_7d, 0) as ct_sold_7d,
      coalesce(rolled.ct_new_7d, 0) as ct_new_7d
    from keys
    left join rolled on rolled.card_id = keys.card_id
    left join native_live on native_live.card_id = keys.card_id
  ),
  with_hot as (
    select
      scored.*,
      coalesce((
        select h.hot_score_24h
        from public.marketplace_hot_blueprints h
        where h.blueprint_id::text = scored.card_id
           or (scored.ct_id is not null and h.blueprint_id = scored.ct_id)
        order by h.hot_score_24h desc nulls last
        limit 1
      ), 0) as hot_score_24h,
      coalesce(c.search_weight, 0) as catalog_search_weight
    from scored
    left join public.marketplace_search_candidates c
      on c.card_id::text = scored.card_id
  ),
  formula as (
    select
      with_hot.*,
      (
        with_hot.sold_qty_7d::numeric
        / (with_hot.sold_qty_7d + with_hot.listed_qty + 5.0)
      ) as sell_through,
      case
        when with_hot.sold_qty_7d >= 3 and with_hot.listed_qty > 0
        then (with_hot.listed_qty::numeric * 7.0) / with_hot.sold_qty_7d
        else null
      end as days_of_supply,
      -- Dead simple: integer 7-day units. Publisher sorts this column.
      with_hot.sold_qty_7d::numeric as best_seller_score,
      -- OP.LOG demand pressure: (qty/7)/listed, min 3 sales, needs supply.
      case
        when with_hot.sold_qty_7d >= 3 and with_hot.listed_qty > 0
        then ln(1.0 + 80.0 * ((with_hot.sold_qty_7d / 7.0) / with_hot.listed_qty))
        else 0
      end as demand_score
    from with_hot
  )
  select
    formula.card_id,
    formula.ct_id,
    formula.sold_1d,
    formula.sold_7d,
    formula.sold_qty_7d,
    formula.sold_value_eur_7d,
    formula.median_sold_eur,
    formula.sell_through,
    formula.days_of_supply,
    formula.demand_score,
    formula.best_seller_score,
    (
      -- Trending = shelf clearing speed only. No hot_score (raw 0–1000 drowns units).
      case
        when formula.listed_qty > 0 and formula.sold_qty_7d >= 3
        then formula.demand_score
             + 2.0 * formula.sell_through * ln(1.0 + formula.sold_qty_7d)
        else 0
      end
      + 0.45 * ln(1.0 + (10.0 * formula.native_listed) + (20.0 * formula.native_sold_7d))
    ) as featured_score,
    formula.new_1d,
    formula.new_7d,
    formula.listed_now,
    formula.native_listed,
    formula.native_sold_7d,
    formula.native_new_7d,
    formula.ct_sold_7d,
    formula.ct_new_7d,
    formula.hot_score_24h,
    formula.catalog_search_weight,
    (
      formula.best_seller_score
      + 10.0 * formula.demand_score
      + 0.10 * ln(1.0 + formula.new_7d)
      + 0.55 * ln(1.0 + (10.0 * formula.native_listed) + (25.0 * formula.native_sold_7d))
    ) as combined_weight,
    v_run
  from formula
  on conflict (card_id) do update set
    ct_id = excluded.ct_id,
    sold_1d = excluded.sold_1d,
    sold_7d = excluded.sold_7d,
    sold_qty_7d = excluded.sold_qty_7d,
    sold_value_eur_7d = excluded.sold_value_eur_7d,
    median_sold_eur = excluded.median_sold_eur,
    sell_through = excluded.sell_through,
    days_of_supply = excluded.days_of_supply,
    demand_score = excluded.demand_score,
    best_seller_score = excluded.best_seller_score,
    featured_score = excluded.featured_score,
    new_1d = excluded.new_1d,
    new_7d = excluded.new_7d,
    listed_now = excluded.listed_now,
    native_listed = excluded.native_listed,
    native_sold_7d = excluded.native_sold_7d,
    native_new_7d = excluded.native_new_7d,
    ct_sold_7d = excluded.ct_sold_7d,
    ct_new_7d = excluded.ct_new_7d,
    hot_score_24h = excluded.hot_score_24h,
    catalog_search_weight = excluded.catalog_search_weight,
    combined_weight = excluded.combined_weight,
    updated_at = excluded.updated_at;

  get diagnostics refreshed_count = row_count;

  if p_card_id is null or p_card_id = '' then
    delete from public.marketplace_card_weights
    where updated_at < v_run;
  end if;

  return coalesce(refreshed_count, 0);
end;
$$;
