import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterInventoryRows,
  groupBoxStacks,
  groupInventoryStacks,
  inventoryStackKey,
  inventoryRowsForLocation,
  inventoryFacets,
  inventoryListingHref,
  inventoryListingMeta,
  inventoryRowDate,
  isLiveInventoryListing,
  listingBox,
  lastOccupiedIndex,
  listingSlotEnd,
  maxOccupiedStack,
  nextFreeSlot,
  nextPositionInStack,
  occupiedAbsForScanBoxes,
  parseListingLocation,
  liveInventoryListings,
  sameListingBox,
  sortInventoryRows,
  summarizeLiveInventory,
} from './inventory-listings.js';

test('inventory hides cancelled and sold-out rows', () => {
  const rows = liveInventoryListings([
    { id: '1', status: 'active', quantityAvailable: 1, cardId: '244538' },
    { id: '2', status: 'inactive', quantityAvailable: 1, cardId: '573732' },
    { id: '3', status: 'sold_out', quantityAvailable: 0, cardId: '713832' },
    { id: '4', status: 'paused', quantityAvailable: 2, cardId: '243340' },
    { id: '5', status: 'active', quantityAvailable: 0, cardId: '238622' },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['1', '4']);
  assert.equal(isLiveInventoryListing({ status: 'inactive', quantityAvailable: 1 }), false);
});

test('inventory links prefer canonical desk paths', () => {
  assert.equal(
    inventoryListingHref({
      cardId: '244538',
      canonicalPath: '/marketplace/en/cards/244538/card-mewtwo-lv-x-legends-awakened',
    }),
    '/marketplace/en/cards/244538/card-mewtwo-lv-x-legends-awakened',
  );
  assert.equal(inventoryListingHref({ cardId: '244538' }), '/marketplace/en/cards/244538');
  assert.equal(inventoryListingHref({}), '/marketplace');
});

test('inventory meta marks paused and non-EN language', () => {
  const meta = inventoryListingMeta(
    { pricePkn: 324, condition: 'NM', quantityAvailable: 1, status: 'paused', language: 'JP' },
    (n) => `${n} PKN`,
  );
  assert.equal(meta, '324 PKN · NM · qty 1 · paused · JP');
});

test('inventory meta includes scan location when present', () => {
  const meta = inventoryListingMeta(
    {
      pricePkn: 200,
      condition: 'NM',
      quantityAvailable: 2,
      language: 'EN',
      location: 'box1·47',
    },
    (n) => `${n} PKN`,
  );
  assert.equal(meta, '200 PKN · NM · qty 2 · box1·47');
});

test('inventory meta omits blank location', () => {
  const meta = inventoryListingMeta(
    { pricePkn: 100, condition: 'LP', quantityAvailable: 1, location: '  ' },
    (n) => `${n} PKN`,
  );
  assert.equal(meta, '100 PKN · LP · qty 1');
});

test('summarizeLiveInventory counts qty and asking value for live rows only', () => {
  const summary = summarizeLiveInventory([
    { status: 'active', quantityAvailable: 2, pricePkn: 100 },
    { status: 'paused', quantityAvailable: 1, pricePkn: 50 },
    { status: 'inactive', quantityAvailable: 9, pricePkn: 999 },
    { status: 'sold_out', quantityAvailable: 0, pricePkn: 40 },
    { status: 'active', quantityAvailable: 0, pricePkn: 10 },
  ]);
  assert.equal(summary.listings, 2);
  assert.equal(summary.cards, 3);
  assert.equal(summary.listedPkn, 250);
});

test('summarizeLiveInventory empty input is zeroes', () => {
  assert.deepEqual(summarizeLiveInventory([]), { listings: 0, cards: 0, listedPkn: 0 });
  assert.deepEqual(summarizeLiveInventory(null), { listings: 0, cards: 0, listedPkn: 0 });
});

test('inventory filters by query, status, condition and language', () => {
  const rows = [
    { id: '1', cardName: 'Hoothoot', setName: 'Prismatic Evolutions', collectorNumber: '077/131', status: 'active', condition: 'NM', language: 'IT', pricePkn: 33, quantityAvailable: 1, createdAt: '2026-09-30T10:00:00Z' },
    { id: '2', cardName: 'Hoothoot', setName: 'Prismatic Evolutions', collectorNumber: '132-4', status: 'paused', condition: 'NM', language: 'IT', pricePkn: 300, quantityAvailable: 3, createdAt: '2026-09-29T10:00:00Z' },
    { id: '3', cardName: 'Gambler', setName: 'Fossil', collectorNumber: '060/062', status: 'active', condition: 'SP', language: 'EN', pricePkn: 12, quantityAvailable: 1, createdAt: '2026-09-28T10:00:00Z' },
  ];
  assert.deepEqual(filterInventoryRows(rows, { query: 'hoothoot' }).map((r) => r.id), ['1', '2']);
  assert.deepEqual(filterInventoryRows(rows, { query: 'fossil' }).map((r) => r.id), ['3']);
  assert.deepEqual(filterInventoryRows(rows, { status: 'paused' }).map((r) => r.id), ['2']);
  assert.deepEqual(filterInventoryRows(rows, { condition: 'sp' }).map((r) => r.id), ['3']);
  assert.deepEqual(filterInventoryRows(rows, { language: 'it' }).map((r) => r.id), ['1', '2']);
  assert.deepEqual(filterInventoryRows(rows, { query: '077' }).map((r) => r.id), ['1']);
  assert.equal(filterInventoryRows(rows, {}).length, 3);
});

test('inventory sorts by date, price, qty and name', () => {
  const rows = [
    { id: 'a', cardName: 'Hoothoot', pricePkn: 300, quantityAvailable: 3, createdAt: '2026-09-29' },
    { id: 'b', cardName: 'Gambler', pricePkn: 12, quantityAvailable: 1, createdAt: '2026-09-30' },
    { id: 'c', cardName: 'Abra', pricePkn: 100, quantityAvailable: 2, createdAt: '2026-09-28' },
  ];
  assert.deepEqual(sortInventoryRows(rows, 'newest').map((r) => r.id), ['b', 'a', 'c']);
  assert.deepEqual(sortInventoryRows(rows, 'oldest').map((r) => r.id), ['c', 'a', 'b']);
  assert.deepEqual(sortInventoryRows(rows, 'price-up').map((r) => r.id), ['b', 'c', 'a']);
  assert.deepEqual(sortInventoryRows(rows, 'price-down').map((r) => r.id), ['a', 'c', 'b']);
  assert.deepEqual(sortInventoryRows(rows, 'qty-down').map((r) => r.id), ['a', 'c', 'b']);
  assert.deepEqual(sortInventoryRows(rows, 'name').map((r) => r.id), ['c', 'b', 'a']);
});

test('inventory facets list distinct conditions and languages', () => {
  const facets = inventoryFacets([
    { condition: 'NM', language: 'IT' },
    { condition: 'nm', language: 'it' },
    { condition: 'SP', language: 'EN' },
  ]);
  assert.deepEqual(facets.conditions, ['NM', 'SP']);
  assert.deepEqual(facets.languages, ['EN', 'IT']);
});

test('inventory row date formats to day/month', () => {
  assert.equal(inventoryRowDate({ createdAt: '2026-09-30T10:00:00Z' }), '30/09');
  assert.equal(inventoryRowDate({ created_at: '2026-09-09T10:00:00Z' }), '09/09');
  assert.equal(inventoryRowDate({}), '');
});

test('inventory stacks group identical printings and sort by posting count', () => {
  const rows = [
    { id: '1', cardId: '633380', cardName: 'Hoothoot', setName: 'Prismatic Evolutions', collectorNumber: '077/131', condition: 'NM', language: 'IT', quantityAvailable: 1, location: 'box1·1', createdAt: '2026-09-30' },
    { id: '2', cardId: '633380', cardName: 'Hoothoot', setName: 'Prismatic Evolutions', collectorNumber: '077/131', condition: 'NM', language: 'IT', quantityAvailable: 2, location: 'box1·1', createdAt: '2026-09-29' },
    { id: '3', cardId: '633380', cardName: 'Hoothoot', setName: 'Prismatic Evolutions', collectorNumber: '077/131', condition: 'SP', language: 'IT', quantityAvailable: 1, location: 'box1·1', createdAt: '2026-09-28' },
    { id: '4', cardId: '713832', cardName: 'Gambler', setName: 'Fossil', collectorNumber: '060/062', condition: 'NM', language: 'EN', quantityAvailable: 5, location: 'box1·1', createdAt: '2026-09-27' },
  ];
  const stacks = groupInventoryStacks(rows);
  // Hoothoot NM IT has 2 postings — busiest stack first.
  assert.deepEqual(stacks.map((s) => [s.cardName, s.postingCount]), [
    ['Hoothoot', 2],
    ['Gambler', 1],
    ['Hoothoot', 1],
  ]);
  assert.equal(stacks[0].copies, 3);
  assert.equal(stacks[0].postings.length, 2);
  // Different condition = a different stack.
  assert.notEqual(stacks[0].key, stacks[2].key);
});

test('inventory stack key separates foil facets', () => {
  const base = { cardId: '1', condition: 'NM', language: 'EN' };
  assert.equal(
    inventoryStackKey(base),
    inventoryStackKey({ ...base }),
  );
  assert.notEqual(
    inventoryStackKey(base),
    inventoryStackKey({ ...base, reverse: true }),
  );
  assert.notEqual(
    inventoryStackKey(base),
    inventoryStackKey({ ...base, graded: true }),
  );
});

test('listing location grammar parses box, stack and position', () => {
  assert.deepEqual(parseListingLocation('megaevoluzionietb'), { box: 'megaevoluzionietb', stack: null, position: null, structured: false });
  assert.deepEqual(parseListingLocation('box1·47'), { box: 'box1', stack: 47, position: null, structured: true });
  assert.deepEqual(parseListingLocation('megaevoluzionietb·2-4'), { box: 'megaevoluzionietb', stack: 2, position: null, structured: true });
  assert.deepEqual(parseListingLocation('box·3·5'), { box: 'box', stack: 3, position: 5, structured: true });
  assert.deepEqual(parseListingLocation('box·3·5-9'), { box: 'box', stack: 3, position: 5, structured: true });
  assert.deepEqual(parseListingLocation('box·3·5–9·2'), { box: 'box', stack: 3, position: 5, structured: true });
  assert.equal(listingBox('box·3·5'), 'box');
  assert.equal(listingBox('PlainBox'), 'PlainBox');
  assert.equal(listingBox(''), '');
});

test('a box URL surfaces every stacked row in that box, across casing', () => {
  // /mypokoin/location/megaevoluzionietb — the URL names the box; rows stored
  // with stack/position suffixes belong to it. This used to exact-match the
  // full location string and the box desk painted "Nothing stored".
  const rows = [
    { id: 'p1', location: 'megaevoluzionietb·1·1-20', quantityAvailable: 1 },
    { id: 'p2', location: 'megaevoluzionietb·2·1-7', quantityAvailable: 2 },
    { id: 'p3', location: 'megaevoluzionietb', quantityAvailable: 1 },
    { id: 'p4', location: 'other·9', quantityAvailable: 1 },
    { id: 'p5', location: '', quantityAvailable: 1 },
  ];
  assert.equal(rows.filter((row) => sameListingBox(row.location, 'megaevoluzionietb')).length, 3);
  // Same box, different casing in the URL.
  assert.equal(rows.filter((row) => sameListingBox(row.location, 'MegaEvoluzioniETB')).length, 3);
  // Full slot string in the URL still opens the box.
  assert.equal(rows.filter((row) => sameListingBox(row.location, 'megaevoluzionietb·2-4')).length, 3);
  assert.equal(sameListingBox('', 'megaevoluzionietb'), false);
  assert.equal(sameListingBox(undefined, 'megaevoluzionietb'), false);
  assert.equal(sameListingBox('other·9', 'megaevoluzionietb'), false);

  const stacks = groupBoxStacks(rows, 'MegaEvoluzioniETB');
  assert.deepEqual(stacks.map((s) => s.stack), [1, 2, 0]);
  assert.equal(stacks[0].postings[0].id, 'p1');
  assert.equal(stacks[2].postings[0].id, 'p3');
});

test('box stacks order by stack number then position, unnumbered last', () => {
  const rows = [
    { id: 'p1', location: 'box·3·5', quantityAvailable: 1, createdAt: '2026-09-30' },
    { id: 'p2', location: 'box·1', quantityAvailable: 2, createdAt: '2026-09-29' },
    { id: 'p3', location: 'box·1-2', quantityAvailable: 1, createdAt: '2026-09-28' },
    { id: 'p4', location: 'box·3·2', quantityAvailable: 1, createdAt: '2026-09-27' },
    { id: 'p5', location: 'box', quantityAvailable: 1, createdAt: '2026-09-26' },
    { id: 'p6', location: 'other·9', quantityAvailable: 1 },
  ];
  const stacks = groupBoxStacks(rows, 'box');
  assert.deepEqual(stacks.map((s) => s.stack), [3, 0]);
  assert.deepEqual(stacks[0].postings.map((p) => p.id), ['p4', 'p1']);
  assert.deepEqual(stacks[1].postings.map((p) => p.id), ['p3', 'p2', 'p5']);
  assert.equal(maxOccupiedStack(rows, 'box'), 3);
  assert.equal(maxOccupiedStack(rows, 'other'), 9);
});

test('listingSlotEnd reads where a slot string ends', () => {
  assert.deepEqual(listingSlotEnd('box·7'), { box: 'box', stack: 7, position: null });
  assert.deepEqual(listingSlotEnd('box·7-9'), { box: 'box', stack: 9, position: null });
  assert.deepEqual(listingSlotEnd('box·3·5'), { box: 'box', stack: 3, position: 5 });
  assert.deepEqual(listingSlotEnd('box·3·5-9'), { box: 'box', stack: 3, position: 9 });
  assert.deepEqual(listingSlotEnd('box·3·5–9·2'), { box: 'box', stack: 9, position: 2 });
  assert.deepEqual(listingSlotEnd('box'), { box: 'box', stack: null, position: null });
});

test('a box continues after its stock: position inside a half-full stack, not stack + 1', () => {
  const rows = [
    { location: 'megaevoluzionietb·1·1-20' },
    { location: 'megaevoluzionietb·2·1-7' },
    { location: 'other·9·3' },
    { location: 'megaevoluzionietb' },
  ];
  assert.equal(lastOccupiedIndex(rows, 'megaevoluzionietb', 20), 27);
  assert.deepEqual(nextFreeSlot(rows, 'megaevoluzionietb', 20), { stack: 2, startPosition: 8, abs: 28 });
  // A full stack rolls over to the next divider.
  assert.deepEqual(nextFreeSlot([{ location: 'b·2·1-20' }], 'b', 20), { stack: 3, startPosition: 1, abs: 41 });
  // One card per stack: the stack number is the running slot.
  assert.deepEqual(nextFreeSlot([{ location: 'b·1-41' }, { location: 'b·7' }], 'b', 1), { stack: 42, startPosition: 1, abs: 42 });
  assert.equal(nextFreeSlot(rows, 'empty-box', 20), null);
});

test('typing a stack continues after the cards already in it', () => {
  const rows = [{ location: 'b·3·1-12' }, { location: 'b·4·1–5·2' }, { location: 'b·6' }];
  assert.equal(nextPositionInStack(rows, 'b', 3, 20), 13);
  assert.equal(nextPositionInStack(rows, 'b', 4, 20), 21); // spilled over: full
  assert.equal(nextPositionInStack(rows, 'b', 5, 20), 3);
  assert.equal(nextPositionInStack(rows, 'b', 6, 20), 21); // whole-stack location
  assert.equal(nextPositionInStack(rows, 'b', 7, 20), null);
  assert.equal(nextPositionInStack(rows, 'b', 3, 1), null);
});

test('occupiedAbsForScanBoxes seeds the scan desk from live inventory', () => {
  const stock = [
    { location: 'megaevoluzionietb·40' },
    { location: 'megaevoluzionietb·41' },
    { location: 'other·9' },
  ];
  const scan = [
    { location: 'megaevoluzionietb', defaultsSnapshot: { stackSize: 1 } },
    { location: 'megaevoluzionietb', defaultsSnapshot: { stackSize: 1 } },
  ];
  const map = occupiedAbsForScanBoxes(scan, stock);
  assert.equal(map.get('megaevoluzionietb'), 41);
  assert.equal(map.has('other'), false);
});


test('location pages include every slot in the linked box without matching neighboring boxes', () => {
  const rows = [
    { id: 'bare', location: 'megaevoluzionietb1', quantityAvailable: 1 },
    { id: 'stack', location: 'megaevoluzionietb1·1', quantityAvailable: 2 },
    { id: 'position', location: 'megaevoluzionietb1·2·3', quantityAvailable: 1 },
    { id: 'range', location: ' megaevoluzionietb1•2•4-6 ', quantityAvailable: 3 },
    { id: 'neighbor', location: 'megaevoluzionietb10·1', quantityAvailable: 1 },
    { id: 'other', location: 'other·1', quantityAvailable: 1 },
    { id: 'empty', location: '', quantityAvailable: 1 },
  ];
  const selected = inventoryRowsForLocation(rows, 'megaevoluzionietb1');
  assert.deepEqual(selected.map((row) => row.id), ['bare', 'stack', 'position', 'range']);
  // Legacy links containing a full slot still open the whole box.
  assert.deepEqual(inventoryRowsForLocation(rows, 'megaevoluzionietb1·2·3'), selected);
  const stacks = groupBoxStacks(selected, 'megaevoluzionietb1');
  assert.deepEqual(stacks.map((stack) => stack.stack), [2, 0]);
  assert.equal(stacks.reduce((sum, stack) => sum + stack.postingCount, 0), 4);
  assert.equal(stacks.reduce((sum, stack) => sum + stack.copies, 0), 7);
  assert.deepEqual(inventoryRowsForLocation(rows, 'missing'), []);
  assert.deepEqual(inventoryRowsForLocation(rows, ''), []);
  assert.deepEqual(inventoryRowsForLocation(null, 'megaevoluzionietb1'), []);
});

test('flat scan batch stays in one box group with eight postings and nine copies', () => {
  const rows = Array.from({ length: 8 }, (_, n) => ({
    id: String(n + 1), location: `megaevoluzionietb1·${n === 7 ? '8-9' : n + 1}`,
    quantityAvailable: n === 7 ? 2 : 1,
  }));
  const groups = groupBoxStacks(rows.reverse(), 'megaevoluzionietb1');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].stack, 0);
  assert.equal(groups[0].postingCount, 8);
  assert.equal(groups[0].copies, 9);
  assert.deepEqual(groups[0].postings.map(row => row.slotPosition), [1,2,3,4,5,6,7,8]);
  assert.equal(groups[0].postings[7].slotPositionText, '8-9');
});
