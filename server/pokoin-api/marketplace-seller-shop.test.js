'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cleanLimit,
  cleanOffset,
  cleanUsername,
  conditionSql,
  sortSql,
  publicPhotoUrl,
  shopSellerFromProfile,
  listingRow,
  sellerCardIdsForGame,
  withGameContext,
} = require('./marketplace-seller-shop.js')._test;

test('cleanLimit caps at 100 for shop pages', () => {
  assert.equal(cleanLimit('100'), 100);
  assert.equal(cleanLimit('999'), 100);
  assert.equal(cleanLimit(''), 100);
  assert.equal(cleanLimit('0'), 1);
});

test('cleanOffset floors negatives', () => {
  assert.equal(cleanOffset('-3'), 0);
  assert.equal(cleanOffset('200'), 200);
});

test('cleanUsername rejects junk', () => {
  assert.equal(cleanUsername('redshakkio'), 'redshakkio');
  assert.equal(cleanUsername('...'), '');
});

test('conditionSql maps CT codes', () => {
  assert.deepEqual(conditionSql('NM').codes, ['NM', 'M']);
  assert.deepEqual(conditionSql('SP').codes, ['SP', 'LP']);
  assert.deepEqual(conditionSql('LP').codes, ['SP', 'LP']);
  assert.deepEqual(conditionSql('MP').codes, ['MP']);
  assert.deepEqual(conditionSql('PL').codes, ['PL', 'HP']);
  assert.deepEqual(conditionSql('HP').codes, ['PL', 'HP']);
  assert.deepEqual(conditionSql('Poor').codes, ['PO', 'POOR', 'D', 'DMG']);
  assert.equal(conditionSql(''), null);
});

test('truthyFlag and raritySql build shop filters', () => {
  const { truthyFlag, raritySql } = require('./marketplace-seller-shop.js')._test;
  assert.equal(truthyFlag('1'), true);
  assert.equal(truthyFlag('true'), true);
  assert.equal(truthyFlag(''), false);
  assert.equal(raritySql(''), null);
  const holo = raritySql('holo');
  const where = [];
  const values = [];
  holo.apply(where, values);
  assert.match(where[0], /foil_state/);
  assert.match(where[0], /marketplace_search_candidates/);
  assert.deepEqual(values, ['%holo%', '%holofoil%']);
  const common = raritySql('common');
  const where2 = [];
  const values2 = [];
  common.apply(where2, values2);
  assert.match(where2[0], /not like/);
  assert.ok(values2.includes('%common%'));
  assert.ok(values2.includes('%uncommon%'));
});

test('public shop photo is an https URL only', () => {
  const photo = 'https://pub-example.r2.dev/profile-pictures/u1/a.jpg';
  assert.equal(publicPhotoUrl(photo), photo);
  assert.equal(publicPhotoUrl('http://pub-example.r2.dev/a.jpg'), '');
  assert.equal(publicPhotoUrl('profile-pictures/u1/a.jpg'), '');
  const seller = shopSellerFromProfile({
    uid: 'u1',
    queried: 'redshakkio',
    via: 'firebase',
    profile: { username: 'redshakkio', displayName: 'Red', photoUrl: photo },
  });
  assert.equal(seller.photoUrl, photo);
});

test('a nickname or email change keeps the listing on the Firebase user', () => {
  const current = shopSellerFromProfile({
    uid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2',
    queried: 'redshakkio',
    via: 'firebase',
    profile: { username: 'redshakkio', displayName: 'Red' },
  });
  assert.equal(current.uid, 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2');
  assert.equal(current.username, 'redshakkio');

  const staleEmail = shopSellerFromProfile({
    uid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2',
    queried: 'redshakkio@gmail.com',
    via: 'listing-name',
    profile: { username: 'redshakkio', displayName: 'Red' },
  });
  assert.equal(staleEmail, null);

  const row = listingRow({
    id: '1',
    card_id: '9',
    seller_uid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2',
    seller_name: 'oldname@gmail.com',
    price_pkn: 18,
    card_name: 'Drifloon',
  }, current);
  assert.equal(row.sellerUid, 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2');
  assert.equal(row.sellerUsername, 'redshakkio');
  assert.equal(row.sellerName, 'Red');
  assert.equal(row.sellerName.includes('@'), false);
});

test('sortSql defaults to price asc', () => {
  assert.match(sortSql(''), /price_pkn asc/);
  assert.match(sortSql('price-desc'), /price_pkn desc/);
});

test('seller queries run inside the selected TCG database context', async () => {
  const calls = [];
  const result = await withGameContext('sorcery', async () => 'shop', async (game, fn) => {
    calls.push(game);
    return fn();
  });
  assert.equal(result, 'shop');
  assert.deepEqual(calls, ['sorcery']);
});

test('seller game filter intersects shared listings with the selected catalog', async () => {
  let currentGame = '';
  const calls = [];
  const ids = await sellerCardIdsForGame('u1', 'sorcery', {
    run: async (game, fn) => {
      currentGame = game;
      calls.push(game);
      return fn();
    },
    query: async () => currentGame === 'pokemon'
      ? { rows: [{ card_id: '10' }, { card_id: '20' }] }
      : { rows: [{ card_id: '20' }] },
  });
  assert.deepEqual(calls, ['pokemon', 'sorcery']);
  assert.deepEqual(ids, ['20']);

  const pokemonCalls = [];
  let pokemonGame = '';
  const pokemonIds = await sellerCardIdsForGame('u1', 'pokemon', {
    run: async (game, fn) => {
      pokemonGame = game;
      pokemonCalls.push(game);
      return fn();
    },
    query: async () => pokemonGame === 'pokemon'
      ? (
        pokemonCalls.length === 1
          ? { rows: [{ card_id: '10' }, { card_id: '99' }] }
          : { rows: [{ card_id: '10' }] }
      )
      : { rows: [] },
  });
  assert.deepEqual(pokemonCalls, ['pokemon', 'pokemon']);
  assert.deepEqual(pokemonIds, ['10']);
});

test('shop listings carry the seller PKN payment choice', () => {
  const base = { id: '1', card_id: '9', seller_uid: 'u1', price_pkn: 2642 };
  assert.equal(listingRow(base, { uid: 'u1', username: 'marco' }).sellerAcceptsPkn, true);
  assert.equal(listingRow(base, { uid: 'u1', username: 'marco', acceptsPkn: false }).sellerAcceptsPkn, false);
});

test('pokemon shop filter stays in SQL instead of materializing every card id', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'marketplace-seller-shop.js'), 'utf8');
  assert.match(src, /catalogGame === 'pokemon'/);
  assert.match(src, /exists \(/);
  assert.match(src, /marketplace_search_candidates c/);
  // Satellite TCGs still go through sellerCardIdsForGame + any().
  assert.match(src, /sellerCardIdsForGame\(seller\.uid, catalogGame\)/);
  assert.match(src, /card_id = any\(/);
});
