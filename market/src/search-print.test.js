import assert from 'node:assert/strict';
import test from 'node:test';
import { cardsForPrint, loadSearchPrintPage } from './search-print.js';

const latios = [
  { id: '1', name: 'Latios ex', nationality: '', set: 'EX Dragon' },
  { id: '2', name: 'Latios EX', nationality: '', set: 'Emerald Break' },
  { id: '3', name: 'Latias ex', nationality: '', set: 'CSV9: Stellar Crystal' },
];

test('blank-nationality search rows follow the expansion, not the empty API bucket', () => {
  const western = cardsForPrint(latios, 'western');
  assert.deepEqual(western.map((card) => card.id), ['1']);
  const japanese = cardsForPrint(latios, 'japanese');
  assert.deepEqual(japanese.map((card) => card.id), ['2']);
  assert.equal(cardsForPrint(latios, 'all').length, 3);
});

test('an empty first print page keeps walking until a matching card', async () => {
  const pages = [
    { cards: [latios[1]], hasMore: true },
    { cards: [latios[0], latios[2]], hasMore: false },
  ];
  const loaded = await loadSearchPrintPage({
    printLang: 'western',
    fetchPage: async (offset) => pages[offset] || { cards: [], hasMore: false },
  });
  assert.deepEqual(loaded.cards.map((card) => card.id), ['1']);
  assert.equal(loaded.hasMore, false);
  assert.equal(loaded.nextOffset, 3);
});
