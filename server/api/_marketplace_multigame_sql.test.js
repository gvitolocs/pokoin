'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadHelpers() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokoin-multigame-'));
  const stubs = {
    '_marketplace_db.js': `module.exports = { marketplaceQuery: async () => ({ rows: [] }) };`,
    '_marketplace_react_sql.js': `module.exports = {
      readCandidateByCardId: async () => null,
      readSetSiblings: async () => [],
      readCanonicalPaths: async () => new Map(),
      readSetNeighbors: async () => [],
      applyCanonicalAndCheapest: (rows) => rows,
    };`,
  };
  for (const [name, body] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  fs.copyFileSync(
    path.join(__dirname, '_marketplace_react_card.js'),
    path.join(dir, '_marketplace_react_card.js'),
  );
  fs.copyFileSync(
    path.join(__dirname, '_marketplace_multigame_sql.js'),
    path.join(dir, '_marketplace_multigame_sql.js'),
  );
  // react_card pulls a few more siblings — stub the ones tests do not exercise.
  for (const name of [
    '_marketplace_row.js',
    '_marketplace_card_emoji.js',
    '_marketplace_canonical_path.js',
    '_marketplace_image_log.js',
  ]) {
    const src = path.join(__dirname, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dir, name));
    } else {
      fs.writeFileSync(path.join(dir, name), 'module.exports = {};');
    }
  }
  // Minimal stubs react_card may require
  fs.writeFileSync(
    path.join(dir, '_marketplace_row.js'),
    `module.exports = {
      normalizeMarketplaceRow: (row) => ({ ...row }),
      rewriteCdnPokoinPrefix: (url) => String(url || ''),
      isMarketAvailable: () => false,
    };`,
  );
  fs.writeFileSync(
    path.join(dir, '_marketplace_card_emoji.js'),
    `module.exports = {
      withCardEmojiFields: (row) => ({ ...row }),
      cardEmojiFields: () => ({}),
    };`,
  );
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(path.join(dir, '_marketplace_multigame_sql.js'));
}

const {
  appendProductUniverse,
  appendSearchMatch,
} = loadHelpers();

test('productType=card filters product_type only — never forces item_kind product', () => {
  const clauses = [];
  const values = [];
  appendProductUniverse(clauses, values, { productType: 'card', term: 'reality fracture' });
  assert.deepEqual(clauses, ['c.product_type = $1']);
  assert.deepEqual(values, ['card']);
  assert.equal(clauses.join(' ').includes("item_kind = 'product'"), false);
});

test('productSearchOnly is sealed products plus jumbo', () => {
  const clauses = [];
  const values = [];
  appendProductUniverse(clauses, values, { productSearchOnly: true, term: 'reality fracture' });
  assert.equal(clauses.length, 1);
  assert.match(clauses[0], /item_kind = 'product'/);
  assert.match(clauses[0], /product_type = 'jumbo'/);
  assert.deepEqual(values, []);
});

test('empty browse without a term defaults to singles', () => {
  const clauses = [];
  const values = [];
  appendProductUniverse(clauses, values, { term: '' });
  assert.deepEqual(clauses, [
    "c.item_kind = 'single'",
    "c.product_type = 'card'",
  ]);
});

test('search match uses LIKE plus word_similarity placeholders', () => {
  const clauses = [];
  const values = [];
  const { likeIdx, termIdx } = appendSearchMatch(clauses, values, 'relity fracture');
  assert.equal(likeIdx, 1);
  assert.equal(termIdx, 2);
  assert.equal(values[0], '%relity fracture%');
  assert.equal(values[1], 'relity fracture');
  assert.match(clauses[0], /word_similarity/);
  assert.match(clauses[0], /search_text like/);
});
