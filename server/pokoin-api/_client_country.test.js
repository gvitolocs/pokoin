'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  countryFromRequestHeaders,
  shipFromCountryFromRequest,
  isAllowedShipFromCountry,
} = require('./_client_country');

test('countryFromRequestHeaders prefers Cloudflare then Vercel', () => {
  assert.equal(countryFromRequestHeaders({ 'cf-ipcountry': 'hu' }), 'HU');
  assert.equal(countryFromRequestHeaders({ 'x-vercel-ip-country': 'IT' }), 'IT');
  assert.equal(countryFromRequestHeaders({ 'cf-ipcountry': 'XX' }), '');
  assert.equal(countryFromRequestHeaders({ 'cf-ipcountry': 'EU' }), '');
  assert.equal(countryFromRequestHeaders({}), '');
});

test('shipFromCountryFromRequest only seeds allowed EU sell-from countries', () => {
  assert.equal(shipFromCountryFromRequest({ 'cf-ipcountry': 'DK' }), 'DK');
  assert.equal(shipFromCountryFromRequest({ 'cf-ipcountry': 'US' }), '');
  assert.equal(shipFromCountryFromRequest({ 'cf-ipcountry': 'GB' }), '');
  assert.equal(isAllowedShipFromCountry('IT'), true);
  assert.equal(isAllowedShipFromCountry('US'), false);
});
