import assert from 'node:assert/strict';
import test from 'node:test';
import { GAMES } from './game.js';
import {
  promoLogoIsName,
  promoLogoSrc,
  readStoredPromoBanners,
  rememberPromoBanners,
  samePromoBanners,
  satellitePromoBanners,
} from './promo-banners.js';

function memoryStore() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

test('a reload paints the satellite slides it showed last, per game', () => {
  const store = memoryStore();
  const slides = satellitePromoBanners([
    { slug: 'strangers-in-the-sky', name: 'Strangers in the Sky', cardCount: 150, logoImageUrl: 'https://cdn.pokoin.com/x.png' },
    { slug: 'savior-of-chaos', name: 'Savior of Chaos', cardCount: 140 },
  ], 'Battle Spirits Saga');
  assert.deepEqual(readStoredPromoBanners('battle_spirits_saga', store), []);
  rememberPromoBanners('battle_spirits_saga', slides, store);
  const stored = readStoredPromoBanners('battle_spirits_saga', store);
  assert.deepEqual(stored, slides);
  // The fresh read of the same expansions is the same list: the mounted slide stays.
  assert.equal(samePromoBanners(stored, satellitePromoBanners([
    { slug: 'strangers-in-the-sky', name: 'Strangers in the Sky', cardCount: 150, logoImageUrl: 'https://cdn.pokoin.com/x.png' },
    { slug: 'savior-of-chaos', name: 'Savior of Chaos', cardCount: 140 },
  ], 'Battle Spirits Saga')), true);
  assert.equal(samePromoBanners(stored, slides.slice(1)), false);
  // Another game never paints these slides.
  assert.deepEqual(readStoredPromoBanners('one_piece', store), []);
});

test('stored slides that are not slides are ignored', () => {
  const store = memoryStore();
  store.setItem('pokoin.promoBanners.magic', '{"slug":"x"}');
  assert.deepEqual(readStoredPromoBanners('magic', store), []);
  store.setItem('pokoin.promoBanners.magic', 'not json');
  assert.deepEqual(readStoredPromoBanners('magic', store), []);
  store.setItem('pokoin.promoBanners.magic', JSON.stringify([{ slug: 'ok', title: 'Ok' }, { slug: '', title: 'No' }, null]));
  assert.deepEqual(readStoredPromoBanners('magic', store), [{ slug: 'ok', title: 'Ok' }]);
  assert.deepEqual(readStoredPromoBanners('magic', null), []);
});

test('every TCG homepage uses the promo super tile', () => {
  for (const item of Object.values(GAMES)) {
    assert.equal(item.features.promoCarousel, true, item.id);
  }
});

test('satellite slides keep the official logo and skip empty rows', () => {
  const slides = satellitePromoBanners([
    {
      slug: 'dawn-of-history',
      name: 'Dawn Of History',
      cardCount: 140,
      logoImageUrl: 'https://cdn.pokoin.com/battle-spirits-saga/expansions/logos/dawn-of-history.png',
    },
    { slug: '', name: 'Nope', cardCount: 1 },
    { slug: 'dawn-of-history', name: 'Dawn Of History', cardCount: 140 },
    { slug: 'aegis-of-the-machine', name: 'Aegis Of The Machine', cardCount: 80, logoImageUrl: '' },
  ], 'Battle Spirits Saga', 5);
  assert.equal(slides.length, 2);
  assert.equal(slides[0].series, 'Battle Spirits Saga');
  assert.equal(slides[0].title, 'Dawn Of History');
  assert.match(slides[0].logoImageUrl, /dawn-of-history/);
  assert.match(slides[0].lede, /140 cards/);
  assert.equal(slides[1].logoImageUrl, '');
  assert.equal(slides[1].cta, 'Explore cards from this expansion');
});

test('western wordmarks replace the text expansion name', () => {
  assert.equal(promoLogoIsName({ western: true, title: 'Black Bolt' }), true);
  assert.equal(promoLogoIsName({ nationality: 'western' }), true);
  assert.equal(promoLogoIsName({ title: 'Storm Emeralda' }), false);
  assert.equal(promoLogoIsName({ nationality: 'japanese' }), false);
});

test('pokemon promo logos use the set wordmark path', () => {
  assert.equal(
    promoLogoSrc({ slug: 'storm-emeralda' }, { pokemon: true }),
    '/card-images/expansions/logos/storm-emeralda.png',
  );
  assert.equal(promoLogoSrc({ slug: 'dawn-of-history' }, { pokemon: false }), '');
  assert.equal(
    promoLogoSrc({ slug: 'dawn-of-history', logoImageUrl: 'https://cdn.example/logo.png' }, { pokemon: false }),
    'https://cdn.example/logo.png',
  );
});
