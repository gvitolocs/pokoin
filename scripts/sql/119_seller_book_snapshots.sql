-- Seller shop snapshots: the stored seller books of migration 116, served
-- public and pre-compressed as GET /api/marketplace-list?kind=seller&key=<username>
-- (`pokoin-rust/apps/api/src/lists.rs`), built off the Pi by the k3s CronJob
-- build-lists-sellers (`pokoin-api job build-lists --kind=seller`, against the
-- nezopt writer; `seller_book::build_all`).
--
--   username  the lowercase shop handle (/marketplace/:lang/users/:username)
--   version   hash of `body`: the ETag, and the `v=` a page asks for when
--             GET /api/marketplace-seller-shop?fresh=1 says a newer book is stored
--   br        brotli 11 of `body`, written by the builder only; an API instance
--             that rebuilds a book stores null and the next builder run fills it
--
-- Apply on the nezopt writer before deploying the API; the Pi replica
-- receives it by replication. Idempotent. The builder no longer applies it
-- itself (2026-10-15): its role has no DDL rights.
alter table public.marketplace_seller_books add column if not exists username text;
alter table public.marketplace_seller_books add column if not exists version text;
alter table public.marketplace_seller_books add column if not exists br bytea;
create index if not exists marketplace_seller_books_username_idx
  on public.marketplace_seller_books (game, username);
