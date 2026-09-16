-- inferred_sale listing ids that CardTrader blueprint GET still returns
-- were expansion-dump gaps, not sold. Glalie TWM 052/167 leftover 287734:
-- 22 copies on 13 Sep, all six product ids still live 14 Sep.
-- Expansion GET / our 25-trim + archiveMissing tagged them inferred_sale.
-- quantity_decreased stays. seller_on_vacation stays. Restore snapshots
-- so the next expansion dump (archiveMissing off) can see them again.

begin;
set local statement_timeout = 0;
set local lock_timeout = 0;
set local idle_in_transaction_session_timeout = 0;

create or replace function public.cardtrader_reclassify_dump_miss_inferred_sales()
returns table (
  events integer,
  qty bigint,
  blueprints integer
)
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
as $$
begin
  perform set_config('statement_timeout', '0', true);

  if not exists (
    select 1
    from pg_tables
    where tablename = 'dump_miss_listings'
      and schemaname like 'pg_temp%'
  ) then
    raise exception 'dump_miss_listings temp table is missing';
  end if;

  delete from public.marketplace_price_observations o
  using pg_temp.dump_miss_listings t
  where o.source = 'cardtrader_removed_sale'
    and o.source_item_id = 'cardtrader:' || t.external_listing_id || ':'
      || t.removed_day::text || ':inferred_sale';

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
    h.raw_metadata,
    coalesce(h.first_seen_at, h.archived_at),
    coalesce(h.last_seen_at, h.archived_at),
    coalesce(h.imported_at, h.archived_at),
    now()
  from public.cardtrader_market_listing_removed_history h
  join pg_temp.dump_miss_listings t
    on t.external_listing_id = h.external_listing_id
   and t.removed_day = h.removed_day
  where h.provider = 'cardtrader'
    and h.archive_reason = 'inferred_sale'
  on conflict (provider, external_listing_id) do nothing;

  update public.cardtrader_market_listing_removed_history h
  set
    archive_reason = 'dump_miss',
    archive_metadata = coalesce(h.archive_metadata, '{}'::jsonb) || jsonb_build_object(
      'reclassifiedFrom', 'inferred_sale',
      'reclassifiedBecause', 'listing_still_on_cardtrader_blueprint_get'
    )
  from pg_temp.dump_miss_listings t
  where h.provider = 'cardtrader'
    and h.external_listing_id = t.external_listing_id
    and h.removed_day = t.removed_day
    and h.archive_reason = 'inferred_sale';

  return query
  select
    count(*)::integer,
    coalesce(sum(h.quantity), 0),
    count(distinct coalesce(h.blueprint_id, h.cardtrader_blueprint_id))::integer
  from public.cardtrader_market_listing_removed_history h
  join pg_temp.dump_miss_listings t
    on t.external_listing_id = h.external_listing_id
   and t.removed_day = h.removed_day
  where h.archive_reason = 'dump_miss';
end;
$$;

commit;
