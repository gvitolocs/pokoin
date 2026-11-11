/**
 * Layout preview for BuySell: the card-page "Buy offers" tile and /buysell.
 * Same switch as the MyPokoin desks (mypokoin-preview-fixture.js): the URL has
 * ?mypokoinPreview and the build is DEV or the host is localhost / 127.0.0.1.
 * Production hosts never take this path. Nothing here calls the API; offers
 * carry the site's own missing-card image and ids that match no catalog printing.
 */
// The site's own missing-card scan (market/src/missing-card.js MISSING_CARD_SRC); no @market alias in node tests.
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
 * The book of one card in `language`: offers in three conditions. NM has two
 * offers and a best order whose remaining (2) is below the facet total (5).
 */
export function previewBook(language = 'EN') {
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
