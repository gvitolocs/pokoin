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
    associate: associateRole
      ? { role: associateRole, displayName: String(associateRow.displayName || '').trim() }
      : (previous?.associate || null),
  };
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
