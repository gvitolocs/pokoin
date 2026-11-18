import assert from 'node:assert/strict';
import test from 'node:test';
import { BUYER_COUNTRY_KEY, readBuyerCountry, writeBuyerCountry } from './buyer-country.js';

function memoryStorage(start = {}) {
  const data = { ...start };
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value);
    },
  };
}

test('the buyer country is kept per uid for the next first paint', () => {
  const store = memoryStorage();
  assert.equal(readBuyerCountry('u1', store), null);
  writeBuyerCountry('u1', 'dk', store);
  assert.deepEqual(readBuyerCountry('u1', store), { uid: 'u1', country: 'DK' });
  // Another account on this browser waits for its own settings read.
  assert.equal(readBuyerCountry('u2', store), null);
  assert.equal(readBuyerCountry('', store), null);
});

test('a known empty country is still known, and junk reads as unknown', () => {
  const store = memoryStorage();
  writeBuyerCountry('u1', '', store);
  assert.deepEqual(readBuyerCountry('u1', store), { uid: 'u1', country: '' });
  assert.equal(readBuyerCountry('u1', memoryStorage({ [BUYER_COUNTRY_KEY]: '{oops' })), null);
  writeBuyerCountry('', 'IT', store);
  assert.deepEqual(readBuyerCountry('u1', store), { uid: 'u1', country: '' });
});
