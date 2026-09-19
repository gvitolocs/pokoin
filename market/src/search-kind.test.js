import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SEARCH_TABS,
  isSearchSingle,
  normalizeSearchTab,
  printingMatchesSearchTab,
  searchFetchOptions,
  searchHref,
  uniqueSellers,
} from './search-kind.js';

test('search tabs default to singles; legacy jumbo normalizes to product', () => {
  assert.equal(normalizeSearchTab(''), 'singles');
  assert.equal(normalizeSearchTab('product'), 'product');
  assert.equal(normalizeSearchTab('users'), 'users');
  assert.equal(normalizeSearchTab('jumbo'), 'product');
  assert.equal(normalizeSearchTab('sealed'), 'singles');
});

test('search href keeps singles as the default tab', () => {
  assert.equal(searchHref('mimikyu'), '/marketplace/search?q=mimikyu');
  assert.equal(searchHref('mimikyu', 'product'), '/marketplace/search?q=mimikyu&tab=product');
  assert.equal(searchHref('', 'users'), '/marketplace/search?tab=users');
});

test('singles vs product follows catalog kind', () => {
  const card = { name: 'Mimikyu', productType: 'card', itemKind: 'single' };
  const box = { name: 'Mimikyu ex Box', productType: 'product', itemKind: 'product' };
  assert.equal(isSearchSingle(card), true);
  assert.equal(isSearchSingle(box), false);
  assert.equal(printingMatchesSearchTab(card, 'singles'), true);
  assert.equal(printingMatchesSearchTab(box, 'singles'), false);
  assert.equal(printingMatchesSearchTab(box, 'product'), true);
  assert.equal(printingMatchesSearchTab(card, 'product'), false);
  assert.equal(printingMatchesSearchTab({ name: 'Mimikyu Pin Collection' }, 'singles'), false);
  assert.equal(printingMatchesSearchTab({ name: 'Mimikyu Pin Collection' }, 'product'), true);
  // Jumbo rows are Product results — no separate jumbo universe.
  assert.equal(printingMatchesSearchTab({
    name: 'Palkia & Dialga LEGEND',
    number: 'Jumbo Oversized',
  }, 'singles'), false);
  assert.equal(printingMatchesSearchTab({
    name: 'Palkia & Dialga LEGEND',
    number: 'Jumbo Oversized',
  }, 'jumbo'), true);
  assert.equal(printingMatchesSearchTab({
    name: 'Palkia & Dialga LEGEND',
    number: 'Jumbo Oversized',
  }, 'product'), true);
  assert.equal(printingMatchesSearchTab({
    name: 'Charizard',
    number: '017',
    rarity: 'Jumbo Oversized',
  }, 'singles'), false);
  assert.equal(printingMatchesSearchTab({
    name: 'Charizard',
    number: '017',
    rarity: 'Jumbo Oversized',
  }, 'jumbo'), true);
  assert.equal(printingMatchesSearchTab({
    name: 'Charizard',
    number: '017',
    rarity: 'Jumbo Oversized',
  }, 'product'), true);
  assert.equal(printingMatchesSearchTab({
    name: 'Arceus: Flamemaster Theme Deck',
    set: 'HeartGold & SoulSilver Platinum',
  }, 'singles'), false);
  assert.equal(printingMatchesSearchTab({
    name: 'Arceus: Flamemaster Theme Deck',
    set: 'HeartGold & SoulSilver Platinum',
  }, 'product'), true);
  assert.equal(printingMatchesSearchTab({
    name: 'Arceus Spring 2022 Collector\'s Chest',
  }, 'singles'), false);
  assert.equal(printingMatchesSearchTab({
    name: '151: 9-Pocket Binder',
  }, 'singles'), false);
});

test('search fetch options pin card vs sealed product', () => {
  assert.deepEqual(searchFetchOptions('singles'), { productType: 'card' });
  assert.deepEqual(searchFetchOptions('product'), { productSearchOnly: true });
  assert.deepEqual(searchFetchOptions('users'), {});
});

test('unique sellers collapse listings by seller uid', () => {
  const sellers = uniqueSellers([
    { sellerUid: 'a', sellerUsername: 'mimikyu', sellerDisplayName: 'Mimi' },
    { sellerUid: 'a', sellerUsername: 'mimikyu', sellerDisplayName: 'Mimi' },
    { sellerUid: 'b', sellerUsername: 'other', sellerDisplayName: 'Other' },
  ], 'mimikyu');
  assert.equal(sellers.length, 2);
  assert.equal(sellers[0].count, 2);
  assert.equal(sellers[0].name, 'Mimi');
});

test('jumbo is a Product subtype, never a fourth top-level search entity', () => {
  // Top-level search entities are exactly Singles | Product | Users.
  assert.equal(SEARCH_TABS.map((tab) => tab.id).join(','), 'singles,product,users');
  assert.equal(SEARCH_TABS.map((tab) => tab.label).join('|'), 'Singles|Product|Users');
  // Legacy tab=jumbo state normalizes into Product everywhere.
  assert.equal(normalizeSearchTab('jumbo'), 'product');
  assert.deepEqual(searchFetchOptions('jumbo'), searchFetchOptions('product'));
  assert.equal(searchHref('mimikyu', 'jumbo'), '/marketplace/search?q=mimikyu&tab=product');
  // A jumbo row (product_type 'jumbo', item_kind 'single' per 083) rides Product.
  const jumboRow = {
    itemKind: 'single',
    productType: 'jumbo',
    name: 'Mimikyu',
    number: 'Jumbo Oversized | SVP 004',
  };
  assert.equal(printingMatchesSearchTab(jumboRow, 'jumbo'), true);
  assert.equal(printingMatchesSearchTab(jumboRow, 'product'), true);
  assert.equal(printingMatchesSearchTab(jumboRow, 'singles'), false);
  // Name-stamped legacy jumbos (pre-083 rows) classify the same way.
  const legacyJumbo = { name: 'Charizard GX', number: 'Jumbo Oversized | 211' };
  assert.equal(printingMatchesSearchTab(legacyJumbo, 'product'), true);
  assert.equal(printingMatchesSearchTab(legacyJumbo, 'singles'), false);
  const normalRow = { itemKind: 'single', productType: 'card', name: 'Dratini', number: '131/197' };
  assert.equal(printingMatchesSearchTab(normalRow, 'singles'), true);
  assert.equal(printingMatchesSearchTab(normalRow, 'jumbo'), false);
  assert.equal(printingMatchesSearchTab(normalRow, 'product'), false);
});
