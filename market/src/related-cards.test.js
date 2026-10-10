import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RELATED_LIMIT,
  preloadRelatedThumbs,
  relatedFromPage,
  relatedThumbUrl,
  resetRelatedThumbsForTests,
} from './related-cards.js';

const row = (id, extra = {}) => ({
  id: String(id),
  card_id: String(id),
  name: `Card ${id}`,
  set_name: 'Base Set',
  cdn_image_url: `https://cdn.pokoin.com/${id}_card.jpg`,
  ...extra,
});

test('relatedFromPage maps the server list in order, without the desk card or repeats', () => {
  const page = { card: { id: '5' }, related: [row(7), row(5), row(9), row(7)] };
  assert.deepEqual(relatedFromPage(page).map((card) => card.id), ['7', '9']);
  assert.equal(relatedFromPage(page)[0].name, 'Card 7');
});

test('relatedFromPage keeps at most 12 tiles', () => {
  const page = { card: { id: '1' }, related: Array.from({ length: 30 }, (_, i) => row(100 + i)) };
  assert.equal(RELATED_LIMIT, 12);
  assert.equal(relatedFromPage(page).length, 12);
  assert.equal(relatedFromPage(page)[11].id, '111');
});

test('relatedFromPage is empty when the API sent no list, so the desk falls back', () => {
  assert.deepEqual(relatedFromPage({ card: { id: '1' } }), []);
  assert.deepEqual(relatedFromPage({ card: { id: '1' }, related: [] }), []);
  assert.deepEqual(relatedFromPage({ card: { id: '1' }, related: 'nope' }), []);
  assert.deepEqual(relatedFromPage(null), []);
});

test('preloadRelatedThumbs starts each tile thumbnail once, at low priority', () => {
  resetRelatedThumbsForTests();
  const made = [];
  const createImage = () => {
    const img = {};
    made.push(img);
    return img;
  };
  const cards = relatedFromPage({ card: { id: '1' }, related: [row(7), row(9)] });
  const started = preloadRelatedThumbs(cards, { createImage });
  assert.deepEqual(started, cards.map(relatedThumbUrl));
  assert.ok(started.every((url) => url.startsWith('https://cdn.pokoin.com/')));
  assert.ok(made.every((img) => img.fetchPriority === 'low' && img.decoding === 'async'));
  assert.deepEqual(made.map((img) => img.src), started);
  // The same list again (cached page, then the fresh page) downloads nothing more.
  assert.deepEqual(preloadRelatedThumbs(cards, { createImage }), []);
  assert.equal(made.length, 2);
});
