import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alsoInLabels,
  confirmPickEntry,
  dropUnsentPicks,
  inventoryNote,
  lineCopies,
  lineSetText,
  locationTakeText,
  normalizeView,
  pickActionBody,
  rarityBadge,
  readLastPack,
  writeLastPack,
  csvField,
  dirtyPickEntries,
  dropPickEntry,
  effectivePick,
  foldText,
  groupLinesByGame,
  LEGACY_PICKED_KEY,
  lineDone,
  lineLocation,
  lineLocationFromPt,
  lineMatches,
  migrateLegacyPicks,
  PICK_CACHE_KEY,
  pickSaveBody,
  pickingOrdersMatch,
  readPickCache,
  reconcilePickCache,
  retryableSaveError,
  setPickEntry,
  sortByPtOrder,
  takeLegacyPicked,
  writePickCache,
  ZERO_CSV_COLUMNS,
  zeroGameLabel,
  zeroPickCsv,
} from './zero-pick.js';

const line = (itemId, position, extra = {}) => ({
  itemId,
  lineKey: String(itemId),
  quantity: 1,
  powerTools: position == null ? null : { position },
  ...extra,
});

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    data,
  };
}

test('a pack matches when our order is the Power Tools position order', () => {
  assert.deepEqual(pickingOrdersMatch([line('a', 1), line('b', 2), line('c', 3)]), {
    comparable: true,
    equal: true,
    mismatches: 0,
  });
  assert.equal(pickingOrdersMatch([line('a', 2), line('b', 1)]).equal, false);
  assert.equal(pickingOrdersMatch([line('a', 2), line('b', 1)]).mismatches, 2);
  assert.equal(pickingOrdersMatch([line('a', 1), line('b', null)]).comparable, false);
  assert.equal(pickingOrdersMatch([]).comparable, false);
});

test('pickingOrdersMatch compares distinct item ids as strings, split lines once', () => {
  const split = [
    line(501, 1, { lineKey: '501@9' }),
    line('502', 2),
    line('501', 1, { lineKey: '501@10' }),
    line(503, 3),
  ];
  assert.deepEqual(pickingOrdersMatch(split), { comparable: true, equal: true, mismatches: 0 });
  const swapped = [line(1, 1), line(3, 3), line(2, 2), line(4, 4)];
  assert.deepEqual(pickingOrdersMatch(swapped), { comparable: true, equal: false, mismatches: 2 });
});

test('Sort by PT order is stable and puts lines without a position last', () => {
  const lines = [line('x', null), line('a', 2), line('b', 1), line('c', 2), line('y', null)];
  assert.deepEqual(sortByPtOrder(lines).map((entry) => entry.itemId), ['b', 'a', 'c', 'x', 'y']);
});

test('groupLinesByGame keeps arrival order, places, and card counts', () => {
  const groups = groupLinesByGame([
    { itemId: 1, game: 'magic', quantity: 2 },
    { itemId: 2, game: 'pokemon', quantity: 1 },
    { itemId: 3, game: 'pokemon', quantity: 3 },
    { itemId: 4, game: '', quantity: 1 },
  ]);
  assert.deepEqual(groups.map((group) => [group.label, group.cards, group.lines.map((entry) => entry.place)]), [
    ['Magic', 2, [1]],
    ['Pokémon', 4, [2, 3]],
    ['Other', 1, [4]],
  ]);
  assert.equal(zeroGameLabel('yugioh'), 'Yu-Gi-Oh!');
  assert.equal(zeroGameLabel('one_piece'), 'One Piece');
  assert.equal(zeroGameLabel('mystery_game'), 'Mystery Game');
});

test('server value wins unless the cached entry is dirty', () => {
  const lines = [
    { itemId: 1, lineKey: '1@a', quantity: 3, picked: 2, issue: null },
    { itemId: 2, lineKey: '2', quantity: 1, picked: 0, issue: null },
  ];
  let cache = setPickEntry({}, lines[1], { picked: 1 });
  assert.deepEqual(cache['2'], { picked: 1, issue: null, dirty: true });
  assert.equal(effectivePick(lines[0], cache).picked, 2);
  assert.equal(effectivePick(lines[1], cache).picked, 1);
  assert.equal(lineDone(lines[1], cache), true);
  assert.deepEqual(dirtyPickEntries(cache), [{ lineKey: '2', picked: 1, issue: null }]);

  // A clean entry yields to fresh server data; a dirty one survives it.
  cache = { ...cache, '1@a': { picked: 0, issue: null, dirty: false }, gone: { picked: 1, dirty: true } };
  const reconciled = reconcilePickCache(cache, lines);
  assert.deepEqual(Object.keys(reconciled), ['2']);
  assert.equal(effectivePick(lines[0], reconciled).picked, 2);

  // Saved: the entry is clean; a newer local change keeps it dirty.
  const sent = { picked: 1, issue: null };
  assert.equal(confirmPickEntry(cache, '2', sent, { picked: 1, issue: null })['2'].dirty, false);
  const changed = setPickEntry(cache, lines[1], { picked: 0 });
  assert.equal(confirmPickEntry(changed, '2', sent, { picked: 1 })['2'].dirty, true);
});

