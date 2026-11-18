import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyEditedRow,
  cardFromInventoryRow,
  cardtraderLinked,
  editListingBody,
  identityFromInventoryRow,
  listingPresets,
  offerFromInventoryRow,
  pricingDryRunBody,
  pricingDryRunPrice,
  pricingGroupOf,
  pricingMenuEntries,
  pricingMenuLabel,
  pricingSavePlan,
  removeListingRow,
} from './listing-row-edit.js';

const CARRIED = [
  'altered', 'cardId', 'certificationId', 'condition', 'firstEdition', 'foilState', 'grade',
  'gradingCompany', 'id', 'language', 'location', 'photoUrls', 'pricePkn', 'quantityAvailable',
  'reverse', 'sealed', 'sellerComment', 'sellerUid', 'shippingAvailable', 'signed', 'source',
  'sourceListingId', 'status', 'graded',
].sort();

test('a board row becomes one camelCase offer, in either spelling', () => {
  const camel = {
    id: 'l-1',
    cardId: '222410',
    pricePkn: 420,
    quantityAvailable: 2,
    condition: 'NM',
    language: 'EN',
    foilState: 'reverse',
    reverse: true,
    firstEdition: false,
    signed: true,
    altered: false,
    sealed: false,
    graded: false,
    shippingAvailable: true,
    sellerComment: ' sharp edges ',
    location: 'box1·2',
    photoUrls: ['https://cdn/p1.jpg'],
    status: 'paused',
    sellerUid: 'u-1',
    sourceListingId: 'ct:44',
    source: 'cardtrader_seller_import',
  };
  assert.deepEqual(Object.keys(offerFromInventoryRow(camel)).sort(), CARRIED);
  const offer = offerFromInventoryRow(camel);
  assert.equal(offer.sellerComment, 'sharp edges', 'text is trimmed');
  assert.equal(offer.status, 'paused');

  // The stored book of the listing read keeps the server's snake_case.
  const snake = offerFromInventoryRow({
    listing_id: 'l-2',
    card_id: '222302',
    price_pkn: '1800',
    quantity_available: 1,
    condition: 'LP',
    language: 'JP',
    foil_state: 'holo',
    first_edition: true,
    grading_company: 'PSA',
    grade: '9',
    certification_id: '12345',
    shipping_available: false,
    seller_comment: 'JP first print',
    photo_urls: [],
    source_listing_id: 'cardtrader:7',
    seller_uid: 'u-2',
  });
  assert.equal(snake.id, 'l-2');
  assert.equal(snake.cardId, '222302');
  assert.equal(snake.pricePkn, 1800, 'a numeric string reads as a number');
  assert.equal(snake.quantityAvailable, 1);
  assert.equal(snake.foilState, 'holo');
  assert.equal(snake.firstEdition, true, 'snake 1st edition flag');
  assert.equal(snake.gradingCompany, 'PSA');
  assert.equal(snake.certificationId, '12345');
  assert.equal(snake.shippingAvailable, false);
  assert.equal(snake.sellerComment, 'JP first print');
  assert.equal(snake.sourceListingId, 'cardtrader:7');
  assert.equal(snake.sellerUid, 'u-2');
  assert.equal(snake.status, 'active', 'a row without a status is live');
  assert.equal(snake.signed, false, 'absent flags are false, not undefined');
  assert.deepEqual(snake.photoUrls, []);
});

test('the card and identity props come from the row alone', () => {
  const row = {
    card_id: '222410',
    card_name: 'Pikachu',
    card_image_url: 'https://cdn/pikachu.jpg',
    set_name: 'Base Set',
    collector_number: '58/102',
  };
  assert.deepEqual(cardFromInventoryRow(row), {
    id: '222410',
    name: 'Pikachu',
    imageUrl: 'https://cdn/pikachu.jpg',
    heroImageUrl: 'https://cdn/pikachu.jpg',
    set: 'Base Set',
  });
  assert.deepEqual(identityFromInventoryRow(row), { set: 'Base Set', number: '58/102' });
  // A row of only a name (an old book) still reads.
  assert.equal(cardFromInventoryRow({ name: 'Charizard' }).name, 'Charizard');
  assert.deepEqual(identityFromInventoryRow({}), { set: '', number: '' });
});

