import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conditionShort,
  conditionTone,
  isReserveSeller,
  listingExtraTags,
  listingLanguageFlag,
  publicListingSellerName,
  publicShopSellerLabel,
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

test('shop-cond pills use CardTrader solids plus red PO', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
  assert.match(css, /\.shop-cond\.is-nm \{[^}]*background:\s*#6f8f3a/);
  assert.match(css, /\.shop-cond\.is-sp \{[^}]*background:\s*#9bb84a/);
  assert.match(css, /\.shop-cond\.is-mp \{[^}]*background:\s*#d4a017/);
  assert.match(css, /\.shop-cond\.is-pl \{[^}]*background:\s*#c45a22/);
  assert.match(css, /\.shop-cond\.is-poor \{[^}]*background:\s*#d32f2f/);
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
  assert.equal(sellerCountryFlag('IT').short, 'IT');
  assert.equal(sellerCountryFlag('IT').emoji, '🇮🇹');
  assert.equal(sellerCountryFlag('HU').short, 'HU');
  assert.equal(sellerCountryFlag('HU').emoji, '🇭🇺');
  assert.equal(sellerCountryFlag('EU'), null);
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

test('shop chip prefers handle over displayName/email', () => {
  assert.equal(
    publicShopSellerLabel({
      sellerName: 'Simone Di Blasi',
      sellerDisplayName: 'Simone Di Blasi',
      sellerUsername: 'redshakkio',
    }),
    'redshakkio',
  );
  assert.equal(
    publicShopSellerLabel({
      sellerName: 'redshakkio@gmail.com',
      sellerUsername: 'redshakkio',
    }),
    'redshakkio',
  );
  assert.equal(
    publicShopSellerLabel({ sellerReputationLabel: 'pknreserve', sellerName: 'pknreserve' }),
    'pknreserve',
  );
});
