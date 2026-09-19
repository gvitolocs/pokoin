import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultInventoryTargets,
  inventoryTargetsLabel,
} from './inventory-targets.js';

test('default inventory targets follow CardTrader connection', () => {
  assert.deepEqual(defaultInventoryTargets(true), { pokoin: true, cardtrader: true });
  assert.deepEqual(defaultInventoryTargets(false), { pokoin: true, cardtrader: false });
});

test('inventoryTargetsLabel covers dual and single destinations', () => {
  assert.equal(
    inventoryTargetsLabel({ cards: 2 }, { targets: { pokoin: true, cardtrader: true } }),
    'Add 2 cards to Pokoin + CardTrader',
  );
  assert.equal(
    inventoryTargetsLabel({ cards: 1 }, { verb: 'List', targets: { pokoin: true, cardtrader: false } }),
    'List card on Pokoin',
  );
  assert.equal(
    inventoryTargetsLabel({ cards: 3 }, { verb: 'List', targets: { pokoin: false, cardtrader: true } }),
    'List 3 cards to CardTrader',
  );
});