test('an edited row merges into the book; the others keep their objects', () => {
  const a = { id: 'l-1', pricePkn: 420, cardName: 'Pikachu', location: 'box1·2' };
  const b = { id: 'l-2', pricePkn: 1800 };
  const rows = [a, b];
  const next = applyEditedRow(rows, { id: 'l-1', pricePkn: 460, condition: 'NM' });
  assert.notEqual(next, rows, 'a new array, so the signal notifies');
  assert.equal(next[0].pricePkn, 460);
  assert.equal(next[0].condition, 'NM');
  assert.equal(next[0].cardName, 'Pikachu', 'fields the answer lacks stay');
  assert.equal(next[0].location, 'box1·2');
  assert.equal(next[1], b, 'an untouched row is the same object');

  // Unknown id, or an answer without one: nothing changes.
  assert.equal(applyEditedRow(rows, { id: 'l-9', pricePkn: 1 }), rows);
  assert.equal(applyEditedRow(rows, { pricePkn: 1 }), rows);
  assert.deepEqual(applyEditedRow(null, { id: 'l-1' }), [], 'no book loaded yet');
});

test('an unlist leaves the book', () => {
  const rows = [{ id: 'l-1' }, { id: 'l-2' }, { id: 'l-3' }];
  const next = removeListingRow(rows, 'l-2');
  assert.deepEqual(next.map((row) => row.id), ['l-1', 'l-3']);
  // Nothing to remove: the same array, so the board does not repaint.
  assert.equal(removeListingRow(rows, 'l-9'), rows);
  assert.equal(removeListingRow(rows, ''), rows);
});

test('a CardTrader link is the server’s product id rule', () => {
  assert.equal(cardtraderLinked({ sourceListingId: 'ct:44' }), true);
  assert.equal(cardtraderLinked({ source_listing_id: 'CARDTRADER:7' }), true);
  assert.equal(cardtraderLinked({ sourceListingId: ' ct:1234567890 ' }), true);
  assert.equal(cardtraderLinked({ sourceListingId: 'ct:' }), false, 'no digits');
  assert.equal(cardtraderLinked({ sourceListingId: 'ct:12a' }), false, 'not only digits');
  assert.equal(cardtraderLinked({ sourceListingId: 'scan:1' }), false);
  assert.equal(cardtraderLinked({ sourceListingId: 'pokoin:1' }), false);
  assert.equal(cardtraderLinked({}), false);
});

const row = { id: 'l-1', cardId: '222410', condition: 'NM', language: 'EN' };
const comp = (extra = {}) => ({
  [`${row.cardId}:NM:EN:`]: {
    ctMatchedPkn: 431,
    ctMatchedGrossPkn: 460,
    ctBasis: 'pro',
    pokoinCheapestPkn: 440,
    tcgplayer: [
      { marketPrice: 4.2, subtype: 'Standard', sourceTimestamp: '2026-11-07' },
      { marketPrice: 5.1, subtype: 'Holofoil', sourceTimestamp: '2026-11-07' },
    ],
    sources: {
      cardmarketoffers: {
        asOf: '2026-11-07',
        pro: { CLFE: { pkn: 400, offers: 3, countsComplete: true } },
        private: { CLFE: { pkn: 380, offers: 5, countsComplete: true } },
      },
    },
    ...extra,
  },
});

test('the editor presets are the four PKN markets in order, then TCGplayer', () => {
  const presets = listingPresets(comp(), row);
  assert.deepEqual(presets.map((preset) => preset.id), ['cardtrader', 'cardmarketpro', 'cardmarketprivate', 'pokoin', 'tcgplayer']);
  assert.deepEqual(presets.map((preset) => preset.label), ['CardTrader market', 'Cardmarket pro', 'Cardmarket private', 'Pokoin cheapest', 'TCGplayer']);
  assert.equal(presets[0].pkn, 431, 'CardTrader is the net');
  assert.match(presets[0].title, /Ask 460 PKN\./, 'the ask sits in the hover text');
  assert.equal(presets[1].pkn, 400);
  assert.equal(presets[2].pkn, 380);
  assert.equal(presets[3].pkn, 440);
  assert.equal(presets[3].title, 'Cheapest active Pokoin listing.');
  const tcg = presets[4];
  assert.equal(tcg.reference, true, 'TCGplayer is shown, never clicked');
  assert.equal(tcg.usdLow, 4.2);
  assert.equal(tcg.usdHigh, 5.1);
  assert.equal(tcg.pkn, undefined, 'no USD is converted to PKN');
});

test('a source without a value is no preset', () => {
  assert.deepEqual(listingPresets(comp({ pokoinCheapestPkn: null, tcgplayer: [] }), row)
    .map((preset) => preset.id), ['cardtrader', 'cardmarketpro', 'cardmarketprivate']);
  assert.deepEqual(listingPresets(comp({ ctMatchedPkn: 0, sources: {}, pokoinCheapestPkn: 0 }), row)
    .map((preset) => preset.id), ['tcgplayer'], 'only the USD reference is left, and it is not clickable');
  assert.deepEqual(listingPresets({}, row), [], 'no comp for this row');
  assert.deepEqual(listingPresets(null, row), []);
  assert.deepEqual(listingPresets(comp(), null), [], 'a row that is not there');
});

