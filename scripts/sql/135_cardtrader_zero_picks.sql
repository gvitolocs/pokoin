-- CardTrader Zero picks (docs/CARDTRADER_ZERO.md "Pick → inventory").
-- One row per copy a seller ticked as picked on /mypokoin/zero. The Zero sale
-- already took the stock (CardTrader webhook decrement); a pick never takes it
-- again. `finalize`: the copy the sale took left the box (its location is
-- cleared once it holds no copies). `swap`: the seller took another identical
-- copy, so the picked copy loses `quantity` and the allocated copy gets it
-- back, in the transaction that writes this row.
-- Picked rows are not listings: never counted as stock, never pushed.
-- Apply on the nezopt writer; the Pi replica receives it by replication.
-- Idempotent.

create table if not exists public.cardtrader_zero_picks (
  id bigserial primary key,
  seller_uid text not null,
  order_id text not null,
  order_code text not null default '',
  item_id text not null,
  line_key text not null default '',
  -- The copy physically picked.
  listing_id uuid not null,
  -- The copy the sale took (webhook allocation); null when the line had none.
  allocated_listing_id uuid,
  quantity integer not null check (quantity > 0),
  kind text not null check (kind in ('finalize', 'swap')),
  state text not null default 'picked' check (state in ('picked', 'undone')),
  -- The picked copy's location before a finalize cleared it (undo restores it).
  location_from text not null default '',
  card_id text not null default '',
  marketplace_game text not null default '',
  unit_cents integer,
  currency text not null default '',
  picked_at timestamptz not null default now(),
  undone_at timestamptz,
  -- Reserved: a later row that reverses this one. Undo marks the row itself.
  undo_of bigint references public.cardtrader_zero_picks (id)
);

-- One live pick per (seller, order, item, copy): a replayed or double-clicked
-- pick finds this row and changes nothing.
create unique index if not exists cardtrader_zero_picks_live_key
  on public.cardtrader_zero_picks (seller_uid, order_id, item_id, listing_id)
  where state = 'picked';

-- The Picked section (newest first) and the Zero list's picked counts.
create index if not exists cardtrader_zero_picks_seller_idx
  on public.cardtrader_zero_picks (seller_uid, picked_at desc, id desc)
  where state = 'picked';
create index if not exists cardtrader_zero_picks_order_idx
  on public.cardtrader_zero_picks (seller_uid, order_id)
  where state = 'picked';

-- Explicit grants for the least-privilege roles, where they exist.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'pokoin_api_read') then
    grant select on public.cardtrader_zero_picks to pokoin_api_read;
  end if;
  if exists (select 1 from pg_roles where rolname = 'pokoin_api_write') then
    grant select, insert, update on public.cardtrader_zero_picks to pokoin_api_write;
    grant usage, select on sequence public.cardtrader_zero_picks_id_seq to pokoin_api_write;
  end if;
  if exists (select 1 from pg_roles where rolname = 'pokoin_jobs') then
    grant select on public.cardtrader_zero_picks to pokoin_jobs;
  end if;
end $$;
