-- Google Merchant sync status. Apply on the nezopt writer only.
-- A missing table must not fail a listing transaction: the sync writer ignores 42P01.

create table if not exists public.google_merchant_products (
  listing_id text not null,
  currency text not null,
  offer_id text not null,
  seller_uid text not null default '',
  card_id text not null default '',
  status text not null,
  reason_code text not null default '',
  price_amount text not null default '',
  price_currency text not null default '',
  google_name text not null default '',
  last_error text not null default '',
  updated_at timestamptz not null default now(),
  primary key (listing_id, currency)
);

create index if not exists google_merchant_products_status_idx
  on public.google_merchant_products (status, updated_at);
