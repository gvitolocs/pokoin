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

test('search tabs default to singles', () => {
  assert.equal(normalizeSearchTab(''), 'singles');
  assert.equal(normalizeSearchTab('product'), 'product');
  assert.equal(normalizeSearchTab('users'), 'users');
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
  }, 'product'), false);
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
  }, 'product'), false);
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

test('search popup has a Jumbo tab; singles and product exclude jumbos', () => {
  assert.equal(SEARCH_TABS.map((t) => t.id).join(','), 'singles,jumbo,product,users');
  assert.equal(normalizeSearchTab('jumbo'), 'jumbo');
  assert.deepEqual(searchFetchOptions('jumbo'), { productType: 'jumbo' });
  assert.deepEqual(searchFetchOptions('singles'), { productType: 'card' });
  const jumboRow = { itemKind: 'single', productType: 'jumbo', name: 'Charizard GX', number: 'Jumbo Oversized | 211' };
  assert.equal(printingMatchesSearchTab(jumboRow, 'jumbo'), true);
  assert.equal(printingMatchesSearchTab(jumboRow, 'singles'), false);
  assert.equal(printingMatchesSearchTab(jumboRow, 'product'), false);
  const normalRow = { itemKind: 'single', productType: 'card', name: 'Dratini', number: '131/197' };
  assert.equal(printingMatchesSearchTab(normalRow, 'singles'), true);
  assert.equal(printingMatchesSearchTab(normalRow, 'jumbo'), false);
  assert.equal(searchHref('charizard gx jumbo', 'jumbo'), '/marketplace/search?q=charizard+gx+jumbo&tab=jumbo');
});
