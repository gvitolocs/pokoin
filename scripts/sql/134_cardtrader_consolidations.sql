-- 134: a CardTrader product being consolidated (2026-10-22).
--
-- `job cardtrader-group-products` folds a seller's identical CardTrader
-- products into one kept product: per duplicate it moves the duplicate's
-- Pokoin listings onto the kept product, deletes the duplicate on CardTrader,
-- then gives the kept product the copies it took over. Between those steps
-- the kept product's members hold more copies than CardTrader lists, and the
-- reconcile would copy CardTrader's lower quantity back onto them
-- (group::distribute), losing copies. While a row here is open
-- (closed_at null) the reconcile leaves that product's quantity alone; the
-- job (or its rerun, from its journal) closes it.
--
-- pokoin-rust/apps/api/src/jobs/group_products.rs, docs/CARDTRADER_SELLER_SYNC.md.

create table if not exists public.marketplace_cardtrader_consolidations (
  seller_uid text not null,
  kept_product_id text not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  primary key (seller_uid, kept_product_id)
);
