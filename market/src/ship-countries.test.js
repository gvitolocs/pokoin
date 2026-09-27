import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  countryFlagEmoji,
  SHIP_FROM_COUNTRIES,
  shipFromCountryOptionLabel,
} from './ship-countries.js';

test('ship-from options are flag emoji + long country name', () => {
  assert.equal(shipFromCountryOptionLabel('HU'), '🇭🇺 Hungary');
  assert.equal(shipFromCountryOptionLabel('IT'), '🇮🇹 Italy');
  assert.equal(countryFlagEmoji('DE'), '🇩🇪');
  assert.equal(countryFlagEmoji('EU'), '');
  assert.ok(SHIP_FROM_COUNTRIES.every((row) => row.code && row.name));
});

test('seller country select uses long names, not bare ISO codes', () => {
  const src = readFileSync(new URL('./components/SellerShippingSettings.jsx', import.meta.url), 'utf8');
  assert.match(src, /shipFromCountryOptionLabel/);
  assert.match(src, /SHIP_FROM_COUNTRIES/);
  assert.equal(src.includes(">{code}</option>"), false);
});
