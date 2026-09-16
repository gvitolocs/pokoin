-- Cheap-window CardTrader population (copies / sellers / new insertions).
-- Daily scrape stores the full blueprint listing book (qty diffs per listing).
-- capped stays false on that path; do not treat listing_count >= 25 as truncated.
-- Snapshot GROUP BY is Pi-safe; do not run it on the 1 GB Oracle micro.

create table if not exists public.cardtrader_blueprint_population_daily (
  observed_day date not null,
  blueprint_id bigint not null,
  listing_count integer not null default 0,
  listed_quantity integer not null default 0,
  seller_count integer not null default 0,
  new_listings integer not null default 0,
  new_quantity integer not null default 0,
  capped boolean not null default false,
  refreshed_at timestamptz not null default now(),
  primary key (observed_day, blueprint_id)
);

create index if not exists cardtrader_blueprint_population_day_qty_idx
  on public.cardtrader_blueprint_population_daily (observed_day desc, listed_quantity desc);

create or replace function public.upsert_cardtrader_blueprint_population(
  p_observed_day date,
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := coalesce(p_observed_day, (timezone('utc', now()))::date);
  n integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  insert into public.cardtrader_blueprint_population_daily (
    observed_day,
    blueprint_id,
    listing_count,
    listed_quantity,
    seller_count,
    new_listings,
    new_quantity,
    capped,
    refreshed_at
  )
  select
    v_day,
    incoming.blueprint_id,
    greatest(coalesce(incoming.listing_count, 0), 0),
    greatest(coalesce(incoming.listed_quantity, 0), 0),
    greatest(coalesce(incoming.seller_count, 0), 0),
    greatest(coalesce(incoming.new_listings, 0), 0),
    greatest(coalesce(incoming.new_quantity, 0), 0),
    coalesce(incoming.capped, false),
    now()
  from jsonb_to_recordset(p_rows) as incoming(
    blueprint_id bigint,
    listing_count integer,
    listed_quantity integer,
    seller_count integer,
    new_listings integer,
    new_quantity integer,
    capped boolean
  )
  where incoming.blueprint_id is not null
  on conflict (observed_day, blueprint_id) do update set
    listing_count = excluded.listing_count,
    listed_quantity = excluded.listed_quantity,
    seller_count = excluded.seller_count,
    new_listings = excluded.new_listings,
    new_quantity = excluded.new_quantity,
    capped = excluded.capped,
    refreshed_at = now();

  get diagnostics n = row_count;
  return coalesce(n, 0);
end;
$$;

create or replace function public.refresh_cardtrader_blueprint_population(
  target_day date default ((timezone('utc', now()))::date),
  p_force boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := coalesce(target_day, (timezone('utc', now()))::date);
  refreshed_count integer := 0;
  existing_count integer := 0;
begin
  perform set_config('lock_timeout', '4s', true);
  perform set_config('statement_timeout', '120s', true);

  if not coalesce(p_force, false) then
    select count(*) into existing_count
    from public.cardtrader_blueprint_population_daily
    where observed_day = v_day
      and refreshed_at > now() - interval '6 hours';
    if coalesce(existing_count, 0) >= 10000 then
      return existing_count;
    end if;
  end if;

  delete from public.cardtrader_blueprint_population_daily
  where observed_day = v_day;

  insert into public.cardtrader_blueprint_population_daily (
    observed_day,
    blueprint_id,
    listing_count,
    listed_quantity,
    seller_count,
    new_listings,
    new_quantity,
    capped,
    refreshed_at
  )
  select
    v_day,
    coalesce(snapshot.blueprint_id, snapshot.cardtrader_blueprint_id) as blueprint_id,
    count(*)::integer,
    coalesce(sum(snapshot.quantity), 0)::integer,
    count(distinct nullif(snapshot.seller_account_id, ''))::integer,
    count(*) filter (
      where (snapshot.first_seen_at at time zone 'utc')::date = v_day
    )::integer,
    coalesce(sum(snapshot.quantity) filter (
      where (snapshot.first_seen_at at time zone 'utc')::date = v_day
    ), 0)::integer,
    false,
    now()
  from public.cardtrader_market_listing_snapshots snapshot
  where snapshot.quantity > 0
    and coalesce(snapshot.blueprint_id, snapshot.cardtrader_blueprint_id) is not null
  group by coalesce(snapshot.blueprint_id, snapshot.cardtrader_blueprint_id);

  get diagnostics refreshed_count = row_count;
  return coalesce(refreshed_count, 0);
end;
$$;
