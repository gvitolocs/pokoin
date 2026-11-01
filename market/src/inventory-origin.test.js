import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeOrigins,
  duplicateKey,
  existingDuplicatesFor,
  exactSlot,
  provenSeparate,
  findCrossSourceDuplicates,
  listingOrigin,
  ORIGIN_LABELS,
  ORIGINS,
  originFacets,
} from './inventory-origin.js';
import { filterInventoryRows } from './inventory-listings.js';

test('the API origin wins when it is a known id', () => {
  assert.equal(listingOrigin({ origin: 'cardrails', source: 'cardtrader_seller_import' }), 'cardrails');
  assert.equal(listingOrigin({ origin: 'CardTrader' }), 'cardtrader');
  assert.equal(listingOrigin({ origin: 'ebay', source: 'tcgplayer_csv_import' }), 'tcgplayer');
  assert.equal(listingOrigin({ origin: '', source: 'stock_csv_import' }), 'csv');
});

test('the Card Rails connector flag maps to cardrails', () => {
  assert.equal(listingOrigin({ cardrails_key: true, source: 'pokoin_user_listing' }), 'cardrails');
  assert.equal(listingOrigin({ cardrailsKey: true }), 'cardrails');
});

test('sources and source listing ids map to their channel', () => {
  for (const source of ['cardtrader_seller_import', 'cardtrader_csv_import', 'cardtrader_live', 'cardtrader']) {
    assert.equal(listingOrigin({ source }), 'cardtrader', source);
  }
  assert.equal(listingOrigin({ source: 'powertools_csv_import' }), 'cardmarket');
  assert.equal(listingOrigin({ source: 'cardmarket_csv_import' }), 'cardmarket');
  assert.equal(listingOrigin({ source_listing_id: 'pt:1' }), 'cardmarket');
  assert.equal(listingOrigin({ sourceListingId: 'cm:1' }), 'cardmarket');
  assert.equal(listingOrigin({ source: 'tcgplayer_csv_import' }), 'tcgplayer');
  assert.equal(listingOrigin({ sourceListingId: 'tp:9' }), 'tcgplayer');
  assert.equal(listingOrigin({ source: 'stock_csv_import' }), 'csv');
});

test('everything else is Pokoin, and a ct: id alone changes nothing', () => {
  assert.equal(listingOrigin({ source: 'pokoin_scan_batch', sourceListingId: 'scan:1' }), 'pokoin');
  assert.equal(listingOrigin({ source: 'pokoin_user_listing' }), 'pokoin');
  assert.equal(listingOrigin({}), 'pokoin');
  assert.equal(listingOrigin(null), 'pokoin');
  assert.equal(listingOrigin({ source: 'mystery' }), 'pokoin');
  assert.equal(listingOrigin({ source: 'pokoin_user_listing', sourceListingId: 'ct:123' }), 'pokoin');
});

test('every origin has a label', () => {
  for (const origin of ORIGINS) assert.ok(ORIGIN_LABELS[origin], origin);
  assert.equal(ORIGIN_LABELS.cardrails, 'Card Rails');
  assert.equal(ORIGIN_LABELS.csv, 'CSV import');
});

const base = { cardId: '220962', condition: 'NM', language: 'EN', status: 'active', quantityAvailable: 1 };
const row = (id, extra = {}) => ({ id, ...base, ...extra });

test('exactSlot accepts only a complete box, stack and position', () => {
  assert.equal(exactSlot({ location: ' Box·6·31 ' }), 'box·6·31');
  for (const location of ['box1·2', 'binder', 'BIN-07', 'FUOCOBOMBA 006 - 16', '', 'a·b·c', 'a·1·', '·1·2', 'a·1·2·3', ' ·1·2']) {
    assert.equal(exactSlot({ location }), '', location);
  }
  assert.equal(exactSlot(null), '');
  assert.equal(provenSeparate({ location: 'a·1·1' }, { location: 'a·2·2' }), true);
  assert.equal(provenSeparate({ location: ' A·1·1 ' }, { location: 'a·1·1' }), false);
  assert.equal(provenSeparate({ location: 'binder' }, { location: 'a·1·1' }), false);
});

test('production Ultra Ball copies in five separate slots are not flagged', () => {
  const rows = ['6·31', '8·65', '1·11', '1·17', '2·21'].map((slot, i) => row(String(i), {
    cardId: 'ultra-ball-146-159', language: 'IT',
    location: `megaevoluzionietb·${slot}`, origin: i < 2 ? 'cardrails' : 'pokoin',
  }));
  assert.deepEqual(findCrossSourceDuplicates(rows), new Map());
});

