'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cardmarketPathKey,
  candidateUrls,
  lookupCardmarketProduct,
  setMarketplaceQueryForTest,
} = require('./_cardmarket_reverse');

test('cardmarketPathKey canonicalizes a full Cardmarket Singles URL', () => {
  const url = 'https://www.cardmarket.com/en/Pokemon/Products/Singles/30th-Celebration/Scizor-ex-30CUF-108';
  assert.equal(
    cardmarketPathKey(url),
    '/Pokemon/Products/Singles/30th-Celebration/Scizor-ex-30CUF-108',
  );
});

test('cardmarketPathKey strips a non-en locale and query string', () => {
  const url = 'https://www.cardmarket.com/it/Pokemon/Products/Singles/30th-Celebration/Scizor-ex-30CUF-108?language=5';
  assert.equal(
    cardmarketPathKey(url),
    '/Pokemon/Products/Singles/30th-Celebration/Scizor-ex-30CUF-108',
  );
});

test('cardmarketPathKey drops a hash', () => {
  const url = 'https://www.cardmarket.com/en/Pokemon/Products/Singles/30th-Celebration/Scizor-ex-30CUF-108#top';
  assert.equal(
    cardmarketPathKey(url),
    '/Pokemon/Products/Singles/30th-Celebration/Scizor-ex-30CUF-108',
  );
});

test('cardmarketPathKey accepts a host without www', () => {
  const url = 'https://cardmarket.com/en/Pokemon/Products/Singles/30th-Celebration/Scizor-ex-30CUF-108';
  assert.equal(
    cardmarketPathKey(url),
    '/Pokemon/Products/Singles/30th-Celebration/Scizor-ex-30CUF-108',
  );
});

test('cardmarketPathKey rejects a search page', () => {
  const url = 'https://www.cardmarket.com/en/Pokemon/Products/Search?search=Scizor';
  assert.equal(cardmarketPathKey(url), '');
});

test('cardmarketPathKey keeps a Magic Singles URL', () => {
  const url = 'https://www.cardmarket.com/en/Magic/Products/Singles/The-Lord-of-the-Rings-Tales-of-Middle-earth-Extras/Shelob-Child-of-Ungoliant-V1';
  assert.equal(
    cardmarketPathKey(url),
    '/Magic/Products/Singles/The-Lord-of-the-Rings-Tales-of-Middle-earth-Extras/Shelob-Child-of-Ungoliant-V1',
  );
});

test('candidateUrls lists the five stored-URL forms with en first', () => {
  const key = '/Pokemon/Products/Singles/30th-Celebration/Scizor-ex-30CUF-108';
  assert.deepEqual(candidateUrls(key), [
    'https://www.cardmarket.com/en/Pokemon/Products/Singles/30th-Celebration/Scizor-ex-30CUF-108',
    'https://www.cardmarket.com/it/Pokemon/Products/Singles/30th-Celebration/Scizor-ex-30CUF-108',
    'https://www.cardmarket.com/de/Pokemon/Products/Singles/30th-Celebration/Scizor-ex-30CUF-108',
    'https://www.cardmarket.com/fr/Pokemon/Products/Singles/30th-Celebration/Scizor-ex-30CUF-108',
    'https://www.cardmarket.com/es/Pokemon/Products/Singles/30th-Celebration/Scizor-ex-30CUF-108',
  ]);
});

test('lookupCardmarketProduct maps a verified row to publicId = 2 x blueprintId', async () => {
  let captured;
  const fakeQuery = async (sql, values) => {
    captured = { sql, values };
    return {
      rows: [{
        blueprint_id: '108',
        card_name: 'Scizor ex',
        expansion_name: '30th Celebration',
        collector_number: '108/107',
        source: 'verified_link',
        confidence: 'verified',
      }],
    };
  };
  setMarketplaceQueryForTest(fakeQuery);
  try {
    const url = 'https://www.cardmarket.com/en/Pokemon/Products/Singles/30th-Celebration/Scizor-ex-30CUF-108';
    const match = await lookupCardmarketProduct(url);
    assert.equal(match.blueprintId, '108');
    assert.equal(match.publicId, '216');
    assert.equal(match.cardName, 'Scizor ex');
    assert.equal(match.expansionName, '30th Celebration');
    assert.equal(match.collectorNumber, '108/107');
    assert.equal(match.source, 'verified_link');
    assert.equal(match.confidence, 'verified');
    assert.ok(captured.sql.includes('marketplace_cm_verified_links'));
    assert.ok(captured.sql.includes('marketplace_cm_product_parsing'));
    assert.deepEqual(
      captured.values[0],
      candidateUrls('/Pokemon/Products/Singles/30th-Celebration/Scizor-ex-30CUF-108'),
    );
  } finally {
    setMarketplaceQueryForTest(null);
  }
});

test('lookupCardmarketProduct returns null when no rows match', async () => {
  setMarketplaceQueryForTest(async () => ({ rows: [] }));
  try {
    const url = 'https://www.cardmarket.com/en/Pokemon/Products/Singles/30th-Celebration/Scizor-ex-30CUF-108';
    assert.equal(await lookupCardmarketProduct(url), null);
  } finally {
    setMarketplaceQueryForTest(null);
  }
});
