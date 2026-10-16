import assert from 'node:assert/strict';
import test from 'node:test';
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
