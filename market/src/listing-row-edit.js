/**
 * MyPokoin inventory row actions: a board row in the shape the desk listing
 * form reads, what an edit or an unlist does to the seller's book, the market
 * presets the editor offers, and the PATCH body of an edit.
 * Pure — no framework, no network — so the rules are testable on their own.
 */

import { inventoryMarketValue } from './inventory-price.js';
import { editPriceFields } from './pricing-group-note.js';

/**
 * Board rows come from two places: an API answer (camelCase) or the stored
 * book of the listing read, which keeps whatever the server sent
 * (`price_pkn`, `set_name`, …). Read one field through both spellings.
 */
function field(row, camel, snake = camel.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`)) {
  const value = row?.[camel];
  return value === undefined || value === null ? row?.[snake] : value;
}

const text = (value) => String(value ?? '').trim();

function number(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One camelCase offer, as the listing form reads it (`listingFormFromOffer`).
 * `shippingAvailable` stays true unless the row says otherwise, like an offer.
 */
export function offerFromInventoryRow(row) {
  const photos = field(row, 'photoUrls', 'photo_urls');
  return {
    id: text(field(row, 'id') ?? field(row, 'listingId', 'listing_id')),
    cardId: text(field(row, 'cardId', 'card_id')),
    pricePkn: number(field(row, 'pricePkn', 'price_pkn')),
    quantityAvailable: number(field(row, 'quantityAvailable', 'quantity_available')),
    condition: text(field(row, 'condition')),
    language: text(field(row, 'language')),
    foilState: text(field(row, 'foilState', 'foil_state')),
    reverse: field(row, 'reverse') === true,
    firstEdition: field(row, 'firstEdition', 'first_edition') === true,
    signed: field(row, 'signed') === true,
    altered: field(row, 'altered') === true,
    sealed: field(row, 'sealed') === true,
    graded: field(row, 'graded') === true,
    gradingCompany: text(field(row, 'gradingCompany', 'grading_company')),
    grade: text(field(row, 'grade')),
    certificationId: text(field(row, 'certificationId', 'certification_id')),
    shippingAvailable: field(row, 'shippingAvailable', 'shipping_available') !== false,
    sellerComment: text(field(row, 'sellerComment', 'seller_comment')),
    location: text(field(row, 'location')),
    photoUrls: Array.isArray(photos) ? photos : [],
    status: text(field(row, 'status')) || 'active',
    sellerUid: text(field(row, 'sellerUid', 'seller_uid')),
    sourceListingId: text(field(row, 'sourceListingId', 'source_listing_id')),
    source: text(field(row, 'source')),
  };
}

/** The `card` prop the listing form needs: the row is all the desk has. */
export function cardFromInventoryRow(row) {
  const image = text(field(row, 'cardImageUrl', 'card_image_url'));
  return {
    id: text(field(row, 'cardId', 'card_id')),
    name: text(field(row, 'cardName', 'card_name')) || text(field(row, 'name')),
    imageUrl: image,
    heroImageUrl: image,
    set: text(field(row, 'setName', 'set_name')),
  };
}

/** The `identity` prop (set title + collector number) from the row. */
export function identityFromInventoryRow(row) {
  return {
    set: text(field(row, 'setName', 'set_name')),
    number: text(field(row, 'collectorNumber', 'collector_number')),
  };
}

/**
 * The answer of a listing edit merged into its row: the PATCH answers the
 * fields it touched, so the rest of the row (thumbnail, location, group)
 * stays. Untouched rows keep their objects, so the board keeps their nodes.
 */
export function applyEditedRow(rows, saved) {
  const list = Array.isArray(rows) ? rows : [];
  const id = text(saved?.id);
  if (!id) return list;
  let hit = false;
  const next = list.map((row) => {
    if (text(row?.id) !== id) return row;
    hit = true;
    return { ...row, ...saved };
  });
  return hit ? next : list;
}

/**
 * The row an unlist leaves behind: none. The book is built by
 * `loadOwnerBook` → `inventoryBooks.load`, whose page walk keeps only
 * `liveInventoryListings` rows (`isLiveInventoryListing`: status active or
 * paused with copies left). `cancelListing` sets status `inactive`, so the
 * server would drop the row on the next read and the book must not keep it
 * either; leaving it would show a listing that is no longer for sale.
 */
export function removeListingRow(rows, id) {
  const list = Array.isArray(rows) ? rows : [];
  const want = text(id);
  if (!want) return list;
  const next = list.filter((row) => text(row?.id) !== want);
  return next.length === list.length ? list : next;
}

/**
 * The listing is bound to a CardTrader product, by the server's own rule
 * (`sync_core::parse_ct_product_id`): the source listing id is `ct:<digits>`
 * or `cardtrader:<digits>`. A Card Rails key alone is not a product id.
 */
export function cardtraderLinked(row) {
  const raw = text(field(row, 'sourceListingId', 'source_listing_id')).toLowerCase();
  return /^(?:ct|cardtrader):\d+$/.test(raw);
}

/** The clickable presets, in the order the editor lists them. */
const PRESET_SOURCES = [
  ['cardtrader', 'CardTrader market'],
  ['cardmarketpro', 'Cardmarket pro'],
  ['cardmarketprivate', 'Cardmarket private'],
  ['pokoin', 'Pokoin cheapest'],
];

/** The ask beside the CardTrader net belongs in the hover text. */
function presetTitle(value) {
  const title = String(value.title || '');
  if (!value.askLabel || /\bask\b/i.test(title)) return title;
  return `${title} Ask ${value.askLabel}.`.trim();
}

/**
 * Market prices the editor offers for one row, from a price-check `prices`
 * map (the per-game answer, keyed as `priceCheckKey`). Sources without a
 * value are left out; TCGplayer stays a reference, never a preset, because
 * its quotes are USD and nothing here converts USD to PKN.
 */
export function listingPresets(prices, row) {
  const map = prices && typeof prices === 'object' ? prices : {};
  const presets = [];
  for (const [id, label] of PRESET_SOURCES) {
    const value = inventoryMarketValue(map, row, id);
    if (!value) continue;
    presets.push({ id, label, pkn: value.value, title: presetTitle(value) });
  }
  const tcg = inventoryMarketValue(map, row, 'tcgplayer');
  if (tcg) {
    presets.push({
      id: 'tcgplayer',
      label: 'TCGplayer',
      usdLow: tcg.low,
      usdHigh: tcg.high,
      title: tcg.title,
      reference: true,
    });
  }
  return presets;
}

/**
 * The PATCH body of a listing edit, as `updateListing` wants it.
 *
 * An edit sends only what the form actually shows, and never the fields that
 * are not the seller's to restate: not `source` (a CardTrader import would
 * lose its origin), not `sourceListingId` (the product binding), not the
 * catalogue copy (`cardName`, `cardImageUrl`, `setName`, `collectorNumber`),
 * not `reserveAvailable` / `nftAvailable` (options this form has). `signed`
 * and `altered` go only when their chip is on screen, else an edit would
 * clear a flag the seller set elsewhere. The price follows `editPriceFields`
 * (only a typed price, which also takes the listing out of its group), and a
 * paused listing stays paused: un-pausing is the seller's press, not a
 * side effect of saving a comment.
 */
export function editListingBody(form = {}, editing = null) {
  const flags = form.flags || {};
  const graded = flags.graded === true;
  const body = {
    condition: form.condition,
    language: form.language,
    quantityAvailable: form.quantity,
    foilState: form.foil,
    reverse: form.foil === 'reverse',
    firstEdition: flags.firstEd === true,
    sealed: flags.sealed === true,
    graded,
    gradingCompany: graded ? text(form.company) : null,
    grade: graded ? text(form.grade) : null,
    certificationId: graded ? text(form.cert) : null,
    shippingAvailable: flags.shipping !== false,
    sellerComment: text(form.comment),
    status: text(field(editing, 'status')).toLowerCase() === 'paused' ? 'paused' : 'active',
    ...editPriceFields(form.amount, field(editing, 'pricePkn', 'price_pkn'), form.priceTyped === true),
  };
  if (form.sendLocation) body.location = form.location || '';
  if (form.showSigned) body.signed = flags.signed === true;
  if (form.showAltered) body.altered = flags.altered === true;
  if (form.sellerUid) body.sellerUid = form.sellerUid;
  return body;
}
