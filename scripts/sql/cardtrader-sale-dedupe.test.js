import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pipeline = readFileSync(new URL('./listing-pipeline.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('./092_cardtrader_sale_dedupe.sql', import.meta.url), 'utf8');

function assertTriggerContract(sql) {
  assert.match(sql, /is_cardtrader_link boolean := false/);
  assert.match(sql, /source_listing_id[\s\S]*like 'ct:%'/);
  assert.match(
    sql,
    /if is_cardtrader_link and is_sold then[\s\S]*ev := 'cardtrader_synced';[\s\S]*sold_qty := 0;[\s\S]*is_sold := false;/,
  );
}

test('linked CardTrader quantity drops are audit-only, never native sales', () => {
  assertTriggerContract(pipeline);
  assertTriggerContract(migration);
});

test('migration reclassifies prior mirror events and deterministically rebuilds native sold counters', () => {
  assert.match(
    migration,
    /update public\.marketplace_user_listing_events event[\s\S]*set event_type = 'cardtrader_synced'/,
  );
  assert.match(migration, /marketplace_cardtrader_product_links link/);
  assert.match(
    migration,
    /update public\.marketplace_listing_stats_daily[\s\S]*sold_listings = 0,[\s\S]*sold_quantity = 0/,
  );
  assert.match(
    migration,
    /where event\.event_type in \('sold', 'quantity_decreased'\)[\s\S]*on conflict \(card_id, observed_day, source\) do update set/,
  );
  assert.match(migration, /select public\.refresh_marketplace_card_weights\(\);/);
});
