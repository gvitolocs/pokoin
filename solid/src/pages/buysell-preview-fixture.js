/**
 * Layout preview for BuySell: the card-page offer bar and /buysell.
 * Same switch as the MyPokoin desks (mypokoin-preview-fixture.js): the URL has
 * ?mypokoinPreview and the build is DEV or the host is localhost / 127.0.0.1.
 * Production hosts never take this path. Nothing here calls the API; offers
 * carry the site's own missing-card image and ids that match no catalog printing.
 *
 * `?mypokoinPreview=100` is the pile the row caps are proven against: the desk
 * takes that many fixture listings and that many fixture buy offers instead of
 * the card's real rows, so a cap is shown to hold against 100 and not only
 * against the eight-row sample.
 */
// The site's own missing-card scan (market/src/missing-card.js MISSING_CARD_SRC); no @market alias in node tests.
import { allowMypokoinPreview } from './mypokoin-preview-fixture.js';

const MISSING_CARD_SRC = '/home/missing-card.webp';

export const BUYSELL_PREVIEW_BANNER = 'Layout preview — fixture offers, nothing is saved or sent.';

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

function printing(n, cardName, setName, collectorNumber) {
  return {
    card_id: `preview-card-${n}`,
    card_name: cardName,
    card_image_url: MISSING_CARD_SRC,
    set_name: setName,
    collector_number: collectorNumber,
  };
}

const CARDS = [
  printing(1, 'Charizard', 'Base Set', '4/102'),
  printing(2, 'Pikachu', 'Base Set', '58/102'),
  printing(3, 'Mewtwo', 'Base Set', '10/102'),
  printing(4, 'Snorlax', 'Pokémon Card 151', '181/165'),
  printing(5, 'Psyduck', 'Pokémon Card 151', '175/165'),
  printing(6, 'Umbreon VMAX', 'Evolving Skies', '215/203'),
  printing(7, 'Gengar', 'Fossil', '5/62'),
  printing(8, 'Lugia', 'Neo Genesis', '9/111'),
];

function offer(id, card, fields) {
  return {
    id: `preview-offer-${id}`,
    ...CARDS[card],
    condition: 'NM',
    language: 'EN',
    reverse: false,
    first_edition: false,
    remaining: 1,
    expires_at: iso(30 * DAY_MS),
    created_at: iso(-id * 3600 * 1000),
    buyer_name: '',
    ...fields,
  };
}

const WANTED = [
  offer(1, 0, { price_pkn: 5200, remaining: 1, condition: 'SP', buyer_name: 'Mira', expires_at: iso(6 * DAY_MS) }),
  offer(2, 1, { price_pkn: 440, remaining: 3, buyer_name: 'Jonas', expires_at: null }),
  offer(3, 2, { price_pkn: 980, remaining: 1, condition: 'MP', first_edition: true, expires_at: iso(2 * DAY_MS) }),
  offer(4, 3, { price_pkn: 640, remaining: 2, language: 'JP', buyer_name: 'Aiko', expires_at: iso(28 * DAY_MS) }),
  offer(5, 4, { price_pkn: 270, remaining: 4, language: 'IT', expires_at: iso(11 * 3600 * 1000) }),
  offer(6, 5, { price_pkn: 3100, remaining: 1, reverse: true, buyer_name: 'Sofie', expires_at: iso(59 * DAY_MS) }),
  offer(7, 6, { price_pkn: 360, remaining: 2, condition: 'PL', buyer_name: 'Lars', expires_at: iso(14 * DAY_MS) }),
  offer(8, 7, { price_pkn: 1250, remaining: 1, language: 'DE', expires_at: null }),
];

/** The board, in the order the API returns it for `sort`. */
export function previewBoard(sort = 'recent') {
  const rows = sort === 'price'
    ? [...WANTED].sort((a, b) => b.price_pkn - a.price_pkn)
    : [...WANTED].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return { items: rows, next: null };
}

function mineOrder(id, card, fields) {
  return { ...offer(id, card, { quantity: 1, state: 'open', fills: [], ...fields }) };
}

/** The caller's offers: one open, one filled (with a fill), one expired, one cancelled. */
export function previewMine() {
  return {
    items: [
      mineOrder(11, 1, { price_pkn: 440, quantity: 3, remaining: 2, expires_at: iso(12 * DAY_MS), fills: [
        { listing_id: 'preview-listing-1', quantity: 1, price_pkn: 440, created_at: iso(-DAY_MS), listing_status: 'active' },
      ] }),
      mineOrder(12, 0, { price_pkn: 4800, quantity: 1, remaining: 0, state: 'filled', condition: 'SP', fills: [
        { listing_id: 'preview-listing-2', quantity: 1, price_pkn: 4800, created_at: iso(-3 * DAY_MS), listing_status: 'active' },
      ] }),
      mineOrder(13, 6, { price_pkn: 300, quantity: 2, remaining: 2, state: 'expired', condition: 'MP', expires_at: iso(-2 * DAY_MS) }),
      mineOrder(14, 7, { price_pkn: 1100, quantity: 1, remaining: 1, state: 'cancelled', language: 'DE' }),
    ],
  };
}

