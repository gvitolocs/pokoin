'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFirestore } = require('./_firestore_fake');
const { acceptsPknFrom, assertSellersAcceptPkn, sellersRefusingPkn } = require('./_seller_pkn_policy');

const world = () => createFirestore({
  users: {
    anna: { username: 'anna' },
    marco: { username: 'marco', acceptsPkn: false },
    luca: { username: 'luca', acceptsPkn: true },
  },
});

test('PKN is accepted unless the seller opted out', () => {
  assert.equal(acceptsPknFrom(undefined), true);
  assert.equal(acceptsPknFrom({}), true);
  assert.equal(acceptsPknFrom({ acceptsPkn: true }), true);
  assert.equal(acceptsPknFrom({ acceptsPkn: false }), false);
});

test('PKN checkout refuses carts with an opted-out seller', async () => {
  const { firestore } = world();
  assert.deepEqual(await sellersRefusingPkn(firestore, ['anna', 'marco', 'luca', 'ct-external', 'marco']), [{ uid: 'marco', name: 'marco' }]);
  await assertSellersAcceptPkn(firestore, ['anna', 'luca', 'ct-external']);
  await assert.rejects(assertSellersAcceptPkn(firestore, ['anna', 'marco']), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'seller_no_pkn');
    assert.match(error.message, /marco accepts card payments only/);
    return true;
  });
});
