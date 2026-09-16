import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASSET_COVERAGE_LINE,
  DISPUTE_DECISION,
  DISPUTE_REPLY,
  ESCROW_LINE,
  NO_SHIP_GUARANTEE,
  PROTECTION_PILLARS,
  SHIP_DAYS,
} from './buyer-protection.js';

test('homepage protection states escrow, no-ship refund, and dispute times', () => {
  assert.equal(ASSET_COVERAGE_LINE, '100% coverage on your assets');
  assert.equal(ESCROW_LINE, 'Funds released only after delivery confirmed.');
  assert.match(NO_SHIP_GUARANTEE, /7 days/);
  assert.match(NO_SHIP_GUARANTEE, /PKN/);
  assert.equal(SHIP_DAYS, 7);
  assert.equal(DISPUTE_REPLY, '48 hours');
  assert.equal(DISPUTE_DECISION, '5 business days');
  assert.equal(PROTECTION_PILLARS.length, 3);
  assert.doesNotMatch(PROTECTION_PILLARS.map((row) => row.body).join(' '), /livechat|24\/7|quality control/i);
});
