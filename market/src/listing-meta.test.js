import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conditionChipSrc,
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

test('each condition grade has its own SVG chip', async () => {
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../public/conditions');
  for (const code of ['nm', 'sp', 'mp', 'pl', 'po']) {
    assert.equal(existsSync(join(dir, `${code}.svg`)), true, `${code}.svg`);
  }
  assert.match(conditionChipSrc('NM'), /conditions\/nm\.svg$/);
  assert.match(conditionChipSrc('SP'), /conditions\/sp\.svg$/);
  assert.match(conditionChipSrc('MP'), /conditions\/mp\.svg$/);
  assert.match(conditionChipSrc('PL'), /conditions\/pl\.svg$/);
  assert.match(conditionChipSrc('HP'), /conditions\/pl\.svg$/);
  assert.match(conditionChipSrc('Poor'), /conditions\/po\.svg$/);
  assert.match(conditionChipSrc('PO'), /conditions\/po\.svg$/);
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
  assert.equal(sellerCountryFlag('DK').code, 'dk');
  assert.equal(sellerCountryFlag('DK').emoji, '🇩🇰');
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
  assert.equal(
    sellerHref({
      sellerName: 'Simone Di Blasi',
      sellerUsername: '',
      sellerUid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2',
    }, 'en'),
    '/marketplace/en/users/Simone%20Di%20Blasi?sellerUid=PUH1ygG9mOOyQRPXaY5Fa1W6DKd2',
  );
  assert.match(
    sellerHref({ sellerUid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2' }, 'en'),
    /^\/marketplace\/en\/users\/seller-PUH1ygG9mOOy\?sellerUid=PUH1ygG9mOOyQRPXaY5Fa1W6DKd2$/,
  );
  assert.deepEqual(listingExtraTags({ reverse: true, language: 'EN' }), ['Reverse']);
  assert.deepEqual(listingExtraTags({ foilState: 'foil' }), ['Foil']);
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
