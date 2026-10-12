-- Stored seller books: a seller's whole shop in the compact c1 form, built
-- off the request path and served with one primary-key read
-- (`pokoin-rust/crates/commerce/src/handlers/seller_book.rs`).
--
-- `stamp` is the seller's max(updated_at) when the book was built and
-- `profile` the seller fields written into its rows; a request compares both
-- with the shop as it is now. A book that no longer matches is still served
-- while its replacement is built. `requested_at` is refreshed at most hourly;
-- books nobody has asked for in two days are no longer rebuilt.
--
-- Apply on the nezopt writer; the Pi replica receives it by replication.
-- Without the table every request builds its own book, as before.
create table if not exists public.marketplace_seller_books (
  seller_uid text not null,
  game text not null,
  stamp text not null,
  profile text not null default '',
  seller jsonb not null,
  body bytea not null,
  listings integer not null default 0,
  built_at timestamptz not null default now(),
  requested_at timestamptz not null default now(),
  primary key (seller_uid, game)
);