const form = {
  amount: 460,
  quantity: 2,
  condition: 'NM',
  language: 'EN',
  foil: 'reverse',
  flags: { firstEd: false, sealed: false, graded: false, shipping: true },
  comment: '  sharp edges  ',
  company: 'PSA',
  grade: '9',
  cert: '12345',
  location: 'box1·3',
  sendLocation: true,
  priceTyped: true,
  sellerUid: 'u-1',
};

test('an edit never restates the import, the catalogue or the options it does not show', () => {
  const imported = { id: 'l-1', status: 'active', pricePkn: 420, source: 'cardtrader_seller_import', sourceListingId: 'ct:44' };
  const body = editListingBody(form, imported);
  for (const forbidden of ['source', 'sourceListingId', 'cardName', 'cardImageUrl', 'setName', 'collectorNumber', 'reserveAvailable', 'nftAvailable', 'signed', 'altered']) {
    assert.equal(Object.hasOwn(body, forbidden), false, `${forbidden} is not the seller's to restate`);
  }
  assert.deepEqual(body, {
    condition: 'NM',
    language: 'EN',
    quantityAvailable: 2,
    foilState: 'reverse',
    reverse: true,
    firstEdition: false,
    sealed: false,
    graded: false,
    gradingCompany: null,
    grade: null,
    certificationId: null,
    shippingAvailable: true,
    sellerComment: 'sharp edges',
    status: 'active',
    pricePkn: 460,
    pricingGroupId: null,
    location: 'box1·3',
    sellerUid: 'u-1',
  });
});

test('the price goes only when the seller typed a new one', () => {
  const editing = { id: 'l-1', status: 'active', pricePkn: 420 };
  const fields = editListingBody({ ...form, priceTyped: false }, editing);
  assert.equal(Object.hasOwn(fields, 'pricePkn'), false);
  assert.equal(Object.hasOwn(fields, 'pricingGroupId'), false);
  // Typed the price it already has: nothing to send either.
  assert.equal(Object.hasOwn(editListingBody({ ...form, amount: 420 }, editing), 'pricePkn'), false);
  // The stored location is only resent when the server said where it is.
  assert.equal(Object.hasOwn(editListingBody({ ...form, sendLocation: false }, editing), 'location'), false);
});

test('a paused listing stays paused, a live one stays live', () => {
  assert.equal(editListingBody(form, { id: 'l-1', status: 'paused', pricePkn: 420 }).status, 'paused');
  assert.equal(editListingBody(form, { id: 'l-1', status: 'PAUSED ', pricePkn: 420 }).status, 'paused');
  assert.equal(editListingBody(form, { id: 'l-1', status: 'active', pricePkn: 420 }).status, 'active');
  assert.equal(editListingBody(form, { id: 'l-1', price_pkn: 420 }).status, 'active', 'no status read is live');
});

test('the Signed and Altered chips send their flag, nothing else does', () => {
  const editing = { id: 'l-1', status: 'active', pricePkn: 420 };
  const flags = { ...form.flags, signed: true, altered: true };
  const shown = editListingBody({ ...form, flags, showSigned: true, showAltered: true }, editing);
  assert.deepEqual({ signed: shown.signed, altered: shown.altered }, { signed: true, altered: true });
  assert.deepEqual(
    editListingBody({ ...form, flags: { ...flags, signed: false, altered: false }, showSigned: true, showAltered: true }, editing),
    { ...editListingBody(form, editing), signed: false, altered: false },
    'pressing the chip off clears the flag',
  );
  const hidden = editListingBody({ ...form, flags }, editing);
  assert.equal(Object.hasOwn(hidden, 'signed'), false, 'without the chip the stored flag survives');
  assert.equal(Object.hasOwn(hidden, 'altered'), false);
});

test('a graded edit carries company, grade and certification', () => {
  const body = editListingBody({ ...form, flags: { ...form.flags, graded: true, shipping: false } }, { id: 'l-1', pricePkn: 420 });
  assert.equal(body.graded, true);
  assert.equal(body.gradingCompany, 'PSA');
  assert.equal(body.grade, '9');
  assert.equal(body.certificationId, '12345');
  assert.equal(body.shippingAvailable, false);
  // Clearing the Graded chip blanks the slab fields, as the form always did.
  const bare = editListingBody({ ...form, flags: { ...form.flags, graded: false }, company: 'PSA', grade: '9' }, { id: 'l-1', pricePkn: 420 });
  assert.equal(bare.gradingCompany, null);
  assert.equal(bare.grade, null);
});

