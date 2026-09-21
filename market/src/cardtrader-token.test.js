import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeCardTraderToken,
  normalizeCardTraderToken,
} from './cardtrader-token.js';

// Same shape as a CardTrader app token: RS256, 2048-bit signature (256 bytes).
function fakeCardTraderJwt({ signatureBytes = 256, name = 'Seller 1-Day Ready App' } = {}) {
  const segment = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    segment({ alg: 'RS256' }),
    segment({ iss: 'cardtrader-production', sub: 'app:14299', iat: 1789991482, name }),
    Buffer.alloc(signatureBytes, 9).toString('base64url'),
  ].join('.');
}

test('normalizeCardTraderToken strips wrapping, prefixes, quotes, and autofilled text', () => {
  const jwt = fakeCardTraderJwt();

  assert.equal(normalizeCardTraderToken(jwt), jwt);
  assert.equal(normalizeCardTraderToken(`  ${jwt}\n`), jwt);
  assert.equal(normalizeCardTraderToken(`${jwt.slice(0, 80)}\n${jwt.slice(80)}`), jwt);
  assert.equal(normalizeCardTraderToken(`Bearer ${jwt}`), jwt);
  assert.equal(normalizeCardTraderToken(`'${jwt}'`), jwt);
  assert.equal(normalizeCardTraderToken(`\u200B${jwt}\uFEFF`), jwt);
  assert.equal(normalizeCardTraderToken(`MyPokoinPassw0rd!${jwt}`), jwt);
  assert.equal(normalizeCardTraderToken(' "ct_legacy_token" '), 'ct_legacy_token');
  assert.equal(normalizeCardTraderToken(undefined), '');
});

test('describeCardTraderToken reads the app name and issue time of a whole token', () => {
  const jwt = fakeCardTraderJwt();
  const info = describeCardTraderToken(jwt);

  assert.equal(info.token, jwt);
  assert.equal(info.jwt, true);
  assert.equal(info.complete, true);
  assert.equal(info.cleaned, false);
  assert.equal(info.problem, '');
  assert.equal(info.appName, 'Seller 1-Day Ready App');
  assert.equal(info.issuedAt.toISOString(), '2026-09-21T11:51:22.000Z');
});

test('describeCardTraderToken decodes UTF-8 app names', () => {
  const info = describeCardTraderToken(fakeCardTraderJwt({ name: 'Negozio Pokémon' }));
  assert.equal(info.appName, 'Negozio Pokémon');
});

test('describeCardTraderToken flags what the paste changed', () => {
  const jwt = fakeCardTraderJwt();

  assert.equal(describeCardTraderToken(`  ${jwt}  `).cleaned, false);
  const autofilled = describeCardTraderToken(`hunter2${jwt}`);
  assert.equal(autofilled.cleaned, true);
  assert.equal(autofilled.token, jwt);
  assert.equal(autofilled.complete, true);
});

test('describeCardTraderToken spots cut-off, extended, and non-token pastes', () => {
  const jwt = fakeCardTraderJwt();

  assert.equal(describeCardTraderToken(jwt.slice(0, -40)).problem, 'incomplete');
  assert.equal(describeCardTraderToken(`${jwt}Passw0rd`).problem, 'incomplete');
  assert.equal(describeCardTraderToken('my-site-password').problem, 'not_token');
  assert.equal(describeCardTraderToken('').problem, '');
  assert.equal(describeCardTraderToken('   ').token, '');
});
