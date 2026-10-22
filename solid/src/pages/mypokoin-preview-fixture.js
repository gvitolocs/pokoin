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

const ZERO_LINES = [
  { itemId: 'z-1', quantity: 1, location: 'box1·2', condition: 'NM', language: 'EN', lineCents: 1200, currency: 'EUR' },
  { itemId: 'z-2', quantity: 2, location: 'box1·4', condition: 'NM', language: 'EN', lineCents: 2400, currency: 'EUR' },
  { itemId: 'z-3', quantity: 1, location: 'binder·1', condition: 'SP', language: 'IT', lineCents: 800, currency: 'EUR' },
  { itemId: 'z-4', quantity: 1, location: '', condition: 'NM', language: 'EN', lineCents: 450, currency: 'EUR' },
  { itemId: 'z-5', quantity: 2, location: 'box2·1', condition: 'NM', language: 'JP', lineCents: 1600, currency: 'EUR' },
  { itemId: 'z-6', quantity: 1, location: 'box2·3', condition: 'MP', language: 'EN', lineCents: 300, currency: 'EUR' },
  { itemId: 'z-7', quantity: 1, location: '', condition: 'NM', language: 'EN', lineCents: 900, currency: 'EUR' },
  { itemId: 'z-8', quantity: 1, location: 'box1·1', condition: 'NM', language: 'EN', lineCents: 700, currency: 'EUR' },
  { itemId: 'z-9', quantity: 2, location: 'binder·2', condition: 'NM', language: 'EN', lineCents: 1100, currency: 'EUR' },
  { itemId: 'z-10', quantity: 1, location: '', condition: 'SP', language: 'EN', lineCents: 500, currency: 'EUR' },
].map((line, index) => {
  const printing = card(index);
  return {
    ...line,
    cardId: printing.cardId,
    name: printing.cardName,
    expansion: printing.expansion,
    collectorNumber: printing.collectorNumber,
    imageUrl: printing.imageUrl || '',
    powerTools: { position: index + 1, bin: line.location ? 'A' : '', orderState: 'to pick' },
  };
});

export function seedPreviewPicked() {
  try {
    const key = 'pokoin.ctZero.picked.preview-zero';
    if (localStorage.getItem(key) == null) localStorage.setItem(key, JSON.stringify(['z-3', 'z-7']));
  } catch (_) { /* private mode */ }
}

export function previewZero() {
  const items = copy(ZERO_LINES);
  const units = items.reduce((sum, item) => sum + item.quantity, 0);
  const cents = items.reduce((sum, item) => sum + item.lineCents, 0);
  return {
    oneDayReady: false,
    cardtrader: { username: 'preview-seller' },
    powerTools: { ok: true },
    pending: { items: [], orderCount: 0 },
    totals: {
      weekly: { units, lines: items.length, cents },
      pending: { units: 0 },
    },
    weekly: [{
      orderId: 'preview-zero',
      code: 'Z-1042',
      packingNumber: 12,
      paidAt: '2026-10-09T10:00:00.000Z',
      items,
    }],
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
