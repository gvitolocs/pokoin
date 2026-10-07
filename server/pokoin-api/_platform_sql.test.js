'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SQL_PATH = path.join(__dirname, '..', '..', 'scripts', 'sql', '111_marketplace_platform_sync.sql');
const SQL = fs.readFileSync(SQL_PATH, 'utf8');

test('migration 111 is idempotent and transactional', () => {
  assert.match(SQL, /^\s*--/m);
  assert.match(SQL, /\bbegin;/i);
  assert.match(SQL, /\bcommit;\s*$/i);
  assert.match(SQL, /create table if not exists public\.marketplace_platform_links/i);
  assert.match(SQL, /create table if not exists public\.marketplace_platform_sync_events/i);
  assert.match(SQL, /create index if not exists idx_marketplace_platform_links_seller_provider/i);
  assert.match(SQL, /create unique index if not exists uq_marketplace_platform_links_seller_provider_external/i);
  assert.match(SQL, /create or replace function public\.marketplace_user_listings_audit/i);
});

test('marketplace_platform_links models one row per listing and provider', () => {
  assert.match(SQL, /listing_id uuid not null references public\.marketplace_user_listings\(id\) on delete cascade/i);
  assert.match(SQL, /primary key \(listing_id, provider\)/i);
  assert.match(SQL, /unique index if not exists uq_marketplace_platform_links_seller_provider_external[\s\S]*?\(seller_uid, provider, external_id\)/i);
  assert.match(SQL, /external_meta jsonb not null default '\{\}'/i);
  assert.match(SQL, /match_method text not null check \(match_method in \('sku','import','manual'\)\)/i);
  assert.match(SQL, /last_pushed_at timestamptz/i);
  assert.match(SQL, /last_error text/i);
});

test('the provider check constraint lists every provider including cardtrader', () => {
  const providers = ['shopify', 'binderpos', 'cardmarket', 'tcgplayer', 'ccgseller', 'storepass', 'sortswift', 'magus', 'cardtrader'];
  for (const provider of providers) {
    assert.ok(SQL.includes(`'${provider}'`), `missing provider ${provider}`);
  }
  assert.match(SQL, /provider text not null check \(provider in \(/i);
});

test('marketplace_platform_sync_events is the exactly-once claim key', () => {
  assert.match(SQL, /create table if not exists public\.marketplace_platform_sync_events/i);
  assert.match(
    SQL,
    /primary key \(seller_uid, provider, external_order_id, external_item_id, kind\)/i,
  );
  assert.match(SQL, /kind text not null check \(kind in \('sale','cancel'\)\)/i);
  assert.match(SQL, /quantity integer not null check \(quantity > 0\)/i);
  assert.match(SQL, /listing_id uuid not null references public\.marketplace_user_listings\(id\) on delete cascade/i);
});

test('the audit trigger records platform_synced after cardtrader_synced', () => {
  const cardtraderAt = SQL.indexOf("ev := 'cardtrader_synced'");
  const platformGuardAt = SQL.indexOf("if is_sold and coalesce(current_setting('pokoin.platform_sync', true), '') <> '' then");
  const platformAt = SQL.indexOf("ev := 'platform_synced'");
  assert.ok(cardtraderAt > -1, 'cardtrader_synced block missing');
  assert.ok(platformGuardAt > cardtraderAt, 'platform_sync guard must follow cardtrader_synced');
  assert.ok(platformAt > platformGuardAt, 'platform_synced must follow its guard');

  const platformBlock = SQL.slice(platformGuardAt, platformAt + 120);
  assert.match(platformBlock, /sold_qty := 0/);
  assert.match(platformBlock, /is_sold := false/);
});

test('the trigger keeps the CardTrader flag and the audit/stat writes', () => {
  assert.match(SQL, /is_cardtrader_link := lower\(coalesce\(new\.source_listing_id, ''\)\) like 'ct:%'/i);
  assert.match(SQL, /insert into public\.marketplace_user_listing_events/i);
  assert.match(SQL, /insert into public\.marketplace_listing_stats_daily/i);
  assert.match(SQL, /on conflict \(card_id, observed_day, source\) do update/i);
});
