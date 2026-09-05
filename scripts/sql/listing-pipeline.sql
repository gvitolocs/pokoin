-- Listing pipeline: native appear/sold + CardTrader removed/sold → card weights.
-- Oracle stays the store. Do not copy snapshot rows into Supabase.
-- Public card_id = CardTrader blueprint × 2.

create or replace function public.pokoin_public_card_id(
  p_pokoin_card_id text,
  p_blueprint_id bigint,
  p_cardtrader_blueprint_id bigint
) returns text
language sql
immutable
as $$
  select coalesce(
    nullif(trim(coalesce(p_pokoin_card_id, '')), ''),
    (coalesce(p_blueprint_id, p_cardtrader_blueprint_id) * 2)::text
  );
$$;

create table if not exists public.marketplace_listing_stats_daily (
  card_id text not null,
  observed_day date not null,
  source text not null,
  listed_count integer not null default 0,
  listed_quantity integer not null default 0,
  new_listings integer not null default 0,
  new_quantity integer not null default 0,
  sold_listings integer not null default 0,
  sold_quantity integer not null default 0,
  sold_value_eur numeric not null default 0,
  median_sold_eur numeric,
  seller_count integer not null default 0,
  refreshed_at timestamptz not null default now(),
  primary key (card_id, observed_day, source)
);

create index if not exists marketplace_listing_stats_daily_day_idx
  on public.marketplace_listing_stats_daily (observed_day desc, source);

create index if not exists marketplace_listing_stats_daily_sold_idx
  on public.marketplace_listing_stats_daily (card_id, observed_day desc);

create table if not exists public.marketplace_user_listing_events (
  id bigserial primary key,
  listing_id uuid,
  card_id text not null,
  seller_uid text not null default '',
  event_type text not null,
  quantity_before integer,
  quantity_after integer,
  status_before text,
  status_after text,
  price_pkn numeric,
  occurred_at timestamptz not null default now()
);

create index if not exists marketplace_user_listing_events_card_day_idx
  on public.marketplace_user_listing_events (card_id, occurred_at desc);

create index if not exists marketplace_user_listing_events_type_idx
  on public.marketplace_user_listing_events (event_type, occurred_at desc);

