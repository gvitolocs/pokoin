import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conditionShort,
  conditionTone,
  isReserveSeller,
  listingExtraTags,
  listingLanguageFlag,
  publicListingSellerName,
  sellerCountryFlag,
  sellerHandle,
  sellerHref,
} from './listing-meta.js';

test('condition tones match CardTrader grades', () => {
  assert.equal(conditionTone('NM'), 'nm');
  assert.equal(conditionTone('Near Mint'), 'nm');
  assert.equal(conditionTone('SP'), 'sp');
  assert.equal(conditionTone('Slightly Played'), 'sp');
  assert.equal(conditionTone('MP'), 'mp');
  assert.equal(conditionTone('Played'), 'pl');
  assert.equal(conditionTone('HP'), 'pl');
  assert.equal(conditionTone('Heavily Played'), 'pl');
  assert.equal(conditionTone('PO'), 'poor');
  assert.equal(conditionTone('Poor'), 'poor');
  assert.equal(conditionShort('Near Mint'), 'NM');
  assert.equal(conditionShort('HP'), 'PL');
  assert.equal(conditionShort('PO'), 'PO');
  assert.equal(conditionShort('Poor'), 'PO');
});

test('listing language uses circle flags, not EN text', () => {
  assert.equal(listingLanguageFlag('EN').code, 'en');
  assert.equal(listingLanguageFlag('en').src.includes('/flags/en.svg'), true);
  assert.equal(listingLanguageFlag('IT').code, 'it');
  assert.equal(listingLanguageFlag('JP').code, 'jp');
  assert.equal(listingLanguageFlag(''), null);
});

test('seller country flag sits next to the username', () => {
  assert.equal(sellerCountryFlag('IT').code, 'it');
  assert.equal(sellerCountryFlag('IT').label, 'Italy');
  assert.equal(sellerCountryFlag('EU').code, 'eu');
  assert.equal(sellerCountryFlag('US').code, 'us');
});

test('native seller profile is a users path; reserve is not', () => {
  assert.equal(sellerHandle({ sellerName: 'vitologiuseppe17' }), 'vitologiuseppe17');
  assert.equal(
    sellerHref({ sellerName: 'vitologiuseppe17' }, 'en'),
    '/marketplace/en/users/vitologiuseppe17',
  );
  assert.equal(isReserveSeller({ sellerReputationLabel: 'pknreserve' }), true);
  assert.equal(sellerHref({ sellerReputationLabel: 'pknreserve', sellerName: 'pknreserve' }, 'en'), '');
  assert.equal(
    sellerHref({ sellerName: 'Giuseppe', sellerUsername: 'vitologiuseppe17' }, 'en'),
    '/marketplace/en/users/vitologiuseppe17',
  );
  assert.deepEqual(listingExtraTags({ reverse: true, language: 'EN' }), ['Reverse']);
});

test('public seller label never shows email; falls back to handle', () => {
  assert.equal(
    publicListingSellerName(
      { sellerName: 'redshakkio@gmail.com', sellerUsername: 'redshakkio' },
      'redshakkio',
    ),
    'redshakkio',
  );
  assert.equal(
    publicListingSellerName({ sellerName: 'Simone', sellerUsername: 'redshakkio' }),
    'Simone',
  );
  assert.equal(sellerHandle({ sellerName: 'redshakkio@gmail.com' }), '');
  assert.equal(
    sellerHandle({ sellerName: 'redshakkio@gmail.com', sellerUsername: 'redshakkio' }),
    'redshakkio',
  );
});
