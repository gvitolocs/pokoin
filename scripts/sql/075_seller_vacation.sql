-- Seller vacation is not a sold-out. CardTrader marketplace GET often
-- omits the whole shop when on_vacation is true, so persist never sees
-- the flag on the missing rows. Keep cardtrader_seller_vacation from
-- listings that do carry on_vacation, freeze those snapshots, and at
-- finalize treat a seller whose entire book vanished in one day as
-- vacation (not inferred_sale).
--
-- Giuseppe 2026-09-14: if a seller completely vanishes because they went
-- on vacation, none of those cards were sold.

begin;
set local statement_timeout = 0;
set local lock_timeout = 0;
set local idle_in_transaction_session_timeout = 0;

create table if not exists public.cardtrader_seller_vacation (
  provider text not null default 'cardtrader',
  seller_account_id text not null,
  seller_account_name text not null default '',
  on_vacation boolean not null default false,
  listing_count integer not null default 0 check (listing_count >= 0),
  first_vacation_at timestamptz,
  last_vacation_at timestamptz,
  last_active_at timestamptz,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, seller_account_id)
);

create index if not exists cardtrader_seller_vacation_active_idx
  on public.cardtrader_seller_vacation (provider, last_seen_at desc)
  where on_vacation;

create or replace function public.cardtrader_listing_is_on_vacation(
  raw_metadata jsonb default '{}'::jsonb
)
returns boolean
language sql
immutable
parallel safe
as $$
  select lower(coalesce(
    raw_metadata->>'on_vacation',
    raw_metadata->'user'->>'on_vacation',
    ''
  )) in ('true', '1', 'yes');
$$;

create or replace function public.cardtrader_seller_is_on_vacation(
  p_provider text,
  p_seller_account_id text
)
returns boolean
language sql
stable
parallel safe
as $$
  select exists (
    select 1
    from public.cardtrader_seller_vacation v
    where v.provider = coalesce(nullif(btrim(p_provider), ''), 'cardtrader')
      and v.seller_account_id = coalesce(p_seller_account_id, '')
      and v.seller_account_id <> ''
      and v.on_vacation
  );
$$;