/** Open offers that match the caller's active listings. */
export function previewForMyListings() {
  return {
    items: [
      { ...WANTED[1], my_listing_id: 'preview-mine-1', my_price_pkn: 460 },
      { ...WANTED[4], my_listing_id: 'preview-mine-2', my_price_pkn: 290 },
    ],
  };
}

/**
 * The pile switch: `?mypokoinPreview=100` asks the desk for that many fixture
 * listings and buy offers. A bare switch, `=1` or `=true` keeps the eight-offer
 * sample, and a production host never gets either.
 */
export function previewScale(params) {
  if (!allowMypokoinPreview(params)) return 0;
  const raw = String(params?.mypokoinPreview ?? '').trim();
  if (!/^\d+$/.test(raw)) return 0;
  const rows = Number(raw);
  return rows >= 10 ? Math.min(200, rows) : 0;
}

const GRADES = ['NM', 'SP', 'MP', 'PL', 'Poor'];
const SPEECH = ['EN', 'JP', 'IT', 'DE', 'FR'];
const SHIPS = ['US', 'JP', 'IT', 'DE', 'FR'];
const SHOPS = [
  'RotationMotionTCG', 'redshakkio', 'CardCabinet', 'MiloVault', 'SuburbanCards',
  'GymRankTwo', 'BorderlineHP', 'SilverTuner', 'OldAmberTrade', 'RivalRetail',
];

/**
 * `count` Pokoin listings of the desk's card: sellers, grades, languages and
 * prices all vary, and the prices run high to low so the cell's three cheapest
 * are three different shops. Same row shape the live `/api/marketplace-listings`
 * answer sends.
 */
export function previewListings(count, cardId = '') {
  const card = CARDS[0];
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const shop = SHOPS[i % SHOPS.length];
    rows.push({
      id: `preview-listing-${i}`,
      sourceListingId: `preview:${i}`,
      cardId: cardId || card.card_id,
      cardName: card.card_name,
      cardImageUrl: card.card_image_url,
      setName: card.set_name,
      collectorNumber: card.collector_number,
      canonicalPath: `/marketplace/en/cards/${cardId || card.card_id}/preview-listing-${i}`,
      sellerUid: `preview-seller-${i % SHOPS.length}`,
      sellerName: shop,
      sellerUsername: shop.toLowerCase(),
      sellerDisplayName: shop,
      sellerCountry: SHIPS[i % SHIPS.length],
      sellerAcceptsPkn: i % 3 !== 0,
      condition: GRADES[i % GRADES.length],
      language: SPEECH[(i + 2) % SPEECH.length],
      reverse: i % 17 === 0,
      firstEdition: i % 23 === 0,
      graded: false,
      status: 'active',
      origin: 'pokoin',
      source: 'pokoin_web',
      quantityAvailable: 1 + (i % 4),
      pricePkn: 9400 - i * 87 - (i % 5) * 13,
      createdAt: iso(-i * 7 * 3600 * 1000),
      updatedAt: iso(-i * 3600 * 1000),
      photoUrls: [],
      sourceMetadata: {},
    });
  }
  return rows;
}

/**
 * `count` open offers for the desk's card, spread over every grade and language
 * the chips can pick. The book aggregates one row per facet, so the orders of
 * those rows add up to `count`: the cell shows three facets and counts every
 * offer behind them.
 */
function loadBook(count) {
  const facets = [];
  for (const language of SPEECH) {
    GRADES.forEach((condition, step) => facets.push({ language, condition, step }));
  }
  const each = Math.floor(count / facets.length);
  const book = facets.map((facet, index) => {
    const orders = index === facets.length - 1 ? count - each * (facets.length - 1) : each;
    return {
      condition: facet.condition,
      language: facet.language,
      reverse: false,
      first_edition: false,
      best_price_pkn: Math.max(20, 4300 - index * 31 - facet.step * 260),
      quantity: Math.max(1, orders),
      orders: Math.max(0, orders),
      best_order_id: `preview-offer-load-${index}`,
      best_remaining: 1,
    };
  });
  return { book };
}

/**
 * The book of one card in `language`: with `scale` the load-test pile instead,
 * whose offers sit in every facet the chips can pick.
 */
export function previewBook(language = 'EN', scale = 0) {
  if (scale > 0) return loadBook(scale);
  const lang = String(language || 'EN').toUpperCase();
  const row = (condition, price, quantity, orders, best) => ({
    condition,
    language: lang,
    reverse: false,
    first_edition: false,
    best_price_pkn: price,
    quantity,
    orders,
    ...best,
  });
  return {
    book: [
      row('NM', 4200, 5, 2, { best_order_id: 'preview-offer-21', best_remaining: 2 }),
      row('SP', 3600, 1, 1, {}),
      row('MP', 2900, 2, 1, {}),
    ],
  };
}
