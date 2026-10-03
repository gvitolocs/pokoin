'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const clientCountry = require('./client-country');

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('client country is the edge IP and is not cached for the next visitor', async () => {
  const res = mockRes();
  await clientCountry({ method: 'GET', headers: { 'cf-ipcountry': 'it' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.country, 'IT');
  assert.match(res.headers['Cache-Control'], /no-store/);
  assert.equal(res.headers['CDN-Cache-Control'], 'no-store');
});

test('an unknown edge country stays empty', async () => {
  const res = mockRes();
  await clientCountry({ method: 'GET', headers: { 'cf-ipcountry': 'T1' } }, res);
  assert.equal(res.body.country, '');
});
