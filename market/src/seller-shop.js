import { safeAvatarUrl } from './avatar.js';
import { rewriteCanonicalCardPath } from './card-stub.js';
import { publicListingSellerName, sellerHandle } from './listing-meta.js';
import { sellerIdentitySeed } from './seller-seed.js';

/** Public seller shop (/marketplace/:lang/users/:username): filters and identity. */

export const SELLER_PAGE_SIZE = 100;

export const SELLER_CONDITION_FILTERS = [
  { value: '', label: 'Any condition' },
  { value: 'NM', label: 'Near Mint' },
  { value: 'SP', label: 'Slightly Played' },
  { value: 'MP', label: 'Moderately Played' },
  { value: 'PL', label: 'Played' },
  { value: 'Poor', label: 'Poor' },
];

export const SELLER_LANG_FILTERS = ['', 'EN', 'IT', 'JP', 'DE', 'FR', 'ES', 'KR', 'PT', 'NL', 'PL', 'RU', 'ZH'];

export const SELLER_RARITY_FILTERS = [
  { value: '', label: 'Any rarity' },
  { value: 'holo', label: 'Holo' },
  { value: 'common', label: 'Common' },
  { value: 'uncommon', label: 'Uncommon' },
  { value: 'rare', label: 'Rare' },
  { value: 'ultra', label: 'Ultra Rare' },
  { value: 'illustration', label: 'Illustration Rare' },
  { value: 'secret', label: 'Secret Rare' },
  { value: 'promo', label: 'Promo' },
  { value: 'no-rarity', label: 'No Rarity' },
];

export function isOneDayReady(offer) {
  return Boolean(
    offer?.oneDayReady ||
      offer?.one_day_ready ||
      offer?.shippingMode === 'one_day_ready',
  );
}

/** Any filter, a non-default sort or a later page: the first small page no longer answers. */
export function sellerFiltersNarrow({ query = '', condition = '', language = '', rarity = '', reverse = false, firstEdition = false, sort = 'price-desc', page = 1 } = {}) {
  return Boolean(
    String(query || '').trim()
    || condition
    || language
    || rarity
    || reverse
    || firstEdition
    || (sort && sort !== 'price-desc')
    || page > 1
  );
}

export function sellerFromPayload(data, handle, sample, previous = null) {
  const row = data?.seller && typeof data.seller === 'object' ? data.seller : null;
  const username = String(row?.username || sellerHandle(sample) || previous?.username || handle || '')
    .trim()
    .replace(/^@/, '');
  const rawName = String(row?.displayName || publicListingSellerName(sample, username || handle) || '')
    .trim();
  const known = sellerIdentitySeed(handle);
  const apiName = rawName && !rawName.includes('@') && rawName.toLowerCase() !== username.toLowerCase()
    ? rawName
    : '';
  // Book/fresh paths often send sellerUid with an empty photo and the
  // username as displayName — keep whatever the first page or chat already painted.
  const displayName = apiName || known?.displayName || previous?.displayName || username || handle;
  const associateRow = row?.associate && typeof row.associate === 'object' ? row.associate : null;
  const associateRole = String(associateRow?.role || '').trim().toLowerCase();
  return {
    uid: row?.uid || sample?.sellerUid || known?.uid || previous?.uid || '',
    username,
    displayName,
    photoUrl: safeAvatarUrl(row?.photoUrl) || known?.photoUrl || previous?.photoUrl || '',
    country: String(row?.country || '').trim().toUpperCase() || previous?.country || '',
    associate: associateRole
      ? { role: associateRole, displayName: String(associateRow.displayName || '').trim() }
      : (previous?.associate || null),
  };
}

/** How soon after painting a shop asks `fresh=1`, and the waits while a moved shop's new book is built. */
export const SELLER_FRESH_FIRST_MS = 1500;
export const SELLER_FRESH_RETRY_MS = [20_000, 40_000, 80_000, 160_000];

/**
 * What a painted book does with a `fresh=1` answer
 * (`{ maxUpdatedAt, book: { stamp, version } | null }`):
 * - 'current': the shop has not moved since this book;
 * - 'refetch': a newer book is stored, read it by its `book.version`;
 * - 'wait': the shop moved and its new book is still being built.
 */
export function sellerFreshAction(book, fresh) {
  const loaded = String(book?.maxUpdatedAt || '');
  const live = String(fresh?.maxUpdatedAt || '');
  if (!fresh || !live || live === loaded) return 'current';
  const stored = fresh.book;
  if (stored?.version && String(stored.stamp || '') !== loaded) return 'refetch';
  return 'wait';
}

/** Card stub + desk path a shop row links to (same shape the cart and drag payloads read). */
export function sellerOfferRow(offer, lang) {
  const cardId = String(offer.cardId || offer.card_id || '');
  const path = rewriteCanonicalCardPath(
    offer.canonicalPath || offer.canonical_path || '',
    cardId,
    lang,
  );
  const enriched = {
    ...offer,
    canonicalPath: path || offer.canonicalPath || '',
  };
  const cardStub = {
    id: cardId,
    name: offer.cardName || offer.name || 'Card',
    canonicalPath: path || `/marketplace/${lang || 'en'}/cards/${cardId}`,
    imageUrl: offer.cardImageUrl || offer.imageUrl || offer.image_url || '',
    homepageImageUrl: offer.homepageImageUrl || offer.homepage_image_url || '',
    gridImageUrl: offer.gridImageUrl || offer.grid_image_url || '',
  };
  return { cardId, enriched, cardStub };
}

/**
 * What the shop shows when the seller request fails. The API message stays off
 * the page: a missing username is "not found", and every other failure
 * (5xx, gateway, network) is a temporary outage.
 */
export function sellerShopErrorState(err) {
  if (Number(err?.status) === 404) {
    return {
      kind: 'not_found',
      title: 'Seller not found',
      lede: 'No Pokoin seller uses this username.',
    };
  }
  return {
    kind: 'unavailable',
    title: 'Shop unavailable',
    lede: 'This shop could not be loaded right now. Try again in a moment.',
  };
}

/**
 * Empty-shop copy. Narrowed filters keep the filter line. An unfiltered
 * Pokémon shop says there are no live asks. An unfiltered satellite shop names
 * the game (`gameName`, e.g. "One Piece").
 */
export function sellerShopEmptyCopy({ gameName = '', displayName = '', pokemon = false, narrowed = false } = {}) {
  const name = displayName || '';
  if (narrowed) {
    return { title: 'No listings', lede: `${name} has no live asks for these filters.` };
  }
  if (pokemon) {
    return { title: 'No listings', lede: `${name} has no live asks.` };
  }
  return {
    title: `No ${gameName} listings yet`,
    lede: `${name} has no ${gameName} listings yet.`,
  };
}
