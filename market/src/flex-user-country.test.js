import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countryFromCfTrace,
  pickAllowedCountry,
  resolveFlexDefaultCountries,
} from './flex-user-country.js';

test('countryFromCfTrace reads loc=', () => {
  assert.equal(countryFromCfTrace('ip=1.2.3.4\nloc=IT\ncolo=MXP\n'), 'IT');
  assert.equal(countryFromCfTrace('loc=dk'), 'DK');
  assert.equal(countryFromCfTrace('nope'), '');
});

test('pickAllowedCountry clamps to the live set', () => {
  const allowed = new Set(['DK', 'IT', 'DE']);
  assert.equal(pickAllowedCountry('it', allowed), 'IT');
  assert.equal(pickAllowedCountry('US', allowed), '');
});

test('resolveFlexDefaultCountries prefers profile, then IP, then locale', async () => {
  const allowed = ['DK', 'IT', 'DE'];

  const profile = await resolveFlexDefaultCountries({
    allowedFrom: allowed,
    allowedTo: allowed,
    signedIn: true,
    loadProfileCountry: async () => 'IT',
    fetchTrace: async () => 'loc=DE\n',
    localeCountry: 'DK',
  });
  assert.deepEqual(profile, { from: 'IT', to: 'IT', source: 'profile' });

  const ip = await resolveFlexDefaultCountries({
    allowedFrom: allowed,
    allowedTo: allowed,
    signedIn: true,
    loadProfileCountry: async () => '',
    fetchTrace: async () => 'loc=DE\n',
    localeCountry: 'IT',
  });
  assert.deepEqual(ip, { from: 'DE', to: 'DE', source: 'ip' });

  const locale = await resolveFlexDefaultCountries({
    allowedFrom: allowed,
    allowedTo: allowed,
    signedIn: false,
    fetchTrace: async () => { throw new Error('offline'); },
    localeCountry: 'IT',
  });
  assert.deepEqual(locale, { from: 'IT', to: 'IT', source: 'locale' });
});