test('the same exact slot from different origins stays flagged', () => {
  const rows = [row('a', { origin: 'cardrails', location: ' Box·6·31 ' }), row('b', { location: 'box·6·31' })];
  assert.deepEqual([...findCrossSourceDuplicates(rows).keys()], ['a', 'b']);
});

test('missing locations and free-form labels cannot prove separation from an exact slot', () => {
  for (const location of [undefined, '', 'binder', 'box1·2', 'BIN-07', 'FUOCOBOMBA 006 - 16']) {
    const rows = [row('a', { origin: 'cardrails', location: 'a·1·1' }), row('b', { location })];
    assert.deepEqual([...findCrossSourceDuplicates(rows).keys()], ['a', 'b'], location);
  }
});

test('mixed groups keep only each row’s possible duplicates and their origins', () => {
  const rows = [
    row('a', { origin: 'cardrails', location: 'a·1·1' }),
    row('b', { origin: 'pokoin', location: 'a·2·2' }),
    row('c', { origin: 'cardtrader' }),
  ];
  const dups = findCrossSourceDuplicates(rows);
  assert.equal(dups.size, 3);
  assert.deepEqual(dups.get('c').others, [
    { id: 'a', origin: 'cardrails', quantity: 1 },
    { id: 'b', origin: 'pokoin', quantity: 1 },
  ]);
  for (const id of ['a', 'b']) {
    assert.deepEqual(dups.get(id).others, [{ id: 'c', origin: 'cardtrader', quantity: 1 }]);
  }
  assert.deepEqual(dups.get('a').origins, ['cardrails', 'cardtrader']);
  assert.deepEqual(dups.get('b').origins, ['pokoin', 'cardtrader']);
  assert.deepEqual(dups.get('c').origins, ['pokoin', 'cardrails', 'cardtrader']);
  rows[2].location = 'a·1·1';
  assert.deepEqual([...findCrossSourceDuplicates(rows).keys()], ['a', 'c']);
});

test('existingDuplicatesFor still warns across different exact slots', () => {
  const existing = row('a', { origin: 'cardrails', location: 'a·1·1' });
  assert.deepEqual(existingDuplicatesFor([existing], row('scan', { location: 'a·2·2' })), [existing]);
});

test('duplicateKey normalizes facets and needs a card id', () => {
  assert.equal(duplicateKey({ card_id: ' 220962 ' }), '220962|NM|EN|standard|');
  assert.equal(duplicateKey({ cardId: '1', condition: 'lp', language: 'it', foil_state: 'Holo', first_edition: true }), '1|LP|IT|holo|1st');
  assert.equal(duplicateKey({ cardId: '1', reverse: true }), '1|NM|EN|reverse|');
  assert.equal(duplicateKey({ cardId: '1', graded: true, gradingCompany: 'PSA', grade: '10' }), '1|NM|EN|standard||graded:PSA 10');
  assert.equal(duplicateKey({ cardId: '1', certificationId: 'abc' }), '1|NM|EN|standard||graded:ABC');
  assert.equal(duplicateKey({ cardId: '' }), '');
  assert.equal(duplicateKey({}), '');
});

test('the same printing from Card Rails and CardTrader is flagged', () => {
  const rows = [
    row('a', { origin: 'cardrails' }),
    row('b', { source: 'cardtrader_seller_import', sourceListingId: 'ct:5', quantityAvailable: 2 }),
    row('c', { cardId: '999' }),
  ];
  const dups = findCrossSourceDuplicates(rows);
  assert.deepEqual([...dups.keys()].sort(), ['a', 'b']);
  assert.deepEqual(dups.get('a').origins, ['cardrails', 'cardtrader']);
  assert.deepEqual(dups.get('a').others, [{ id: 'b', origin: 'cardtrader', quantity: 2 }]);
  assert.deepEqual(dups.get('b').others, [{ id: 'a', origin: 'cardrails', quantity: 1 }]);
  assert.equal(describeOrigins(dups.get('a').others), 'CardTrader (qty 2)');
});

test('same-origin copies are not duplicates', () => {
  const rows = [row('a', { source: 'pokoin_scan_batch' }), row('b', { source: 'pokoin_scan_batch' }), row('c')];
  assert.equal(findCrossSourceDuplicates(rows).size, 0);
});

