/**
 * Localhost / dev layout preview for MyPokoin desks.
 * Active only when the URL has ?mypokoinPreview and the build is DEV
 * or the host is localhost / 127.0.0.1. Production hosts never take this path.
 * Card ids are catalog printings already used by account and dashboard fixtures
 * so leftover scans resolve without a signed-in session.
 */

export const MYPOKOIN_PREVIEW_BANNER = 'Layout preview — fixture data, not your live collection.';

export function allowMypokoinPreview(params) {
  if (!params || params.mypokoinPreview === undefined) return false;
  if (import.meta.env?.DEV) return true;
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

function printing(cardId, cardName, setName, collectorNumber, imageUrl) {
  return {
    cardId,
    cardName,
    setName,
    collectorNumber,
    expansion: setName,
    imageUrl,
    cardImageUrl: imageUrl,
  };
}

// Public ids from marketplace-suggest whose leftover scan (id / 2) is that printing.
// Homepage webps were checked: the six real scans return 200; Jigglypuff's id 404s.
const CARDS = [
  printing('222410', 'Pikachu', 'Base Set', '58/102', 'https://cdn.pokoin.com/111205_pikachu-58-102-base-set.jpg?v=bsu2'),
  printing('222302', 'Charizard', 'Base Set', '4/102', 'https://cdn.pokoin.com/111151_charizard-holo-rare-4-102-base-set.jpg?v=bsu2'),
  printing('222314', 'Mewtwo', 'Base Set', '10/102', 'https://cdn.pokoin.com/111157_mewtwo-rare-holo-10-102-base-set.jpg?v=bsu2'),
  printing('502874', 'Snorlax', 'Pokémon Card 151', '181/165', 'https://cdn.pokoin.com/251437_snorlax-181-165-pokemon-card-151.jpg'),
  printing('502862', 'Psyduck', 'Pokémon Card 151', '175/165', 'https://cdn.pokoin.com/251431_psyduck-175-165-pokemon-card-151.jpg'),
  printing('484062', 'Slowpoke', 'Scarlet & Violet', '204/198', 'https://cdn.pokoin.com/242031_slowpoke-204-198-scarlet-violet.jpg'),
  printing('900000001', 'Jigglypuff', 'Base Set', '54/102', ''),
];

function card(index) {
  return CARDS[index % CARDS.length];
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

const LISTINGS = [
  { id: 'preview-list-1', ...card(0), condition: 'NM', language: 'EN', quantityAvailable: 2, pricePkn: 420, status: 'active', location: 'box1·2', listedAt: '2026-10-02T00:00:00.000Z' },
  { id: 'preview-list-2', ...card(1), condition: 'SP', language: 'EN', quantityAvailable: 1, pricePkn: 1800, status: 'active', location: 'box1·4', listedAt: '2026-10-03T00:00:00.000Z' },
  { id: 'preview-list-3', ...card(2), condition: 'NM', language: 'JP', quantityAvailable: 1, pricePkn: 960, status: 'paused', location: '', listedAt: '2026-10-04T00:00:00.000Z' },
  { id: 'preview-list-4', ...card(3), condition: 'NM', language: 'EN', quantityAvailable: 2, pricePkn: 620, status: 'active', location: 'binder·1', listedAt: '2026-10-05T00:00:00.000Z' },
  { id: 'preview-list-5', ...card(4), condition: 'NM', language: 'IT', quantityAvailable: 1, pricePkn: 260, status: 'active', location: '', listedAt: '2026-10-06T00:00:00.000Z' },
  { id: 'preview-list-6', ...card(5), condition: 'MP', language: 'EN', quantityAvailable: 1, pricePkn: 170, status: 'active', location: 'box2·1', listedAt: '2026-10-07T00:00:00.000Z' },
  { id: 'preview-list-7', ...card(6), condition: 'NM', language: 'EN', quantityAvailable: 1, pricePkn: 80, status: 'active', location: '', listedAt: '2026-10-08T00:00:00.000Z' },
];

const HELD = [
  { id: 'preview-hold-1', ...card(1), condition: 'NM', language: 'EN', quantity: 1 },
  { id: 'preview-hold-2', ...card(4), condition: 'NM', language: 'EN', quantity: 1 },
  { id: 'preview-hold-3', ...card(5), condition: 'SP', language: 'JP', quantity: 2 },
  { id: 'preview-hold-4', ...card(2), condition: 'NM', language: 'EN', quantity: 1 },
];

const COLLECTION_LISTINGS = [
  {
    id: 'preview-col-list-1',
    ...card(0),
    condition: 'NM',
    language: 'EN',
    quantityAvailable: 1,
    pricePkn: 420,
    status: 'active',
  },
  {
    id: 'preview-col-list-2',
    ...card(3),
    condition: 'NM',
    language: 'EN',
    quantityAvailable: 1,
    pricePkn: 620,
    status: 'active',
  },
];

export function previewListings() {
  return copy(LISTINGS);
}

export function previewPricer() {
  return { defaultSource: 'cardtrader', autoMarketColumn: false };
}

export function previewStrategies() {
  return [{
    id: 'preview-strategy-1',
    name: 'Undercut CardTrader',
    source: 'cardtrader',
    action: 'undercut',
    amountPct: 5,
    amountPkn: 0,
    minPkn: 1,
    rounding: 'integer',
    condition: '',
    language: '',
    enabled: true,
  }];
}

export function previewCollection() {
  const rows = copy(HELD);
  const listings = copy(COLLECTION_LISTINGS);
  const asks = {};
  for (const row of rows) asks[row.id] = 250;
  return { rows, listings, asks };
}

// Already in the contract's picking order: Magic, Pokémon, Yu-Gi-Oh!, Riftbound, then other games;
// inside a game by box (natural), stacked lines before the bare box, unlocated lines last.
const ZERO_LINES = [
  { itemId: 7001, game: 'magic', name: 'Lightning Bolt', expansion: 'Magic 2010', expansionCode: 'M10', collectorNumber: '146', rarity: 'Common', location: 'binder·1·1', slot: { box: 'binder', stack: 1, position: 1 }, unitCents: 180, condition: 'NM', language: 'EN', picked: 1, pt: 1 },
  { itemId: 7002, listing: 'L22', game: 'magic', name: 'Fulmine', nameEn: 'Lightning Bolt', expansion: 'Fourth Edition', expansionCode: '4ED', collectorNumber: '208', rarity: 'Common', location: 'binder·1·4', slot: { box: 'binder', stack: 1, position: 4 }, unitCents: 250, condition: 'SP', language: 'IT', allocation: 'members', alsoIn: ['binder·2·7', 'binder·3·1'], candidates: [{ listingId: 'L22', location: 'binder·1·4', quantityAvailable: 0 }, { listingId: 'L23', location: 'binder·2·7', quantityAvailable: 2 }, { listingId: 'L24', location: 'binder·3·1', quantityAvailable: 1 }], available: 0, comment: 'Corner ding, priced as SP.', pt: 2 },
  { itemId: 7003, game: 'pokemon', card: 0, rarity: 'Common', location: 'box2·1', slot: { box: 'box2', stack: 1, position: null }, unitCents: 120, condition: 'NM', language: 'EN', firstEdition: true, pt: 3 },
  { itemId: 7004, game: 'pokemon', card: 1, rarity: 'Holo Rare', location: 'box10·1', slot: { box: 'box10', stack: 1, position: null }, unitCents: 18500, condition: 'MP', language: 'EN', pt: 5, mismatch: true },
  { itemId: 7011, game: 'pokemon', card: 5, rarity: 'Illustration Rare', location: '', locationSource: 'powertools', sortLocation: 'FUOCOBOMBA 001 - 2', slot: { box: 'FUOCOBOMBA 001', stack: 2, position: null }, unitCents: 760, condition: 'NM', language: 'EN', pt: 4, mismatch: true },
  { itemId: 7008, game: 'pokemon', card: 4, rarity: 'Illustration Rare', location: '', slot: null, unitCents: 900, condition: 'NM', language: 'JP', reverse: true, pt: 6, nameJa: 'コダック' },
  { itemId: 7006, game: 'yugioh', name: 'Blue-Eyes White Dragon', expansion: 'Legend of Blue Eyes', collectorNumber: 'LOB-001', rarity: 'Ultra Rare', location: 'ygo·3', slot: { box: 'ygo', stack: 3, position: null }, unitCents: 3200, condition: 'NM', language: 'EN', pt: 7, issue: { type: 'wrong_condition', note: 'Edge wear, looks SP.', at: '2026-10-22T08:15:00.000Z' } },
  { itemId: 7005, listing: 'L71', game: 'riftbound', name: 'Vendetta', expansion: 'Origins', collectorNumber: '41', rarity: 'Rare', location: 'megaevoluzionietb-41-20·2', slot: { box: 'megaevoluzionietb-41-20', stack: 2, position: null }, unitCents: 450, quantity: 3, itemQuantity: 5, allocation: 'event', picked: 1, foil: true, condition: 'NM', language: 'EN', pt: 8 },
  { itemId: 7005, listing: 'L72', game: 'riftbound', name: 'Vendetta', expansion: 'Origins', collectorNumber: '41', rarity: 'Rare', location: 'megaevoluzionietb-41-20·5', slot: { box: 'megaevoluzionietb-41-20', stack: 5, position: null }, unitCents: 450, quantity: 2, itemQuantity: 5, allocation: 'event', foil: true, condition: 'NM', language: 'EN', pt: 8 },
  { itemId: 7009, game: 'riftbound', name: 'Jinx, Loose Cannon', expansion: 'Origins', collectorNumber: '202', rarity: 'Epic', location: 'megaevoluzionietb-41-20', slot: { box: 'megaevoluzionietb-41-20', stack: null, position: null }, unitCents: 1290, condition: 'NM', language: 'EN', signed: true, pt: 9 },
  { itemId: 7010, game: 'one_piece', name: 'Monkey.D.Luffy', expansion: 'Romance Dawn', collectorNumber: 'OP01-024', rarity: 'Super Rare', location: 'op·1', slot: { box: 'op', stack: 1, position: null }, unitCents: 640, condition: 'NM', language: 'JP', altered: true, pt: 10 },
].map((line, index) => {
  const printing = line.card != null ? card(line.card) : null;
  const quantity = line.quantity || 1;
  return {
    itemId: line.itemId,
    lineKey: line.listing ? `${line.itemId}@${line.listing}` : String(line.itemId),
    ...(line.listing ? { listingId: line.listing } : {}),
    ...(line.expansionCode ? { expansionCode: line.expansionCode } : {}),
    ...(line.candidates ? { candidates: line.candidates } : {}),
    ...(line.available != null ? { quantityAvailable: line.available } : {}),
    ...(line.comment ? { comment: line.comment } : {}),
    quantity,
    itemQuantity: line.itemQuantity || quantity,
    game: line.game,
    cardId: printing?.cardId || '',
    name: line.nameJa || printing?.cardName || line.name,
    nameEn: line.nameEn || (line.nameJa ? printing.cardName : ''),
    rarity: line.rarity || '',
    expansion: printing?.expansion || line.expansion,
    collectorNumber: printing?.collectorNumber || line.collectorNumber,
    imageUrl: printing?.imageUrl || '',
    condition: line.condition,
    language: line.language,
    reverse: Boolean(line.reverse),
    foil: Boolean(line.foil),
    firstEdition: Boolean(line.firstEdition),
    signed: Boolean(line.signed),
    altered: Boolean(line.altered),
    graded: false,
    unitCents: line.unitCents,
    lineCents: line.unitCents * quantity,
    currency: 'EUR',
    location: line.location,
    locationSource: line.locationSource ?? (line.location ? 'pokoin' : ''),
    sortLocation: line.sortLocation ?? line.location,
    listedAt: line.location ? `2026-09-${String(10 + index).padStart(2, '0')}T09:00:00.000Z` : null,
    slot: line.slot,
    allocation: line.allocation || (line.location ? 'listing' : 'none'),
    alsoIn: line.alsoIn || [],
    picked: line.picked || 0,
    issue: line.issue || null,
    powerTools: {
      orderState: 'to pick',
      isCtZeroClosing: true,
      articleState: 'to_pick',
      pickedQuantity: line.picked || 0,
      location: line.sortLocation || line.location,
      bin: 'B7',
      position: line.pt,
      ptQuantity: line.itemQuantity || quantity,
      mismatch: Boolean(line.mismatch),
    },
  };
});

export function previewZero() {
  const items = copy(ZERO_LINES);
  const units = items.reduce((sum, item) => sum + item.quantity, 0);
  const cents = items.reduce((sum, item) => sum + item.lineCents, 0);
  return {
    oneDayReady: false,
    fetchedAt: '2026-10-22T09:41:00.000Z',
    sorting: {
      fields: ['game.asc', 'location.asc', 'none', 'none'],
      defaultFields: ['game.asc', 'location.asc', 'none', 'none'],
      smartLocations: true,
    },
    cardtrader: { username: 'preview-seller' },
    powerTools: {
      connected: true,
      ok: true,
      username: 'preview-seller',
      matchedOrders: 1,
      matchedItems: items.length,
      ptOrderCount: 1,
      picking: { ok: true, source: 'articlesToPick', error: null },
    },
    pending: { items: [], orderCount: 0 },
    totals: {
      weekly: { units, lines: items.length, cents },
      pending: { units: 0 },
    },
    weekly: [{
      orderId: '90421042',
      code: 'Z-1042',
      packingNumber: 12,
      paidAt: '2026-10-09T10:00:00.000Z',
      pickedLines: items.filter((item) => item.picked >= item.quantity).length,
      issueCount: items.filter((item) => item.issue).length,
      ptPicking: {
        listId: 'pt-preview',
        listName: 'Ct Zero closed',
        variant: 'ct_zero',
        ctZeroClosed: true,
        bin: 'B7',
        sortingFields: ['location'],
        comparable: true,
        mismatches: 2,
      },
      items,
    }],
  };
}

// Picked Zero copies (GET /api/cardtrader-zero-picked rows): they left the inventory.
const ZERO_PICKED = [
  { id: 41, card: 3, itemId: '6901', listingId: 'L61', kind: 'finalize', locationFrom: 'box3·2·4', unitCents: 1450, condition: 'NM', language: 'EN', pickedAt: '2026-10-21T17:42:00.000Z' },
  { id: 40, card: 1, itemId: '6902', listingId: 'L62', kind: 'swap', locationFrom: 'box1·1', unitCents: 18500, condition: 'MP', language: 'EN', pickedAt: '2026-10-21T17:40:00.000Z' },
  { id: 39, card: 4, itemId: '6903', listingId: 'L63', kind: 'finalize', locationFrom: 'jp-binder·4', unitCents: 900, condition: 'NM', language: 'JP', reverse: true, quantity: 2, pickedAt: '2026-10-21T17:31:00.000Z' },
  { id: 38, card: 0, itemId: '6904', listingId: 'L64', kind: 'finalize', locationFrom: 'box2·1', unitCents: 120, condition: 'NM', language: 'EN', firstEdition: true, pickedAt: '2026-10-14T16:05:00.000Z', orderId: '90420998', orderCode: 'Z-0998' },
];

export function previewZeroPicked() {
  return {
    rows: ZERO_PICKED.map((row) => {
      const printing = card(row.card);
      return {
        id: row.id,
        orderId: row.orderId || '90421042',
        orderCode: row.orderCode || 'Z-1042',
        itemId: row.itemId,
        lineKey: `${row.itemId}@${row.listingId}`,
        listingId: row.listingId,
        kind: row.kind,
        quantity: row.quantity || 1,
        locationFrom: row.locationFrom,
        cardId: printing.cardId,
        name: printing.cardName,
        expansion: printing.expansion,
        collectorNumber: printing.collectorNumber,
        condition: row.condition,
        language: row.language,
        reverse: Boolean(row.reverse),
        firstEdition: Boolean(row.firstEdition),
        imageUrl: printing.imageUrl,
        game: 'pokemon',
        unitCents: row.unitCents,
        currency: 'EUR',
        pickedAt: row.pickedAt,
      };
    }),
  };
}

export function previewSales() {
  return [
    {
      orderId: 'sale-preview-1',
      source: 'pokoin',
      paymentStatus: 'released',
      fulfillmentStatus: 'delivered',
      currency: 'PKN',
      gross: 620,
      refunded: 0,
      refundable: 0,
      soldAt: '2026-10-12T12:00:00.000Z',
      items: [{
        cardId: '502874',
        cardName: 'Snorlax',
        imageUrl: 'https://cdn.pokoin.com/251437_snorlax-181-165-pokemon-card-151.jpg',
        setName: 'Pokémon Card 151',
        collectorNumber: '181/165',
        quantity: 1,
        unitPricePkn: 620,
      }],
    },
    {
      orderId: 'sale-preview-2',
      source: 'cardtrader',
      channel: 'zero',
      paymentStatus: 'paid',
      currency: 'EUR',
      gross: 2400,
      refunded: 0,
      refundable: 0,
      soldAt: '2026-10-11T09:00:00.000Z',
      ctOrderCode: 'CT-88',
      items: [{
        cardId: '222302',
        cardName: 'Charizard',
        imageUrl: 'https://cdn.pokoin.com/111151_charizard-holo-rare-4-102-base-set.jpg?v=bsu2',
        setName: 'Base Set',
        collectorNumber: '4/102',
        quantity: 1,
        unitPriceEURCents: 2400,
      }],
    },
  ];
}

export function previewBought() {
  return [
    {
      id: 'buy-preview-1',
      paymentStatus: 'released',
      fulfillmentStatus: 'delivered',
      currency: 'PKN',
      totalPkn: 260,
      createdAt: '2026-10-01T12:00:00.000Z',
      uid: 'preview-buyer',
      sellerUids: [],
      items: [{
        cardId: '502862',
        cardName: 'Psyduck',
        imageUrl: 'https://cdn.pokoin.com/251431_psyduck-175-165-pokemon-card-151.jpg',
        setName: 'Pokémon Card 151',
        collectorNumber: '175/165',
        quantity: 1,
        card: { id: '502862', name: 'Psyduck' },
      }],
    },
    {
      id: 'buy-preview-2',
      paymentStatus: 'expired',
      currency: 'EUR',
      totalEURCents: 0,
      createdAt: '2026-09-20T12:00:00.000Z',
      uid: 'preview-buyer',
      sellerUids: [],
      items: [{
        cardId: '484062',
        cardName: 'Slowpoke',
        imageUrl: 'https://cdn.pokoin.com/242031_slowpoke-204-198-scarlet-violet.jpg',
        setName: 'Scarlet & Violet',
        collectorNumber: '204/198',
        quantity: 1,
        card: { id: '484062', name: 'Slowpoke' },
      }],
    },
  ];
}
