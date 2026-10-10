import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import spaRates from './shipping-rates.json' with { type: 'json' };
import { SHIP_FROM_COUNTRIES, SHIP_TO_COUNTRIES } from './ship-countries.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, '..', '..');
const apiRates = JSON.parse(fs.readFileSync(path.join(repo, 'pokoin-rust/crates/commerce/assets/shipping-rates.json'), 'utf8'));
const syncSrc = fs.readFileSync(path.join(repo, 'scripts/sync-shipping-rates.py'), 'utf8');

function pythonTuple(name) {
  const match = syncSrc.match(new RegExp(`${name} = \\(([^)]*)\\)`));
  assert.ok(match, `${name} in sync-shipping-rates.py`);
  return [...match[1].matchAll(/"([A-Z]{2})"/g)].map((row) => row[1]);
}

const senders = pythonTuple('COUNTRIES');
const destinations = [...pythonTuple('EU_DESTINATIONS'), ...pythonTuple('WORLD_DESTINATIONS')];

test('the buyer country list is exactly what the rates sync quotes', () => {
  assert.deepEqual(SHIP_TO_COUNTRIES.map((row) => row.code).sort(), [...destinations].sort());
  for (const code of senders) {
    assert.ok(SHIP_FROM_COUNTRIES.some((row) => row.code === code), `${code} is a seller country`);
  }
});

test('every rate is between a seller country and a buyer country', () => {
  const to = new Set(destinations);
  const from = new Set(senders);
  for (const rate of apiRates.rates) {
    assert.ok(from.has(rate.fromCountry), rate.id);
    assert.ok(to.has(rate.toCountry), rate.id);
  }
});

test('Italian sellers (nearly all listings) reach every buyer country at every card-parcel size', () => {
  const have = new Set(apiRates.rates.map((rate) => `${rate.fromCountry}>${rate.toCountry}:${rate.packageTier}`));
  const missing = [];
  for (const to of destinations) {
    for (const tier of ['SMALL', 'MEDIUM', 'LARGE']) {
      if (!have.has(`IT>${to}:${tier}`)) missing.push(`IT>${to}:${tier}`);
    }
  }
  assert.deepEqual(missing, []);
  for (const to of ['US', 'JP', 'CN', 'GB', 'AU', 'KR', 'CA']) {
    assert.ok(apiRates.rates.some((rate) => rate.fromCountry === 'IT' && rate.toCountry === to), `IT>${to}`);
  }
});

test('the SPA preview and the checkout API price the same rates', () => {
  const api = new Map(apiRates.rates.map((rate) => [rate.id, rate]));
  assert.equal(spaRates.rates.length, apiRates.rates.length);
  for (const rate of spaRates.rates) {
    const twin = api.get(rate.id);
    assert.ok(twin, rate.id);
    assert.equal(rate.priceEURCents, twin.priceEURCents, rate.id);
    assert.equal(rate.tracked, twin.tracked, rate.id);
    assert.equal(rate.packageTier, twin.packageTier, rate.id);
  }
  assert.deepEqual(spaRates.tiers, apiRates.tiers);
});
