'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  evaluateStrategyTarget,
  sanitizeSettings,
  sanitizeStrategy,
  strategyMatchesRow,
} = require('./marketplace-pricing-strategies.js')._test;

test('sanitizeStrategy validates and normalizes', () => {
  const strategy = sanitizeStrategy({
    name: 'Undercut CT',
    source: 'cardtrader',
    action: 'undercut',
    amountPct: 150,
    amountPkn: -5,
    rounding: 'weird',
    condition: 'nm',
  });
  assert.equal(strategy.amountPct, 90);
  assert.equal(strategy.amountPkn, 0);
  assert.equal(strategy.rounding, 'none');
  assert.equal(strategy.condition, 'NM');
  assert.equal(strategy.enabled, true);
  assert.match(strategy.id, /^st_/);
  assert.throws(() => sanitizeStrategy({ name: '', source: 'cardtrader', action: 'match' }), /name is required/);
  assert.throws(() => sanitizeStrategy({ name: 'x', source: 'ebay', action: 'match' }), /pokoin or cardtrader/);
});

test('strategy math: match, undercut and premium with floor and rounding', () => {
  const match = { action: 'match', amountPct: 0, amountPkn: 0, minPkn: 0, rounding: 'none' };
  assert.equal(evaluateStrategyTarget(219, match), 219);
  assert.equal(evaluateStrategyTarget(null, match), null);

  const undercut = { action: 'undercut', amountPct: 5, amountPkn: 1, minPkn: 1, rounding: 'none' };
  assert.equal(evaluateStrategyTarget(200, undercut), 189); // 200*0.95 - 1

  const premium = { action: 'premium', amountPct: 10, amountPkn: 2, minPkn: 0, rounding: 'integer' };
  assert.equal(evaluateStrategyTarget(100, premium), 112); // 110 + 2 rounds

  const floored = { action: 'match', amountPct: 0, amountPkn: 0, minPkn: 50, rounding: 'none' };
  assert.equal(evaluateStrategyTarget(20, floored), 50);
});

test('strategy scope matching skips disabled and out-of-scope rows', () => {
  const strategy = sanitizeStrategy({
    name: 'NM IT only',
    source: 'cardtrader',
    action: 'match',
    condition: 'NM',
    language: 'IT',
    enabled: true,
  });
  assert.equal(strategyMatchesRow(strategy, { condition: 'NM', language: 'IT' }), true);
  assert.equal(strategyMatchesRow(strategy, { condition: 'SP', language: 'IT' }), false);
  assert.equal(strategyMatchesRow({ ...strategy, enabled: false }, { condition: 'NM', language: 'IT' }), false);
});

test('pricer settings clamp to known sources', () => {
  assert.deepEqual(sanitizeSettings({ defaultSource: 'ebay' }), { defaultSource: 'cardtrader', autoMarketColumn: false });
  assert.deepEqual(sanitizeSettings({ defaultSource: 'pokoin', autoMarketColumn: true }), { defaultSource: 'pokoin', autoMarketColumn: true });
  assert.deepEqual(sanitizeSettings({}), { defaultSource: 'cardtrader', autoMarketColumn: false });
});
