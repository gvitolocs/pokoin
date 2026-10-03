'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  affinityScore,
  boughtCardIds,
  buildAffinity,
  parseIds,
  pickOffer,
  rankByAffinity,
  rankCoCarted,
  rankSellerShelf,
  rankTrending,
} = require('./_recommend');

const card = (id, over = {}) => ({
  card_id: String(id),
  name: 'Pikachu',
  set_name: 'Base Set',
  artist: 'Mitsuhiro Arita',
  pokedex_num: 25,
  version: `v${id}`,
  min_price: 100,
  hot_7d: 0,
  hot_24h: 0,
  ...over,
});

test('ids parse once each, numeric only, capped', () => {
  assert.deepEqual(parseIds('3,1,x,3,,2', 2), ['3', '1']);
  assert.deepEqual(parseIds(['7', 7, '07a']), ['7']);
});

test('affinity prefers same artwork, then species, name, artist, set', () => {
  const affinity = buildAffinity([{ card: card(1, { name: 'Medicham ex', pokedex_num: 308, artist: 'PLANETA', version: 'v9' }), source: 'cart' }]);
  const sameArt = affinityScore(card(2, { name: 'Medicham ex', pokedex_num: 308, version: 'v9' }), affinity);
  const sameSpecies = affinityScore(card(3, { name: 'Medicham', pokedex_num: 308, artist: 'x' }), affinity);
  const sameArtist = affinityScore(card(4, { name: 'Ralts', pokedex_num: 280, artist: 'PLANETA' }), affinity);
  const nothing = affinityScore(card(5, { name: 'Ralts', pokedex_num: 280, artist: 'x', set_name: 'Other' }), affinity);
  assert.ok(sameArt.score > sameSpecies.score);
  assert.ok(sameSpecies.score > sameArtist.score);
  assert.equal(nothing.score, 0);
  assert.match(sameSpecies.reason, /More Medicham/);
  assert.equal(sameArtist.reason, 'Art by PLANETA');
});

test('cart signals outweigh recently viewed ones', () => {
  const affinity = buildAffinity([
    { card: card(1, { name: 'Eevee', pokedex_num: 133 }), source: 'recent' },
    { card: card(2, { name: 'Umbreon', pokedex_num: 197 }), source: 'cart' },
  ]);
  const umbreon = affinityScore(card(3, { name: 'Umbreon', pokedex_num: 197 }), affinity);
  const eevee = affinityScore(card(4, { name: 'Eevee', pokedex_num: 133 }), affinity);
  assert.ok(umbreon.score > eevee.score);
});

test('affinity rails skip what the buyer already saw and rank by match', () => {
  const pool = [card(10, { name: 'Pikachu', hot_7d: 5 }), card(11, { name: 'Raichu', pokedex_num: 26 }), card(12)];
  const affinity = buildAffinity([{ card: card(1), source: 'recent' }]);
  const ranked = rankByAffinity(pool, affinity, {
    want: (matches) => matches.includes('species'),
    exclude: new Set(['12']),
  });
  assert.deepEqual(ranked.map((row) => row.card.card_id), ['10']);
});

test('trending works with no signals at all', () => {
  const pool = [card(1, { hot_24h: 1, hot_7d: 1 }), card(2, { hot_24h: 50, hot_7d: 10 }), card(3)];
  const ranked = rankTrending(pool, buildAffinity([]), { exclude: new Set() });
  assert.deepEqual(ranked.map((row) => row.card.card_id), ['2', '1']);
  assert.equal(ranked[0].reason, '');
});

test('co-carted cards rank by how many carts share them', () => {
  const byId = new Map([['5', card(5)], ['6', card(6)], ['7', card(7)]]);
  const ranked = rankCoCarted(byId, new Map([['5', 1], ['6', 4], ['8', 9], ['7', 2]]), { exclude: new Set(['7']) });
  assert.deepEqual(ranked.map((row) => row.card.card_id), ['6', '5']);
  assert.equal(ranked[0].reason, 'In 4 other carts with yours');
});

test('a seller shelf leaves out cart lines and repeats, best match first', () => {
  const byId = new Map([['20', card(20, { name: 'Pikachu' })], ['21', card(21, { name: 'Onix', pokedex_num: 95, artist: 'x', set_name: 'y' })]]);
  const affinity = buildAffinity([{ card: card(1), source: 'cart' }]);
  const ranked = rankSellerShelf([
    { id: 'a', card_id: '21', price_pkn: 10 },
    { id: 'b', card_id: '20', price_pkn: 90 },
    { id: 'c', card_id: '20', price_pkn: 95 },
    { id: 'd', card_id: '1', price_pkn: 5 },
    { id: 'e', card_id: '99', price_pkn: 5 },
  ], byId, affinity, { excludeListings: new Set(['x']), excludeCards: new Set(['1']) });
  assert.deepEqual(ranked.map((row) => row.offer.id), ['b', 'a']);
});

test('offer choice: English NM, then English best condition, then NM elsewhere; never graded', () => {
  const offers = [
    { id: 'jp-nm', language: 'jp', condition: 'NM', price_pkn: 50, quantity_available: 1 },
    { id: 'en-pl', language: 'EN', condition: 'Played', price_pkn: 60, quantity_available: 1 },
    { id: 'en-sp', language: 'en', condition: 'SP', price_pkn: 90, quantity_available: 1 },
    { id: 'en-graded', language: 'en', condition: 'NM', price_pkn: 10, quantity_available: 1, graded: true },
  ];
  assert.equal(pickOffer(offers).id, 'en-sp');
  assert.equal(pickOffer([...offers, { id: 'en-nm', language: 'en', condition: 'Near Mint', price_pkn: 200, quantity_available: 1 }]).id, 'en-nm');
  assert.equal(pickOffer(offers.filter((row) => row.language === 'jp')).id, 'jp-nm');
  assert.equal(pickOffer([]), null);
});

test('bought ids come from paid orders, newest first, once each', () => {
  const bought = boughtCardIds([
    { paymentStatus: 'paid', createdAt: '2026-08-01T00:00:00Z', items: [{ card: { id: '1' } }, { card: { id: '2' } }] },
    { paymentStatus: 'cancelled', createdAt: '2026-09-30T00:00:00Z', items: [{ card: { id: '3' } }] },
    { paymentStatus: 'released', createdAt: { _seconds: Date.parse('2026-09-01T00:00:00Z') / 1000 }, items: [{ cardId: '2' }] },
  ]);
  assert.deepEqual(bought.map((row) => row.cardId), ['2', '1']);
});
