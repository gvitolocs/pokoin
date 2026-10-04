'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeService,
  packageTierForCount,
  priceToEurCents,
  defaultZip,
} = require('./_packlink');

test('package tiers match cart letter/parcel cutovers', () => {
  assert.equal(packageTierForCount(1), 'SMALL');
  assert.equal(packageTierForCount(20), 'MEDIUM');
  assert.equal(packageTierForCount(21), 'LARGE');
});

test('priceToEurCents reads Packlink price objects', () => {
  assert.equal(priceToEurCents(12.92), 1292);
  assert.equal(priceToEurCents({ total_price: 12.92, currency: 'EUR' }), 1292);
  assert.equal(priceToEurCents({ total_price: 12.92, currency: 'USD' }), null);
});

test('normalizeService builds packlink: ids', () => {
  const row = normalizeService({
    id: 22131,
    name: 'Standard Access Point',
    carrier_name: 'UPS',
    price: { total_price: 12.92, currency: 'EUR' },
  });
  assert.equal(row.id, 'packlink:22131');
  assert.equal(row.amountCents, 1292);
  assert.match(row.label, /UPS/);
  assert.equal(row.source, 'packlink');
});

test('defaultZip covers seller origins', () => {
  assert.equal(defaultZip('IT'), '20121');
  assert.equal(defaultZip('DK'), '2100');
});
