-- Commerce crate schema (pokoin-rust/crates/commerce/sql/001_commerce.sql).
--
-- STORAGE CONTRACT (corrected 2026-10-08 per coordinator)
-- -------------------------------------------------------------------------
-- This file creates NO new tables. Every stateful contract stays where the
-- Node runtime kept it:
--
--   Firestore (native client in crates/commerce/src/firestore.rs):
--     balances/{uid}                     availablePkn, lockedPkn, updatedAt
--     ledger_entries/{id}                uid, type, amountPkn, counterpartyUid,
--                                        counterpartyUsername, ref, ...meta, createdAt
--     commerce_idempotency/{hash}       replay guard (original key stored inside)
--     native_pkn_deposits/{txHash}       verified on-chain funding
--     withdraw_requests/{id}             PKN withdrawals
--     pkn_purchases/{stripeSessionId}    Stripe PKN checkout credit
--     orders/{orderId}                   marketplace orders (PKN + EUR)
--     marketplace_sales/{id}             Sold-on-Pokoin rows
--     money_requests/{id}, notifications/{id}
--     users/{uid}, usernames/{username}, wallet_addresses/{...}
--     users/{uid}/shipping_addresses/{id}
--     outbox/{id}                        queued email (no SMTP at request time)
--     crypto_pkn_purchase_quotes|_requests|_deposits/{id}
--     crypto_pkn_sale_quotes|_requests|_payouts/{id}
--     wpkn_exchange_quotes|_requests|_deposits/{id}
--     wpkn_exchange_config/reserves
--
--   Postgres (existing tables from scripts/sql, used as-is):
--     READ  -> MARKETPLACE_DATABASE_URL            (Pi replica; never written)
--     WRITE -> MARKETPLACE_WRITER_DATABASE_URL     (nezopt 15T writer)
--     marketplace_user_listings, marketplace_user_carts,
--     marketplace_user_recents, marketplace_checkout_holds, shipping_rates,
--     marketplace_rate_limits, marketplace_search_candidates, marketplace_cards,
--     marketplace_card_versions, marketplace_card_cart_users/_analytics,
--     marketplace_card_watchlist_users/_analytics, marketplace_card_events,
--     cardtrader_pokemon_blueprints
--
-- No Firestore state was re-created in SQL and no wallet/user/ledger/order
-- table exists in this crate.

set statement_timeout = 0;

-- Preflight: fail loudly if the marketplace read model the commerce routes
-- depend on is not present on the target database. This creates nothing.
do $$
declare
  required text[] := array[
    'marketplace_user_listings',
    'marketplace_user_carts',
    'marketplace_user_recents',
    'marketplace_checkout_holds',
    'marketplace_search_candidates',
    'marketplace_cards'
  ];
  missing text[] := array[]::text[];
  item text;
begin
  foreach item in array required loop
    if not exists (
      select 1
        from information_schema.tables
       where table_schema = 'public'
         and table_name = item
    ) then
      missing := missing || item;
    end if;
  end loop;
  if array_length(missing, 1) > 0 then
    raise warning 'commerce preflight: missing marketplace tables: %', array_to_string(missing, ', ');
  else
    raise notice 'commerce preflight: marketplace read model present';
  end if;
end $$;

-- Optional (safe, re-runnable) indexes for the commerce read patterns.
-- These only touch existing marketplace tables.
create index if not exists marketplace_user_listings_seller_status_idx
  on public.marketplace_user_listings (seller_uid, status, quantity_available)
  where seller_uid is not null;

create index if not exists marketplace_user_listings_card_active_idx
  on public.marketplace_user_listings (card_id, price_pkn)
  where status = 'active' and quantity_available > 0;