const STRATEGIES = [
  { id: 's1', name: 'Undercut 5%' },
  { id: 's2', name: 'Match CardTrader' },
];
const GROUPS = [
  { id: 'g1', name: 'Riftbound bulk', strategyId: 's1' },
  { id: 'g2', name: 'Bulk cheap', strategyId: 's2' },
];

test('the Pricing menu names what the listing follows now', () => {
  const inGroup = { memberships: new Map([['l-1', 'g1']]), groups: GROUPS, strategies: STRATEGIES, listingId: 'l-1' };
  assert.equal(pricingMenuLabel(inGroup), 'Group: Riftbound bulk · Undercut 5%');
  assert.equal(pricingGroupOf(inGroup.memberships, 'l-1'), 'g1');
  // Not a member of anything: the price is the seller's own.
  assert.equal(pricingMenuLabel({ ...inGroup, memberships: new Map() }), 'Custom price');
  assert.equal(pricingMenuLabel({ ...inGroup, memberships: [['l-2', 'g2']] }), 'Custom price');
  // The server's pairs and the store's Map say the same thing.
  assert.equal(pricingMenuLabel({ ...inGroup, memberships: [['l-1', 'g2']] }), 'Group: Bulk cheap · Match CardTrader');
});

test('the Pricing menu lists custom, the groups, the strategies, then new', () => {
  const kinds = pricingMenuEntries({ groups: GROUPS, strategies: STRATEGIES }).map((entry) => `${entry.kind}:${entry.id}`);
  assert.deepEqual(kinds, ['custom:', 'group:g1', 'group:g2', 'strategy:s1', 'strategy:s2', 'separator:', 'new:']);
  const entries = pricingMenuEntries({ groups: GROUPS, strategies: STRATEGIES });
  assert.equal(entries[0].label, 'Custom price');
  assert.equal(entries[1].label, 'Group Riftbound bulk · Undercut 5%');
  assert.equal(entries[4].label, 'Match CardTrader');
  assert.equal(entries[entries.length - 1].label, 'New strategy…');
  assert.deepEqual(pricingMenuEntries({}), [
    { kind: 'custom', id: '', label: 'Custom price' },
    { kind: 'separator', id: '', label: '' },
    { kind: 'new', id: '', label: 'New strategy…' },
  ]);
});

test('a picked group or strategy is dry-run for this listing alone', () => {
  assert.deepEqual(pricingDryRunBody({ kind: 'group', id: 'g1' }, GROUPS, 'l-1'), { strategyId: 's1', listingIds: ['l-1'], dryRun: true });
  assert.deepEqual(pricingDryRunBody({ kind: 'strategy', id: 's2' }, GROUPS, 'l-1'), { strategyId: 's2', listingIds: ['l-1'], dryRun: true });
  assert.equal(pricingDryRunBody({ kind: 'custom', id: '' }, GROUPS, 'l-1'), null);
  assert.equal(pricingDryRunBody({ kind: 'group', id: 'g1' }, [{ id: 'g1', name: 'No strategy' }], 'l-1'), null);
  assert.deepEqual(pricingDryRunPrice({ plan: [{ target: 610, current: 585 }] }, 585), 610);
  assert.equal(pricingDryRunPrice({ plan: [], unchanged: 1 }, 585), 585, 'already at the strategy price');
  assert.equal(pricingDryRunPrice({ plan: [], noComp: 1 }, 585), null, 'no market price for this card');
});

test('one save click patches first, then joins the group and prices', () => {
  assert.deepEqual(pricingSavePlan({ kind: 'custom', id: '' }, 'l-1'), [{ call: 'patch', priceInPatch: true }]);
  assert.deepEqual(pricingSavePlan({ kind: 'strategy', id: 's1' }, 'l-1'), [
    { call: 'patch', priceInPatch: false },
    { call: 'apply', body: { strategyId: 's1', listingIds: ['l-1'] } },
  ]);
  assert.deepEqual(pricingSavePlan({ kind: 'group', id: 'g1' }, 'l-1'), [
    { call: 'patch', priceInPatch: false },
    { call: 'saveGroup', body: { groupId: 'g1', add: ['l-1'] } },
    { call: 'apply', body: { groupId: 'g1', listingIds: ['l-1'] } },
  ]);
  // A row with no id cannot be priced: only the patch.
  assert.deepEqual(pricingSavePlan({ kind: 'group', id: 'g1' }, ''), [{ call: 'patch', priceInPatch: false }]);
});