create table if not exists public.marketplace_card_weights (
  card_id text primary key,
  ct_id bigint,
  sold_1d integer not null default 0,
  sold_7d integer not null default 0,
  sold_qty_7d integer not null default 0,
  new_1d integer not null default 0,
  new_7d integer not null default 0,
  listed_now integer not null default 0,
  native_listed integer not null default 0,
  native_sold_7d integer not null default 0,
  native_new_7d integer not null default 0,
  ct_sold_7d integer not null default 0,
  ct_new_7d integer not null default 0,
  hot_score_24h numeric not null default 0,
  catalog_search_weight numeric not null default 0,
  sold_value_eur_7d numeric not null default 0,
  median_sold_eur numeric,
  sell_through numeric not null default 0,
  days_of_supply numeric,
  demand_score numeric not null default 0,
  best_seller_score numeric not null default 0,
  featured_score numeric not null default 0,
  combined_weight numeric not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists marketplace_card_weights_weight_idx
  on public.marketplace_card_weights (combined_weight desc, card_id desc);

create index if not exists marketplace_card_weights_sold_idx
  on public.marketplace_card_weights (sold_7d desc, combined_weight desc);

create index if not exists marketplace_card_weights_best_seller_idx
  on public.marketplace_card_weights (best_seller_score desc, combined_weight desc);

create index if not exists marketplace_card_weights_featured_idx
  on public.marketplace_card_weights (featured_score desc, combined_weight desc);

create or replace function public.marketplace_user_listings_audit()
returns trigger
language plpgsql
as $$
declare
  ev text;
  card text;
  q_before integer;
  q_after integer;
  sold_qty integer := 0;
  is_new boolean := false;
  is_sold boolean := false;
  is_removed boolean := false;
begin
  if tg_op = 'INSERT' then
    card := new.card_id;
    ev := 'listed';
    q_before := 0;
    q_after := coalesce(new.quantity_available, 0);
    is_new := true;
  elsif tg_op = 'DELETE' then
    card := old.card_id;
    q_before := coalesce(old.quantity_available, 0);
    q_after := 0;
    if lower(coalesce(old.status, '')) in ('sold_out', 'sold') or q_before > 0 then
      ev := 'sold';
      sold_qty := q_before;
      is_sold := true;
    else
      ev := 'removed';
      is_removed := true;
    end if;
  else
    card := coalesce(new.card_id, old.card_id);
    q_before := coalesce(old.quantity_available, 0);
    q_after := coalesce(new.quantity_available, 0);
    if q_after < q_before then
      sold_qty := q_before - q_after;
      is_sold := true;
      ev := case
        when q_after = 0 or lower(coalesce(new.status, '')) in ('sold_out', 'sold')
        then 'sold'
        else 'quantity_decreased'
      end;
    elsif lower(coalesce(new.status, '')) in ('sold_out', 'sold')
      and lower(coalesce(old.status, '')) not in ('sold_out', 'sold') then
      ev := 'sold';
      sold_qty := greatest(q_before, 1);
      is_sold := true;
    elsif lower(coalesce(new.status, '')) in ('paused', 'cancelled', 'removed', 'inactive')
      and lower(coalesce(old.status, '')) = 'active' then
      ev := 'removed';
      is_removed := true;
    else
      ev := 'updated';
    end if;
  end if;

  if card is null or card = '' then
    return coalesce(new, old);
  end if;

  insert into public.marketplace_user_listing_events (
    listing_id,
    card_id,
    seller_uid,
    event_type,
    quantity_before,
    quantity_after,
    status_before,
    status_after,
    price_pkn,
    occurred_at
  )
  values (
    coalesce(new.id, old.id),
    card,
    coalesce(new.seller_uid, old.seller_uid, ''),
    ev,
    q_before,
    q_after,
    case when tg_op = 'INSERT' then null else old.status end,
    case when tg_op = 'DELETE' then old.status else new.status end,
    coalesce(new.price_pkn, old.price_pkn),
    now()
  );

  insert into public.marketplace_listing_stats_daily (
    card_id,
    observed_day,
    source,
    new_listings,
    new_quantity,
    sold_listings,
    sold_quantity,
    refreshed_at
  )
  values (
    card,
    (timezone('utc', now()))::date,
    'native',
    case when is_new then 1 else 0 end,
    case when is_new then q_after else 0 end,
    case when is_sold then 1 else 0 end,
    case when is_sold then sold_qty else 0 end,
    now()
  )
  on conflict (card_id, observed_day, source) do update set
    new_listings = public.marketplace_listing_stats_daily.new_listings + excluded.new_listings,
    new_quantity = public.marketplace_listing_stats_daily.new_quantity + excluded.new_quantity,
    sold_listings = public.marketplace_listing_stats_daily.sold_listings + excluded.sold_listings,
    sold_quantity = public.marketplace_listing_stats_daily.sold_quantity + excluded.sold_quantity,
    refreshed_at = now();

  if is_removed then
    null;
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists marketplace_user_listings_audit_trg on public.marketplace_user_listings;
create trigger marketplace_user_listings_audit_trg
  after insert or update or delete on public.marketplace_user_listings
  for each row
  execute procedure public.marketplace_user_listings_audit();

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

-- Scoring (best_seller / featured / demand) lives in listing-weight-formulas.sql.
-- Apply that file after this one or those columns stay 0 / stale combined_weight.
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
  perform set_config('statement_timeout', '45s', true);

  if p_card_id is not null and p_card_id <> '' then
    delete from public.marketplace_card_weights where card_id = p_card_id;
  end if;

  insert into public.marketplace_card_weights (
    card_id,
    ct_id,
    sold_1d,
    sold_7d,
    sold_qty_7d,
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
      coalesce(sum(stats.new_listings) filter (where stats.observed_day = v_today), 0)::integer as new_1d,
      coalesce(sum(stats.new_listings), 0)::integer as new_7d,
      coalesce(sum(stats.listed_count) filter (
        where stats.observed_day = v_today and stats.source = 'cardtrader'
      ), 0)::integer as ct_listed,
      coalesce(sum(stats.sold_listings) filter (where stats.source = 'native'), 0)::integer as native_sold_7d,
      coalesce(sum(stats.new_listings) filter (where stats.source = 'native'), 0)::integer as native_new_7d,
      coalesce(sum(stats.sold_listings) filter (where stats.source = 'cardtrader'), 0)::integer as ct_sold_7d,
      coalesce(sum(stats.new_listings) filter (where stats.source = 'cardtrader'), 0)::integer as ct_new_7d
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
      coalesce(rolled.new_1d, 0) as new_1d,
      coalesce(rolled.new_7d, 0) as new_7d,
      coalesce(rolled.ct_listed, 0) as listed_now,
      coalesce(native_live.native_listed, 0) as native_listed,
      coalesce(rolled.native_sold_7d, 0) as native_sold_7d,
      coalesce(rolled.native_new_7d, 0) as native_new_7d,
      coalesce(rolled.ct_sold_7d, 0) as ct_sold_7d,
      coalesce(rolled.ct_new_7d, 0) as ct_new_7d
    from keys
    left join rolled on rolled.card_id = keys.card_id
    left join native_live on native_live.card_id = keys.card_id
  )
  select
    scored.card_id,
    scored.ct_id,
    scored.sold_1d,
    scored.sold_7d,
    scored.sold_qty_7d,
    scored.new_1d,
    scored.new_7d,
    scored.listed_now,
    scored.native_listed,
    scored.native_sold_7d,
    scored.native_new_7d,
    scored.ct_sold_7d,
    scored.ct_new_7d,
    coalesce((
      select h.hot_score_24h
      from public.marketplace_hot_blueprints h
      where h.blueprint_id::text = scored.card_id
         or (scored.ct_id is not null and h.blueprint_id = scored.ct_id)
      order by h.hot_score_24h desc nulls last
      limit 1
    ), 0),
    coalesce(c.search_weight, 0),
    (
      (80.0 * scored.native_sold_7d) +
      (25.0 * scored.native_listed) +
      (12.0 * scored.native_new_7d) +
      (4.0 * scored.ct_sold_7d) +
      (1.5 * scored.ct_new_7d) +
      (0.4 * ln(1 + greatest(scored.listed_now, 0))) +
      (0.25 * coalesce((
        select h.hot_score_24h
        from public.marketplace_hot_blueprints h
        where h.blueprint_id::text = scored.card_id
           or (scored.ct_id is not null and h.blueprint_id = scored.ct_id)
        order by h.hot_score_24h desc nulls last
        limit 1
      ), 0)) +
      (0.01 * coalesce(c.search_weight, 0))
    ),
    v_run
  from scored
  left join public.marketplace_search_candidates c
    on c.card_id::text = scored.card_id
  on conflict (card_id) do update set
    ct_id = excluded.ct_id,
    sold_1d = excluded.sold_1d,
    sold_7d = excluded.sold_7d,
    sold_qty_7d = excluded.sold_qty_7d,
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

-- Cheap daily analytics: sold from removed_history, listed from the small cache.
-- Do not GROUP BY the 883 MB snapshots table on the 1 GB micro.
create or replace function public.refresh_cardtrader_blueprint_daily_analytics(
  target_day date default current_date - 1
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  refreshed_count integer;
  v_day date := coalesce(target_day, current_date - 1);
begin
  perform set_config('statement_timeout', '45s', true);
  perform set_config('lock_timeout', '4s', true);

  delete from public.cardtrader_blueprint_daily_analytics
  where observed_day = v_day;

  insert into public.cardtrader_blueprint_daily_analytics (
    observed_day,
    blueprint_id,
    listing_count,
    listed_quantity,
    seller_count,
    sold_count,
    sold_quantity,
    min_price_pkn,
    median_price_pkn,
    average_price_pkn,
    max_price_pkn,
    previous_min_price_pkn,
    price_change_pct,
    sell_through_rate,
    source_counts,
    refreshed_at
  )
  with listed as (
    select
      cache.blueprint_id,
      coalesce(cache.eligible_listing_count, 0)::integer as listing_count,
      coalesce(cache.eligible_quantity, 0)::integer as listed_quantity,
      0::integer as seller_count,
      cache.cheapest_price_pkn as min_price_pkn,
      cache.cheapest_price_pkn as median_price_pkn,
      cache.cheapest_price_pkn as average_price_pkn,
      cache.cheapest_price_pkn as max_price_pkn
    from public.cardtrader_blueprint_listing_cache cache
    where cache.blueprint_id is not null
  ),
  removed as (
    select
      coalesce(history.blueprint_id, history.cardtrader_blueprint_id) as blueprint_id,
      count(*)::integer as sold_count,
      coalesce(sum(history.quantity), 0)::integer as sold_quantity
    from public.cardtrader_market_listing_removed_history history
    where history.removed_day = v_day
      and coalesce(history.blueprint_id, history.cardtrader_blueprint_id) is not null
      and public.cardtrader_market_is_sale_reason(history.archive_reason)
    group by 1
  ),
  previous_day as (
    select distinct on (blueprint_id)
      blueprint_id,
      min_price_pkn
    from public.cardtrader_blueprint_daily_analytics
    where observed_day < v_day
    order by blueprint_id, observed_day desc
  ),
  combined as (
    select
      coalesce(listed.blueprint_id, removed.blueprint_id) as blueprint_id,
      coalesce(listed.listing_count, 0) as listing_count,
      coalesce(listed.listed_quantity, 0) as listed_quantity,
      coalesce(listed.seller_count, 0) as seller_count,
      coalesce(removed.sold_count, 0) as sold_count,
      coalesce(removed.sold_quantity, 0) as sold_quantity,
      listed.min_price_pkn,
      listed.median_price_pkn,
      listed.average_price_pkn,
      listed.max_price_pkn,
      previous_day.min_price_pkn as previous_min_price_pkn
    from listed
    full outer join removed on removed.blueprint_id = listed.blueprint_id
    left join previous_day
      on previous_day.blueprint_id = coalesce(listed.blueprint_id, removed.blueprint_id)
  )
  select
    v_day,
    combined.blueprint_id,
    combined.listing_count,
    combined.listed_quantity,
    combined.seller_count,
    combined.sold_count,
    combined.sold_quantity,
    combined.min_price_pkn,
    combined.median_price_pkn,
    combined.average_price_pkn,
    combined.max_price_pkn,
    combined.previous_min_price_pkn,
    case
      when combined.previous_min_price_pkn > 0 and combined.min_price_pkn is not null
      then (combined.min_price_pkn - combined.previous_min_price_pkn) / combined.previous_min_price_pkn
      else null
    end,
    case
      when combined.sold_quantity + combined.listed_quantity > 0
      then combined.sold_quantity::numeric / (combined.sold_quantity + combined.listed_quantity)
      else 0
    end,
    jsonb_build_object(
      'cardtrader_market_cache', combined.listing_count,
      'cardtrader_market_removed', combined.sold_count
    ),
    now()
  from combined
  where combined.blueprint_id is not null;

  get diagnostics refreshed_count = row_count;
  return coalesce(refreshed_count, 0);
end;
$$;

create or replace function public.finalize_cardtrader_daily_market_refresh(
  p_provider text default 'cardtrader',
  p_removed_day date default current_date - 1,
  p_imported_at timestamptz default now()
)
returns table (
  cache_refreshed_count integer,
  analytics_count integer,
  price_summary_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := coalesce(p_removed_day, current_date - 1);
begin
  perform set_config('statement_timeout', '60s', true);
  perform set_config('lock_timeout', '4s', true);

  -- Skip full-table snapshot scans on the 1 GB micro. Per-expansion upserts
  -- already wrote asks; sold comps live in removed_history.
  cache_refreshed_count := 0;
  price_summary_count := 0;

  select public.refresh_cardtrader_blueprint_daily_analytics(v_day)
  into analytics_count;

  perform public.refresh_marketplace_listing_stats(v_day);
  perform public.refresh_marketplace_listing_stats((timezone('utc', now()))::date);
  perform public.refresh_marketplace_card_weights();
  perform public.refresh_marketplace_hot_blueprints();

  return next;
end;
$$;
