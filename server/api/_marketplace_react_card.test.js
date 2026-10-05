'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { foreignImagePrefix, toReactCard } = require('./_marketplace_react_card');

const CDN = 'https://cdn.pokoin.com/';

test('a halved ct_id key falls back to the per-id preview and homepage', () => {
  const card = toReactCard({
    card_id: 439492,
    ct_id: 219746,
    name: 'Hisuian Zoroark VSTAR',
    set_name: 'Lost Origin',
    card_number: 'Ultra Rare | 147/196',
    cdn_image_url: `${CDN}109873_hisuian-zoroark-vstar.jpg`,
    image_url: `${CDN}109873_hisuian-zoroark-vstar.jpg`,
    preview_image_url: `${CDN}previews/219746_hisuian-zoroark-vstar.jpg`,
    homepage_image_url: `${CDN}219746_hisuian-zoroark-vstar-ultra-rare-147-196-lost-origin_homepage.webp`,
  });
  const preview = '/card-images/previews/439492_hisuian-zoroark-vstar.jpg';
  const homepage = '/card-images/439492_hisuian-zoroark-vstar-ultra-rare-147-196-lost-origin_homepage.webp';
  assert.equal(card.imageUrl, preview);
  assert.equal(card.gridImageUrl, preview);
  assert.equal(card.heroImageUrl, preview);
  assert.equal(card.previewImageUrl, preview);
  assert.equal(card.homepageImageUrl, homepage);
  assert.equal(card.tileImageUrl, homepage);
  assert.ok(!JSON.stringify(card).includes('109873'));
  assert.ok(!('_foreignFullImage' in card));
});

test('valid ct_id keys are unchanged', () => {
  const card = toReactCard({
    card_id: 469036,
    ct_id: 234518,
    name: 'Hisuian Zoroark VSTAR',
    cdn_image_url: `${CDN}234518_hisuian-zoroark-vstar-062-071-dark-phantasma.jpg`,
    image_url: `${CDN}234518_hisuian-zoroark-vstar-062-071-dark-phantasma.jpg`,
    preview_image_url: `${CDN}previews/234518_hisuian-zoroark-vstar-062-071-dark-phantasma.webp`,
    homepage_image_url: `${CDN}234518_hisuian-zoroark-vstar-062-071-dark-phantasma_homepage.webp`,
  });
  assert.equal(card.imageUrl, '/card-images/469036_hisuian-zoroark-vstar-062-071-dark-phantasma.jpg');
  assert.equal(card.tileImageUrl, '/card-images/469036_hisuian-zoroark-vstar-062-071-dark-phantasma_homepage.webp');
});

test('a ct_id/4 key falls back too, keeping a cache-bust query on valid urls', () => {
  const card = toReactCard({
    card_id: 685672,
    ct_id: 342836,
    name: 'Zorua',
    image_url: `${CDN}85709_zorua.jpg?v=bsu2`,
    preview_image_url: `${CDN}previews/342836_zorua.jpg`,
  });
  assert.equal(card.imageUrl, '/card-images/previews/685672_zorua.jpg');
  assert.equal(card.tileImageUrl, '/card-images/previews/685672_zorua.jpg');
});

test('multi-game keys keep their raw CardTrader id', () => {
  const card = toReactCard({
    card_id: 1001,
    ct_id: 5,
    name: 'Black Lotus',
    image_url: `${CDN}magic/777_black-lotus.jpg`,
  });
  assert.equal(card.imageUrl, '/card-images/magic/777_black-lotus.jpg');
});

test('foreignImagePrefix accepts only the card_id or ct_id prefix', () => {
  const row = { card_id: 439492, ct_id: 219746 };
  assert.equal(foreignImagePrefix(`${CDN}109873_x.jpg`, row), true);
  assert.equal(foreignImagePrefix(`${CDN}109873_x.jpg?v=2`, row), true);
  assert.equal(foreignImagePrefix(`${CDN}219746_x.jpg`, row), false);
  assert.equal(foreignImagePrefix(`${CDN}previews/439492_x.jpg`, row), false);
  assert.equal(foreignImagePrefix('/card-images/439492_x_homepage.webp', row), false);
  assert.equal(foreignImagePrefix('', row), false);
  assert.equal(foreignImagePrefix(`${CDN}magic/1_x.jpg`, row), false);
  assert.equal(foreignImagePrefix(`${CDN}109873_x.jpg`, {}), false);
  // ct_id unknown: an even card_id implies leftover card_id / 2.
  assert.equal(foreignImagePrefix(`${CDN}219746_x.jpg`, { card_id: 439492 }), false);
});
