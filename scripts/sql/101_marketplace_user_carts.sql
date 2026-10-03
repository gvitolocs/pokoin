-- Signed-in cart for pokoin.com/cart (GET/PUT /api/marketplace-cart-sync).
-- One row per Firebase user: cart lines, Saved for later, gift flag.
-- Writes: nezopt marketplace writer (MARKETPLACE_WRITER_DATABASE_URL).
-- Pi replica streams — never migrate on the replica.
-- card_ids (cart + saved) backs "Customers who carried these also carried"
-- in GET /api/marketplace-recommendations via the GIN overlap index.

set statement_timeout = 0;

create table if not exists public.marketplace_user_carts (
  user_uid text primary key,
  items jsonb not null default '[]'::jsonb,
  saved jsonb not null default '[]'::jsonb,
  gift boolean not null default false,
  card_ids bigint[] not null default '{}'::bigint[],
  rev bigint not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists marketplace_user_carts_card_ids_gin
  on public.marketplace_user_carts using gin (card_ids);

create index if not exists marketplace_user_carts_updated_idx
  on public.marketplace_user_carts (updated_at desc);
