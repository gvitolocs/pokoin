import assert from 'node:assert/strict';
import test from 'node:test';
import { filterSellerBook } from './seller-shop-filter.js';

const rows = [
  { id: '1', cardId: 'a', cardName: 'Pikachu', setName: 'Base', collectorNumber: '58', condition: 'NM', language: 'EN', reverse: false, firstEdition: false, rarity: 'Common', foilState: 'standard', pricePkn: 10, quantityAvailable: 1, updatedAt: '2026-10-01T00:00:00.000Z' },
  { id: '2', cardId: 'a', cardName: 'Pikachu', setName: 'Base', collectorNumber: '58', condition: 'LP', language: 'IT', reverse: true, firstEdition: false, rarity: 'Common', foilState: 'reverse', pricePkn: 4, quantityAvailable: 2, updatedAt: '2026-10-02T00:00:00.000Z' },
  { id: '3', cardId: 'b', cardName: 'Charizard', setName: 'Base', collectorNumber: '4', condition: 'NM', language: 'EN', reverse: true, firstEdition: true, rarity: 'Holo Rare', foilState: 'holo', pricePkn: 40, quantityAvailable: 1, updatedAt: '2026-09-01T00:00:00.000Z' },
];

test('reverse filter keeps only reverse rows and stays local', () => {
  const filtered = filterSellerBook(rows, { reverse: true, sort: 'price-asc' });
  assert.deepEqual(filtered.rows.map((row) => row.id), ['2', '3']);
  assert.equal(filtered.unique, 2);
  assert.equal(filtered.copies, 3);
});

test('unique items are product rows, total items is the copy sum', () => {
  const filtered = filterSellerBook(rows, {});
  assert.equal(filtered.unique, 3);
  assert.equal(filtered.copies, 4);
});

test('condition language rarity and name search stack', () => {
  const filtered = filterSellerBook(rows, {
    q: 'pika',
    condition: 'SP',
    language: 'IT',
    reverse: true,
  });
  assert.deepEqual(filtered.rows.map((row) => row.id), ['2']);
});

test('holo matches foil state or rarity text', () => {
  const filtered = filterSellerBook(rows, { rarity: 'holo' });
  assert.deepEqual(filtered.rows.map((row) => row.id), ['3']);
});

test('promo matches the printed rarity and common does not', () => {
  const book = [
    ...rows,
    { id: '4', cardId: 'p', cardName: 'Pikachu', setName: 'SVP', collectorNumber: '001', condition: 'NM', language: 'EN', reverse: false, firstEdition: false, rarity: 'Promo', foilState: 'standard', pricePkn: 8, quantityAvailable: 1, updatedAt: '2026-10-03T00:00:00.000Z' },
  ];
  assert.deepEqual(filterSellerBook(book, { rarity: 'promo' }).rows.map((row) => row.id), ['4']);
  assert.deepEqual(filterSellerBook(book, { rarity: 'common' }).rows.map((row) => row.id).sort(), ['1', '2']);
});

test('no rarity matches that printed label only', () => {
  const book = [
    ...rows,
    { id: '5', cardId: 'n', cardName: 'Pikachu', setName: 'Base', collectorNumber: '58', condition: 'NM', language: 'EN', reverse: false, firstEdition: false, rarity: 'No Rarity', foilState: 'standard', pricePkn: 2, quantityAvailable: 1, updatedAt: '2026-10-03T00:00:00.000Z' },
  ];
  assert.deepEqual(filterSellerBook(book, { rarity: 'no-rarity' }).rows.map((row) => row.id), ['5']);
  assert.equal(filterSellerBook(book, { rarity: 'rare' }).rows.some((row) => row.id === '5'), false);
});

test('price sort puts the cheapest reverse first', () => {
  const filtered = filterSellerBook(rows, { reverse: true, sort: 'price-asc' });
  assert.equal(filtered.rows[0].id, '2');
  const desc = filterSellerBook(rows, { reverse: true, sort: 'price-desc' });
  assert.equal(desc.rows[0].id, '3');
});

// --- the indexed filter against the plain filter-then-sort it replaced -------