test('picked is clamped to the line quantity and an issue line is not done', () => {
  const two = { itemId: 7, lineKey: '7', quantity: 2, picked: 0 };
  assert.equal(setPickEntry({}, two, { picked: 9 })['7'].picked, 2);
  assert.equal(setPickEntry({}, two, { picked: -1 })['7'].picked, 0);
  const issue = setPickEntry({}, two, { picked: 2, issue: { type: 'missing', note: 'x'.repeat(400) } });
  assert.equal(issue['7'].issue.note.length, 280);
  assert.equal(lineDone(two, issue), false);
  assert.equal(effectivePick(two, setPickEntry(issue, two, { issue: null })).issue, null);
});

test('legacy item-id ticks migrate once, only when the server has no picks', () => {
  const lines = [
    { itemId: 501, lineKey: '501@1', quantity: 3, picked: 0 },
    { itemId: 501, lineKey: '501@2', quantity: 2, picked: 0 },
    { itemId: 502, lineKey: '502', quantity: 1, picked: 0 },
  ];
  const migrated = migrateLegacyPicks(lines, ['501'], {});
  assert.deepEqual(migrated, {
    '501@1': { picked: 3, issue: null, dirty: true },
    '501@2': { picked: 2, issue: null, dirty: true },
  });
  const serverPicked = lines.map((entry, index) => (index === 2 ? { ...entry, picked: 1 } : entry));
  assert.deepEqual(migrateLegacyPicks(serverPicked, ['501'], {}), {});

  const storage = memoryStorage({ [`${LEGACY_PICKED_KEY}9`]: JSON.stringify([501, '502']) });
  assert.deepEqual(takeLegacyPicked(storage, '9'), ['501', '502']);
  assert.equal(storage.data.has(`${LEGACY_PICKED_KEY}9`), false);
  assert.equal(takeLegacyPicked(storage, '9'), null);
});

test('pick cache storage round-trips and tolerates junk', () => {
  const storage = memoryStorage({ [`${PICK_CACHE_KEY}bad`]: '[1,2]' });
  assert.deepEqual(readPickCache(storage, 'bad'), {});
  writePickCache(storage, '9', { a: { picked: 1, issue: null, dirty: true } });
  assert.deepEqual(readPickCache(storage, '9'), { a: { picked: 1, issue: null, dirty: true } });
  writePickCache(storage, '9', {});
  assert.equal(storage.data.has(`${PICK_CACHE_KEY}9`), false);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
  assert.deepEqual(readPickCache(broken, '9'), {});
  assert.doesNotThrow(() => writePickCache(broken, '9', { a: {} }));
});

test('search folds case and accents across name, English name, set, number, location', () => {
  assert.equal(foldText('Pokémon ÉX'), 'pokemon ex');
  const card = { name: 'Pikachu', nameEn: 'Pikachu', expansion: 'Pokémon Card 151', collectorNumber: '025/165', location: 'Box2·1' };
  assert.equal(lineMatches(card, 'POKEMON card'), true);
  assert.equal(lineMatches(card, '025/'), true);
  assert.equal(lineMatches(card, 'box2'), true);
  assert.equal(lineMatches({ name: 'ピカチュウ', nameEn: 'Pikachu' }, 'pika'), true);
  assert.equal(lineMatches(card, 'charizard'), false);
  assert.equal(lineMatches(card, '  '), false);
});