create or replace function public.cardtrader_upsert_seller_vacation_from_refresh(
  p_provider text,
  p_imported_at timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider text := coalesce(nullif(btrim(p_provider), ''), 'cardtrader');
  v_count integer := 0;
begin
  if to_regclass('pg_temp.cardtrader_market_listing_refresh_rows') is null then
    return 0;
  end if;

  insert into public.cardtrader_seller_vacation (
    provider,
    seller_account_id,
    seller_account_name,
    on_vacation,
    listing_count,
    first_vacation_at,
    last_vacation_at,
    last_active_at,
    last_seen_at,
    updated_at
  )
  select
    v_provider,
    seller_account_id,
    coalesce(max(seller_account_name), ''),
    bool_or(public.cardtrader_listing_is_on_vacation(raw_metadata)),
    count(*)::integer,
    case
      when bool_or(public.cardtrader_listing_is_on_vacation(raw_metadata))
        then p_imported_at
    end,
    case
      when bool_or(public.cardtrader_listing_is_on_vacation(raw_metadata))
        then p_imported_at
    end,
    case
      when not bool_or(public.cardtrader_listing_is_on_vacation(raw_metadata))
        then p_imported_at
    end,
    p_imported_at,
    p_imported_at
  from pg_temp.cardtrader_market_listing_refresh_rows
  where seller_account_id <> ''
  group by seller_account_id
  on conflict (provider, seller_account_id) do update set
    seller_account_name = excluded.seller_account_name,
    on_vacation = excluded.on_vacation,
    listing_count = excluded.listing_count,
    first_vacation_at = case
      when excluded.on_vacation
        then coalesce(public.cardtrader_seller_vacation.first_vacation_at, excluded.first_vacation_at)
      else public.cardtrader_seller_vacation.first_vacation_at
    end,
    last_vacation_at = case
      when excluded.on_vacation then excluded.last_vacation_at
      else public.cardtrader_seller_vacation.last_vacation_at
    end,
    last_active_at = case
      when not excluded.on_vacation then excluded.last_active_at
      else public.cardtrader_seller_vacation.last_active_at
    end,
    last_seen_at = excluded.last_seen_at,
    updated_at = excluded.updated_at;

  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

-- Whole shop gone in one persist day: vacation/pause, not a sold-out of
-- every card. Skip tiny shops (one printing sold through). Restore the
-- snapshot rows so a return is not a restock inferred_sale.
create or replace function public.cardtrader_reclassify_vacation_vanished_sellers(
  p_provider text default 'cardtrader',
  p_removed_day date default current_date - 1
)
returns table (
  sellers integer,
  events integer,
  qty bigint
)
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
as $$
declare
  v_provider text := coalesce(nullif(btrim(p_provider), ''), 'cardtrader');
  v_day date := coalesce(p_removed_day, current_date - 1);
begin
  perform set_config('statement_timeout', '0', true);

  drop table if exists vacation_vanished_sellers;
  create temporary table vacation_vanished_sellers (
    seller_account_id text primary key
  ) on commit drop;

  insert into pg_temp.vacation_vanished_sellers (seller_account_id)
  select h.seller_account_id
  from public.cardtrader_market_listing_removed_history h
  where h.provider = v_provider
    and h.removed_day = v_day
    and h.archive_reason = 'inferred_sale'
    and h.seller_account_id <> ''
  group by h.seller_account_id
  having count(*) >= 5
     and count(distinct coalesce(h.blueprint_id, h.cardtrader_blueprint_id)) >= 3
     and not exists (
       select 1
       from public.cardtrader_market_listing_snapshots live
       where live.provider = v_provider
         and live.seller_account_id = h.seller_account_id
     );

  insert into public.cardtrader_seller_vacation (
    provider,
    seller_account_id,
    seller_account_name,
    on_vacation,
    listing_count,
    first_vacation_at,
    last_vacation_at,
    last_seen_at,
    updated_at
  )
  select
    v_provider,
    h.seller_account_id,
    coalesce(max(h.seller_account_name), ''),
    true,
    count(*)::integer,
    min(h.archived_at),
    max(h.archived_at),
    max(h.archived_at),
    now()
  from public.cardtrader_market_listing_removed_history h
  join pg_temp.vacation_vanished_sellers v
    on v.seller_account_id = h.seller_account_id
  where h.provider = v_provider
    and h.removed_day = v_day
    and h.archive_reason = 'inferred_sale'
  group by h.seller_account_id
  on conflict (provider, seller_account_id) do update set
    seller_account_name = excluded.seller_account_name,
    on_vacation = true,
    listing_count = excluded.listing_count,
    first_vacation_at = coalesce(
      public.cardtrader_seller_vacation.first_vacation_at,
      excluded.first_vacation_at
    ),
    last_vacation_at = excluded.last_vacation_at,
    last_seen_at = excluded.last_seen_at,
    updated_at = excluded.updated_at;

  delete from public.marketplace_price_observations o
  using public.cardtrader_market_listing_removed_history h
  join pg_temp.vacation_vanished_sellers v
    on v.seller_account_id = h.seller_account_id
  where o.source = 'cardtrader_removed_sale'
    and h.provider = v_provider
    and h.removed_day = v_day
    and h.archive_reason = 'inferred_sale'
    and o.source_item_id = 'cardtrader:' || h.external_listing_id || ':' || v_day::text || ':inferred_sale';

  insert into public.cardtrader_market_listing_snapshots (
    provider,
    external_listing_id,
    external_product_id,
    blueprint_id,
    cardtrader_blueprint_id,
    pokoin_card_id,
    seller_account_id,
    seller_account_name,
    seller_country,
    seller_type,
    quantity,
    condition,
    language,
    price,
    price_cents,
    currency,
    properties,
    raw_metadata,
    first_seen_at,
    last_seen_at,
    imported_at,
    updated_at
  )
  select
    h.provider,
    h.external_listing_id,
    h.external_product_id,
    h.blueprint_id,
    h.cardtrader_blueprint_id,
    h.pokoin_card_id,
    h.seller_account_id,
    h.seller_account_name,
    h.seller_country,
    h.seller_type,
    h.quantity,
    h.condition,
    h.language,
    h.price,
    h.price_cents,
    h.currency,
    h.properties,
    coalesce(h.raw_metadata, '{}'::jsonb) || jsonb_build_object('on_vacation', true),
    coalesce(h.first_seen_at, h.archived_at),
    coalesce(h.last_seen_at, h.archived_at),
    coalesce(h.imported_at, h.archived_at),
    now()
  from public.cardtrader_market_listing_removed_history h
  join pg_temp.vacation_vanished_sellers v
    on v.seller_account_id = h.seller_account_id
  where h.provider = v_provider
    and h.removed_day = v_day
    and h.archive_reason = 'inferred_sale'
  on conflict (provider, external_listing_id) do nothing;

  update public.cardtrader_market_listing_removed_history h
  set
    archive_reason = 'seller_on_vacation',
    archive_metadata = coalesce(h.archive_metadata, '{}'::jsonb) || jsonb_build_object(
      'reclassifiedFrom', 'inferred_sale',
      'reclassifiedBecause', 'seller_vanished_on_vacation'
    )
  from pg_temp.vacation_vanished_sellers v
  where h.provider = v_provider
    and h.removed_day = v_day
    and h.archive_reason = 'inferred_sale'
    and h.seller_account_id = v.seller_account_id;

  return query
  select
    count(distinct v.seller_account_id)::integer,
    count(*)::integer,
    coalesce(sum(h.quantity), 0)
  from pg_temp.vacation_vanished_sellers v
  left join public.cardtrader_market_listing_removed_history h
    on h.provider = v_provider
   and h.removed_day = v_day
   and h.archive_reason = 'seller_on_vacation'
   and h.seller_account_id = v.seller_account_id;
end;
$$;

commit;