function plainFilter(listings, filters = {}) {
  const codes = {
    NM: ['NM', 'M'], M: ['NM', 'M'], SP: ['SP', 'LP'], LP: ['SP', 'LP'], MP: ['MP'], PL: ['PL', 'HP'], HP: ['PL', 'HP'],
    POOR: ['PO', 'POOR', 'D', 'DMG'], PO: ['PO', 'POOR', 'D', 'DMG'], D: ['PO', 'POOR', 'D', 'DMG'], DMG: ['PO', 'POOR', 'D', 'DMG'],
  }[String(filters.condition || '').trim().toUpperCase()] || null;
  const q = String(filters.q || '').trim().toLowerCase();
  const language = String(filters.language || '').trim().toUpperCase();
  const time = (value) => { const ms = new Date(value || 0).getTime(); return Number.isFinite(ms) ? ms : 0; };
  const out = listings.filter((row) => {
    if (q && !`${row.cardName || ''} ${row.setName || ''} ${row.collectorNumber || ''}`.toLowerCase().includes(q)) return false;
    if (codes && !codes.includes(String(row.condition || '').trim().toUpperCase())) return false;
    if (language && !String(row.language || '').trim().toUpperCase().startsWith(language)) return false;
    if (filters.reverse && row.reverse !== true) return false;
    if (filters.firstEdition && row.firstEdition !== true) return false;
    if (filters.rarity === 'common' && !(String(row.rarity || '').toLowerCase().includes('common') && !String(row.rarity || '').toLowerCase().includes('uncommon'))) return false;
    return true;
  });
  out.sort((a, b) => {
    const pa = Number.isFinite(Number(a.pricePkn)) ? Number(a.pricePkn) : Number.POSITIVE_INFINITY;
    const pb = Number.isFinite(Number(b.pricePkn)) ? Number(b.pricePkn) : Number.POSITIVE_INFINITY;
    const updated = time(b.updatedAt) - time(a.updatedAt);
    const created = time(b.createdAt) - time(a.createdAt);
    switch (String(filters.sort || '').toLowerCase()) {
      case 'price-desc': return (pb - pa) || updated || created;
      case 'qty': return ((Number(b.quantityAvailable) || 0) - (Number(a.quantityAvailable) || 0)) || (pa - pb) || updated;
      case 'name': return String(a.cardName || '').toLowerCase().localeCompare(String(b.cardName || '').toLowerCase()) || (pa - pb);
      default: return (pa - pb) || updated || created;
    }
  });
  return out;
}

function bigBook(size) {
  let seed = 7;
  const next = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const names = ['Pikachu', 'charizard ex', 'Éevee', 'Mew', 'mewtwo', 'Zapdos', 'Gengar', 'Umbreon VMAX'];
  return Array.from({ length: size }, (_, index) => ({
    id: String(index),
    cardName: `${names[next(names.length)]} ${next(40)}`,
    setName: ['Base', 'Jungle', 'Fossil'][next(3)],
    collectorNumber: String(next(200)),
    condition: ['NM', 'LP', 'MP', 'PO', 'sp ', ''][next(6)],
    language: ['EN', 'IT', 'JP', 'en'][next(4)],
    reverse: next(5) === 0,
    firstEdition: next(9) === 0,
    rarity: ['Common', 'Uncommon', 'Rare', null][next(4)],
    foilState: 'standard',
    pricePkn: next(50) === 0 ? null : next(30) * 10,
    quantityAvailable: 1 + next(3),
    updatedAt: `2026-10-${String(1 + next(9)).padStart(2, '0')}T00:00:00.000Z`,
    createdAt: `2026-09-${String(1 + next(9)).padStart(2, '0')}T00:00:00.000Z`,
  }));
}

test('the indexed book gives the same rows in the same order as filtering then sorting', () => {
  const book = bigBook(3000);
  const cases = [
    {}, { sort: 'price-desc' }, { sort: 'qty' }, { sort: 'name' }, { sort: 'nonsense' },
    { condition: 'NM', sort: 'price-desc' }, { condition: 'lp' }, { language: 'en', sort: 'name' },
    { reverse: true, sort: 'qty' }, { firstEdition: true }, { q: ' PIKA ', sort: 'price-desc' },
    { rarity: 'common', language: 'IT', sort: 'price-asc' }, { q: 'no such card' },
  ];
  for (const filters of cases) {
    const expected = plainFilter(book, filters);
    const actual = filterSellerBook(book, filters);
    assert.deepEqual(actual.rows.map((row) => row.id), expected.map((row) => row.id), JSON.stringify(filters));
    assert.equal(actual.unique, expected.length);
    assert.equal(actual.copies, expected.reduce((sum, row) => sum + row.quantityAvailable, 0));
  }
  // The result is the caller's to slice; the book itself is never reordered.
  assert.equal(book[0].id, '0');
  assert.notEqual(filterSellerBook(book, {}).rows, filterSellerBook(book, {}).rows);
});

test('a ten-thousand-row shop answers a filter click in a few milliseconds once indexed', () => {
  const book = bigBook(10000);
  filterSellerBook(book, { sort: 'price-desc' });
  const started = performance.now();
  let rows = 0;
  for (const condition of ['NM', 'LP', 'MP', 'PO', '']) {
    for (const language of ['EN', 'IT', '']) rows += filterSellerBook(book, { condition, language, sort: 'price-desc' }).rows.length;
  }
  const perClick = (performance.now() - started) / 15;
  assert.ok(rows > 0);
  assert.ok(perClick < 25, `a filter click took ${perClick.toFixed(1)} ms`);
});

test('anything that is not a book filters to nothing', () => {
  assert.deepEqual(filterSellerBook(null, { reverse: true }), { rows: [], unique: 0, copies: 0 });
  assert.deepEqual(filterSellerBook(undefined), { rows: [], unique: 0, copies: 0 });
});