test('zeroPickCsv writes the Power Tools picking columns with RFC 4180 quoting', () => {
  const order = {
    items: [
      {
        itemId: 1, lineKey: '1', quantity: 3, picked: 1, game: 'riftbound', name: 'Vendetta, "Sharp"', nameEn: '',
        expansion: 'Origins', collectorNumber: '41', language: 'EN', condition: 'NM', lineCents: 1050,
        foil: true, signed: false, altered: true, location: 'box·2', powerTools: { bin: 'A3' },
      },
      { itemId: 2, lineKey: '2', quantity: 1, picked: 0, issue: { type: 'missing', note: '' }, game: '', name: 'Line\nbreak', lineCents: 5 },
    ],
  };
  const csv = zeroPickCsv(order, { 1: { picked: 3, issue: null, dirty: true } });
  const lines = csv.split('\r\n');
  assert.equal(lines[0], ZERO_CSV_COLUMNS.join(','));
  assert.equal(ZERO_CSV_COLUMNS.length, 21);
  assert.equal(
    lines[1],
    'PICKED,A3,3,Riftbound,41,,,Origins,"Vendetta, ""Sharp""","Vendetta, ""Sharp""",EN,NM,10.50,,Foil,false,true,,box·2,3,3/3',
  );
  assert.match(csv, /WITH ISSUE,,1,Other,,,,,"Line\nbreak","Line\nbreak",,,0\.05,,,false,false,missing,,1,0\/1/);
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a"b'), '"a""b"');
});

test('a line location falls back to the ranked Power Tools location, tagged PT', () => {
  const pokoin = { location: 'box2·1', locationSource: 'pokoin', sortLocation: 'box2·1', powerTools: { location: 'X' } };
  const pt = { location: '', locationSource: 'powertools', sortLocation: 'FUOCOBOMBA 001 - 2', powerTools: { location: 'FUOCOBOMBA 001 - 2' } };
  const none = { location: '', locationSource: '', sortLocation: '' };
  assert.equal(lineLocation(pokoin), 'box2·1');
  assert.equal(lineLocationFromPt(pokoin), false);
  assert.equal(lineLocation(pt), 'FUOCOBOMBA 001 - 2');
  assert.equal(lineLocationFromPt(pt), true);
  assert.equal(lineLocation({ sortLocation: 'DANDANDECK' }), 'DANDANDECK');
  assert.equal(lineLocation(none), '');
  assert.equal(lineLocationFromPt(none), false);
  // Older payloads without locationSource: only a Power Tools location is PT.
  assert.equal(lineLocationFromPt({ location: '', powerTools: { location: 'DANDANDECK' } }), true);
  assert.equal(lineLocation({ location: '', powerTools: { location: 'DANDANDECK' } }), 'DANDANDECK');
  assert.match(zeroPickCsv({ items: [{ ...pt, itemId: 1, lineKey: '1', quantity: 1 }] }), /,FUOCOBOMBA 001 - 2,1,0\/1/);
  assert.equal(lineMatches(pt, 'fuocobomba'), true);
});

test('save bodies always carry picked or issue; 4xx is final, network and 5xx retry', () => {
  const entry = { picked: 2, issue: { type: 'other', note: 'n' } };
  assert.deepEqual(pickSaveBody(9, 'k', entry, ['picked']), { orderId: '9', lineKey: 'k', picked: 2 });
  assert.deepEqual(pickSaveBody(9, 'k', entry, ['issue']), { orderId: '9', lineKey: 'k', issue: { type: 'other', note: 'n' } });
  assert.deepEqual(pickSaveBody(9, 'k', { picked: 0, issue: null }, []), { orderId: '9', lineKey: 'k', picked: 0 });
  assert.deepEqual(pickSaveBody(9, 'k', { picked: 1, issue: null }, ['picked', 'issue']), { orderId: '9', lineKey: 'k', picked: 1, issue: null });
  assert.equal(retryableSaveError(new Error('The network request failed.')), true);
  assert.equal(retryableSaveError({ status: 502 }), true);
  assert.equal(retryableSaveError({ status: 400 }), false);
  assert.equal(retryableSaveError({ status: 404 }), false);
  assert.deepEqual(dropPickEntry({ a: { picked: 1 }, b: { picked: 0 } }, 'a'), { b: { picked: 0 } });
});

test('views: PR A values migrate, images-vertical by default', () => {
  assert.equal(normalizeView('cards'), 'images-vertical');
  assert.equal(normalizeView('list'), 'list');
  assert.equal(normalizeView(null), 'images-vertical');
  assert.equal(normalizeView('single'), 'single');
  assert.equal(normalizeView('images-horizontal'), 'images-horizontal');
});

test('pick body: the copy picked, the copy the sale took, the whole line', () => {
  const line = { itemId: 7005, lineKey: '7005@L71', listingId: 'L71', quantity: 3 };
  assert.deepEqual(pickActionBody({ orderId: 9042 }, line), {
    orderId: '9042', itemId: '7005', lineKey: '7005@L71', listingId: 'L71', allocatedListingId: 'L71', quantity: 3, action: 'pick',
  });
  assert.equal(pickActionBody({ orderId: 1 }, line, 'pick', 'L99').listingId, 'L99');
  assert.equal(pickActionBody({ orderId: 1 }, line, 'pick', 'L99').allocatedListingId, 'L71');
  assert.equal(pickActionBody({ orderId: 1 }, line, 'undo').action, 'undo');
  assert.equal(pickActionBody({ orderId: 1 }, { itemId: 5 }).allocatedListingId, '');
});