test('a different condition, language, finish, edition, reverse or slab is another copy', () => {
  const ct = { source: 'cardtrader_seller_import' };
  for (const extra of [
    { condition: 'LP' },
    { language: 'JP' },
    { foilState: 'holo' },
    { firstEdition: true },
    { reverse: true },
    { graded: true, gradingCompany: 'PSA', grade: '9' },
  ]) {
    const dups = findCrossSourceDuplicates([row('a'), row('b', { ...ct, ...extra })]);
    assert.equal(dups.size, 0, JSON.stringify(extra));
  }
  const slab = { graded: true, gradingCompany: 'PSA', grade: '10' };
  assert.equal(findCrossSourceDuplicates([row('a', { ...slab, certificationId: '1' }), row('b', { ...ct, ...slab, certificationId: '2' })]).size, 0);
  assert.equal(findCrossSourceDuplicates([row('a', { ...slab, certificationId: '1' }), row('b', { ...ct, ...slab, certificationId: '1' })]).size, 2);
});

test('sold-out, inactive and id-less rows are ignored', () => {
  const ct = { source: 'cardtrader_seller_import' };
  assert.equal(findCrossSourceDuplicates([row('a'), row('b', { ...ct, quantityAvailable: 0 })]).size, 0);
  assert.equal(findCrossSourceDuplicates([row('a'), row('b', { ...ct, status: 'inactive' })]).size, 0);
  assert.equal(findCrossSourceDuplicates([row('a', { cardId: '' }), row('b', { ...ct, cardId: '' })]).size, 0);
  assert.equal(findCrossSourceDuplicates([row('a', { status: 'paused' }), row('b', ct)]).size, 2);
});

test('a Pokoin row pushed to CardTrader still duplicates a CardTrader import', () => {
  const rows = [
    row('a', { source: 'pokoin_user_listing', sourceListingId: 'ct:77' }),
    row('b', { source: 'cardtrader_seller_import', sourceListingId: 'ct:78' }),
  ];
  assert.deepEqual(findCrossSourceDuplicates(rows).get('a').origins, ['pokoin', 'cardtrader']);
});

test('existingDuplicatesFor finds live rows of the candidate from other origins', () => {
  const book = [
    row('a', { origin: 'cardrails' }),
    row('b', { source: 'pokoin_scan_batch' }),
    row('c', { source: 'cardtrader_seller_import', status: 'inactive' }),
    row('d', { origin: 'cardtrader', language: 'JP' }),
  ];
  const candidate = { cardId: '220962', condition: 'NM', language: 'EN' };
  assert.deepEqual(existingDuplicatesFor(book, candidate).map((r) => r.id), ['a']);
  assert.deepEqual(existingDuplicatesFor(book, candidate, { origin: 'cardrails' }).map((r) => r.id), ['b']);
  assert.deepEqual(existingDuplicatesFor(book, { condition: 'NM' }), []);
  assert.equal(describeOrigins(existingDuplicatesFor(book, candidate)), 'Card Rails (qty 1)');
});

test('originFacets counts the origins present', () => {
  const rows = [row('a'), row('b', { origin: 'cardrails' }), row('c', { origin: 'cardrails' })];
  assert.deepEqual(originFacets(rows), [
    { id: 'pokoin', label: 'Pokoin', count: 1 },
    { id: 'cardrails', label: 'Card Rails', count: 2 },
  ]);
});

test('filterInventoryRows filters by origin and duplicates', () => {
  const rows = [row('a', { origin: 'cardrails' }), row('b', { source: 'cardtrader_seller_import' }), row('c', { cardId: '5' })];
  assert.deepEqual(filterInventoryRows(rows, { origin: 'cardrails' }).map((r) => r.id), ['a']);
  assert.deepEqual(filterInventoryRows(rows, { origin: 'pokoin' }).map((r) => r.id), ['c']);
  const duplicates = findCrossSourceDuplicates(rows);
  assert.deepEqual(filterInventoryRows(rows, { duplicatesOnly: true, duplicates }).map((r) => r.id), ['a', 'b']);
  assert.deepEqual(filterInventoryRows(rows, { duplicatesOnly: true, duplicates: new Set(['c']) }).map((r) => r.id), ['c']);
  assert.equal(filterInventoryRows(rows, { duplicates }).length, 3);
});

test('an import source wins over a Card Rails key', () => {
  const key = { cardrailsKey: true };
  assert.equal(listingOrigin({ ...key, source: 'cardtrader_seller_import', sourceListingId: 'ct:1' }), 'cardtrader');
  assert.equal(listingOrigin({ ...key, source: 'powertools_csv_import' }), 'cardmarket');
  assert.equal(listingOrigin({ ...key, source: 'tcgplayer_csv_import' }), 'tcgplayer');
  assert.equal(listingOrigin({ ...key, source: 'stock_csv_import' }), 'csv');
  assert.equal(listingOrigin({ ...key, source: 'pokoin_user_listing', sourceListingId: 'ct:1' }), 'cardrails');
});
