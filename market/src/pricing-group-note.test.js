import assert from 'node:assert/strict';
import test from 'node:test';
import { groupPriceNote, leftGroupLine, listingPricingGroup } from './pricing-group-note.js';

const data = {
  groups: [{ id: 'pg_1', name: 'Riftbound bulk', strategyId: 'st_a' }, { id: 'pg_2', name: '' }],
  memberships: [['l-1', 'pg_1'], ['42', 'pg_2'], ['l-9', 'pg_gone']],
};

test('a listing reads its group from the memberships', () => {
  assert.deepEqual(listingPricingGroup(data, 'l-1'), { id: 'pg_1', name: 'Riftbound bulk' });
  assert.deepEqual(listingPricingGroup(data, 42), { id: 'pg_2', name: '' }, 'ids compare as strings');
  assert.equal(listingPricingGroup(data, 'l-2'), null, 'in no group');
  assert.equal(listingPricingGroup(data, 'l-9'), null, 'its group is gone');
  assert.equal(listingPricingGroup(null, 'l-1'), null);
  assert.equal(listingPricingGroup({}, 'l-1'), null);
  assert.equal(listingPricingGroup(data, ''), null);
});

test('the price note names the group, or says nothing', () => {
  assert.equal(
    groupPriceNote({ id: 'pg_1', name: 'Riftbound bulk' }),
    'Priced by your pricing group “Riftbound bulk”. Typing a new price takes this card out of the group.',
  );
  assert.equal(groupPriceNote({ id: 'pg_2', name: '' }), 'Priced by a pricing group. Typing a new price takes this card out of the group.');
  assert.equal(groupPriceNote(null), '');
  assert.equal(groupPriceNote({ name: 'x' }), '');
});

test('a save that left the group says so', () => {
  assert.equal(
    leftGroupLine({ id: 'l-1', leftPricingGroup: { id: 'pg_1', name: 'Riftbound bulk' } }),
    'It left the pricing group “Riftbound bulk”: the price is yours now.',
  );
  assert.equal(
    leftGroupLine({ listing: { leftPricingGroup: { id: 'pg_1', name: 'Rares' } } }),
    'It left the pricing group “Rares”: the price is yours now.',
  );
  assert.equal(leftGroupLine({ leftPricingGroup: { id: 'pg_2', name: '' } }), 'It left its pricing group: the price is yours now.');
  assert.equal(leftGroupLine({ leftPricingGroup: null }), '');
  assert.equal(leftGroupLine(null), '');
});