test('other copies: candidates first, never the own listing, string alsoIn has no ids', () => {
  const line = {
    listingId: 'L22',
    alsoIn: ['binder·2·7'],
    candidates: [
      { listingId: 'L22', location: 'binder·1·4', quantityAvailable: 0 },
      { listingId: 'L23', location: 'binder·2·7', quantityAvailable: 2 },
      { listingId: 'L23', location: 'dup' },
    ],
  };
  assert.deepEqual(lineCopies(line), [{ listingId: 'L23', location: 'binder·2·7', quantityAvailable: 2 }]);
  assert.deepEqual(lineCopies({ listingId: 'L1', alsoIn: ['box·2'] }), []);
  assert.deepEqual(lineCopies({ listingId: 'L1', alsoIn: [{ listingId: 'L2', location: 'box·2' }] }), [{ listingId: 'L2', location: 'box·2', quantityAvailable: null }]);
  assert.deepEqual(alsoInLabels({ alsoIn: ['a', { location: 'b' }, ''] }), ['a', 'b']);
});

test('inventory notes', () => {
  assert.equal(inventoryNote({ inventory: 'removed', action: 'pick' }), 'removed from inventory');
  assert.equal(inventoryNote({ inventory: 'unchanged', action: 'pick' }), 'removed from inventory');
  assert.equal(inventoryNote({ inventory: 'swapped', listingId: 'L23' }, [{ listingId: 'L23', location: 'binder·2·7' }]), 'swapped with binder·2·7');
  assert.equal(inventoryNote({ inventory: 'restored', action: 'undo' }), 'back in inventory');
  assert.equal(inventoryNote(null), '');
});

test('tile text: set line, location with take and availability, rarity badge', () => {
  assert.equal(lineSetText({ collectorNumber: '208', expansionCode: '4ED', expansion: 'Fourth Edition' }), '# 208 - 4ED - Fourth Edition');
  assert.equal(lineSetText({ collectorNumber: '41', expansion: 'Origins' }), '# 41 - Origins');
  assert.equal(locationTakeText({ location: 'box·2', quantity: 2, quantityAvailable: 3 }), 'box·2: take 2 (3 available)');
  assert.equal(locationTakeText({ location: 'box·2', quantity: 1 }), 'box·2: take 1');
  assert.deepEqual(rarityBadge('Uncommon'), { short: 'U', long: 'Uncommon' });
  assert.deepEqual(rarityBadge('Special Illustration Rare'), { short: 'SIR', long: 'Special Illustration Rare' });
  assert.equal(rarityBadge('Double Rare').short, 'RR');
  assert.equal(rarityBadge(''), null);
});

test('offline cache never replays a pick: only unsaved issues survive', () => {
  const lines = [
    { lineKey: 'a', quantity: 1, picked: 0, issue: null },
    { lineKey: 'b', quantity: 1, picked: 0, issue: null },
  ];
  const cache = {
    a: { picked: 1, issue: null, dirty: true },
    b: { picked: 1, issue: { type: 'missing', note: '' }, dirty: true },
    gone: { picked: 1, issue: null, dirty: true },
  };
  assert.deepEqual(dropUnsentPicks(cache, lines), { b: { picked: 0, issue: { type: 'missing', note: '' }, dirty: true } });
});

test('the last pack is kept per seller for a week and never half-written', () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
  const pack = { weekly: [{ orderId: '1', items: [] }], fetchedAt: '2026-10-22T09:00:00.000Z' };
  assert.equal(writeLastPack(storage, 'u1', pack, 1000), true);
  assert.deepEqual(readLastPack(storage, 'u1', 2000), pack);
  assert.equal(readLastPack(storage, 'u2', 2000), null);
  assert.equal(readLastPack(storage, 'u1', 1000 + 8 * 86_400_000), null);
  assert.equal(readLastPack(null, 'u1'), null);
  const huge = { weekly: [{ items: ['x'.repeat(2_100_000)] }] };
  assert.equal(writeLastPack(storage, 'u1', huge, 3000), false);
  assert.equal(readLastPack(storage, 'u1', 3000), null, 'an oversized pack drops the old copy too');
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(readLastPack(broken, 'u1'), null);
  assert.equal(writeLastPack(broken, 'u1', pack), false);
});
