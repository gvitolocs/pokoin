import { leftoverCdnId } from './card-id.js';

const GENERIC_RARITY = /^(card|cards|single|singles|product|unknown|pokemon|pokémon)$/i;
/** CardTrader `version` / leftover ct_id when the blueprint omitted n/m. */
const CATALOG_ID_NUMBER = /^\d{4,}$/;
const IMAGE_COLLECTOR = /(?:^|-)(\d{1,4}[A-Za-z]?)-(\d{2,4})(?:[-.]|$)/;
/** Printed n/m, TG27/TG30, SH10, AR1, SVP 214 — not “Holo Rare”. */
const LETTER_COLLECTOR = /^[A-Za-z]{1,5}\s*\d{1,4}[A-Za-z]?$/i;
const FRACTION_COLLECTOR = /(?:^|[A-Za-z])\d+[A-Za-z]?\s*\/\s*(?:[A-Za-z]*\d+)/;

export function isCollectorToken(text) {
  const value = String(text || '').trim();
  if (!value) {
    return false;
  }
  if (FRACTION_COLLECTOR.test(value) || /\d+\s*\/\s*\d+/.test(value)) {
    return true;
  }
  if (/^\d{1,4}[A-Za-z]?$/.test(value)) {
    return true;
  }
  return LETTER_COLLECTOR.test(value);
}

/**
 * TCGPlayer-style printing identity.
 *
 * The page BFF often stores CardTrader `expansion_number` in `number`
 * ("Special Illustration Rare | 184/132") and puts the product type "Card"
 * in `rarity`. Split that here so the UI never shows "Card" as a rarity.
 */
/** Western GX titles omit the Tag Team mechanic words Japanese CT added. */
export function sanitizeCardName(name) {
  return String(name || '')
    .replace(/\s*Tag Team GX\s*$/i, ' GX')
    .replace(/\s+/g, ' ')
    .trim();
}

export function displayName(card = {}) {
  return sanitizeCardName(card.name || '');
}

/** CardTrader search subtitle. Empty when the title language matches English. */
export function translatedName(card = {}, groupName = '') {
  const english = sanitizeCardName(groupName) || displayName(card);
  const localized = sanitizeCardName(card.localized_name || card.localizedName || '');
  if (localized && localized.toLowerCase() !== english.toLowerCase()) {
    return localized;
  }
  const printed = displayName(card);
  if (printed && printed.toLowerCase() !== english.toLowerCase()) {
    return printed;
  }
  return '';
}

/** English identity for a suggest row. Group name wins so a localized `card.name` cannot replace Cynthia with Camilla. */
export function suggestCardName(card = {}, groupName = '') {
  return sanitizeCardName(groupName) || displayName(card);
}

/** CardTrader second line: `Gible Di Camilla - 109/217`. */
export function suggestTranslatedLine(card = {}, groupName = '', number = '') {
  const translated = translatedName(card, groupName);
  if (!translated) {
    return '';
  }
  const num = String(number || '').trim();
  return num ? `${translated} - ${num}` : translated;
}

export function displaySet(card = {}) {
  return String(card.set || card.set_name || '').trim();
}

export function displayRarity(card = {}) {
  return String(card.rarity || '').trim();
}

export function printingIdentity(card = {}) {
  const rawNumber = String(
    card.number || card.card_number || card.expansion_number || '',
  ).trim();
  let rarity = String(card.rarity || '').trim();
  let number = rawNumber;

  const pipe = rawNumber.indexOf('|');
  if (pipe > 0) {
    const left = rawNumber.slice(0, pipe).trim();
    const right = rawNumber.slice(pipe + 1).trim();
    if (left && right) {
      const leftCollector = isCollectorToken(left);
      const rightHead = right.split('|')[0].trim();
      const rightCollector = isCollectorToken(rightHead);
      if (leftCollector && !rightCollector) {
        number = left;
        rarity = right;
      } else {
        number = right;
        rarity = left;
      }
    }
  }

  if (GENERIC_RARITY.test(rarity)) {
    rarity = '';
  }

  const publicId = String(card.id || card.card_id || '');
  number = dropCatalogIdNumber(number, publicId);
  if (looksLikeCatalogIdNumber(number) || !number) {
    const recovered = collectorFromImageUrl(
      card.gridImageUrl || card.cdn_image_url || card.imageUrl || card.image_url
      || card.heroImageUrl || card.homepageImageUrl || card.previewImageUrl,
    );
    if (recovered) {
      number = recovered;
    } else if (looksLikeCatalogIdNumber(number)) {
      number = '';
    }
  }

  const set = String(card.set || card.set_name || '').trim();
  const artist = String(card.artist || card.illustrator || '').trim();

  return {
    set,
    number,
    rarity,
    artist,
    publicId,
    subtitle: [rarity, number].filter(Boolean).join(' · '),
    tileLine: [rarity, number, set].filter(Boolean).join(' · '),
    suggestLine: [number, set].filter(Boolean).join(' · '),
    suggestTitle: number ? `${displayName(card)} - ${number}` : displayName(card),
    suggestExpansion: set,
    suggestExpansionShort: clipSuggestExpansion(set),
  };
}

export function looksLikeCatalogIdNumber(number) {
  return CATALOG_ID_NUMBER.test(String(number || '').replace(/^#+\s*/, '').trim());
}

/**
 * Printed n/m from a leftover / CardTrader filename basename.
 * Do not scan the full URL — `/image/114225/…` would read the directory id.
 */
export function collectorFromImageUrl(url) {
  const path = String(url || '').split(/[?#]/)[0];
  const base = path.split('/').pop() || '';
  const match = base.match(IMAGE_COLLECTOR);
  return match ? `${match[1]}/${match[2]}` : '';
}

/** Drop leftover ct_id / public id when the projection stored those as card_number. */
export function dropCatalogIdNumber(number, cardId) {
  const cleaned = String(number || '').replace(/^#+\s*/, '').trim();
  if (!cleaned) {
    return '';
  }
  const publicId = String(cardId || '').trim();
  if (publicId && cleaned === publicId) {
    return '';
  }
  const leftover = leftoverCdnId(publicId);
  if (leftover && cleaned === leftover) {
    return '';
  }
  if (looksLikeCatalogIdNumber(cleaned)) {
    return '';
  }
  return cleaned;
}

export function cardDocumentTitle(card = {}, seoTitle = '') {
  const identity = printingIdentity(card);
  const raw = String(seoTitle || '').trim();
  const catalogIds = [identity.publicId, leftoverCdnId(identity.publicId)].filter(Boolean);
  if (raw && !catalogIds.some((id) => raw.includes(id))) {
    return raw;
  }
  const parts = [displayName(card), identity.set, identity.number].filter(Boolean);
  return parts.length
    ? `${parts.join(' ')} Price & Cards for Sale | Pokoin`
    : 'Pokémon Cards for Sale | Pokoin';
}

/** Desktop suggest set line. Clip at 20 characters; do not reserve a 20ch gap. */
export const SUGGEST_EXPANSION_MAX = 20;
export const SUGGEST_COLLECTOR_MAX = 9;

export function clipSuggestExpansion(name) {
  const text = String(name || '').trim();
  if (text.length <= SUGGEST_EXPANSION_MAX) {
    return text;
  }
  return `${text.slice(0, SUGGEST_EXPANSION_MAX).trimEnd()}…`;
}

/** Search popup collector column only. Desk and tiles keep the full number. */
export function clipSuggestCollector(number) {
  const text = String(number || '').trim();
  if (text.length <= SUGGEST_COLLECTOR_MAX) {
    return text;
  }
  return text.slice(0, SUGGEST_COLLECTOR_MAX);
}

const SET_ABBREV_SKIP = /^(the|of|and|a|set|starter|mega|ex|collection|series)$/i;

/** 2–4 letter mark for the suggest set square. Fallback is the caller’s game glyph. */
export function setAbbrev(setName) {
  const words = String(setName || '')
    .split(/[\s/]+/)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, ''))
    .filter((word) => word && !SET_ABBREV_SKIP.test(word));
  if (!words.length) {
    return '';
  }
  if (words.length === 1) {
    return words[0].slice(0, 3).toUpperCase();
  }
  return words
    .map((word) => word[0])
    .join('')
    .slice(0, 4)
    .toUpperCase();
}

export function suggestKind(card = {}, groupName = '') {
  const blob = `${card.itemKind || ''} ${card.productType || ''} ${card.item_kind || ''} ${card.product_type || ''}`.toLowerCase();
  if (/box|sealed|booster/.test(blob)) {
    return 'Box set';
  }
  if (/memorabil/.test(blob)) {
    return 'Memorabilia';
  }
  if (/product/.test(blob) && !/card|single/.test(blob)) {
    return 'Product';
  }
  if (/\bjumbo\b/.test(blob)) {
    // product_type 'jumbo' (083): its own Pokémon product type, not a single.
    return 'Jumbo';
  }
  if (/single/.test(blob)) {
    return 'Singles';
  }
  const identity = printingIdentity(card);
  const name = String(card.name || groupName || '').trim();
  const nameHay = [
    groupName,
    card.name,
    name,
    identity.number,
    identity.rarity,
    card.number,
    card.card_number,
  ].filter(Boolean).join(' ');
  const setHay = `${identity.set} ${card.set || ''} ${card.set_name || ''}`;
  if (SEALED_EXPANSION.test(`${setHay} ${name} ${groupName}`)) {
    return 'Product';
  }
  // The API stamps single/card on every row with a genuine printed n/m
  // (normalizeMarketplaceRow). That data outranks the name heuristics below —
  // "Non-Holo Theme Deck | 58/145" is a real card, not sealed product. A bare
  // productType card without n/m still falls through to the SKU names.
  if (
    (card.productType === 'card' || card.product_type === 'card') &&
    PRINTED_FRACTION.test(nameHay)
  ) {
    return 'Singles';
  }
  if (SEALED_SKU.test(nameHay)) {
    return 'Product';
  }
  if (JUMBO_PRODUCT.test(nameHay)) {
    // "Jumbo Oversized | 211" and friends: the jumbo product type, detected by
    // name/number when a row predates the 083 product_type stamp.
    return 'Jumbo';
  }
  if (PRODUCT_NAME.test(nameHay) && !PRINTED_FRACTION.test(identity.number)) {
    return 'Product';
  }
  return 'Singles';
}

const PRINTED_FRACTION = /\d{1,4}[a-z]?\s*\/\s*\d{1,4}/i;
/** CardTrader sealed expansions (`Scarlet & Violet Products`). Ignore fake n/m. */
const SEALED_EXPANSION = /\bproducts?\b/i;
/** Sealed phrases CT files as cards. Ignore fake n/m so 001/001 cannot leak. */
const SEALED_SKU = /\b(?:theme decks?|league battle|battle decks?|dice sets?|elite trainer|pin collections?|ultra[- ]?premium collections?|build\s*(?:&|and)\s*battle)\b/i;
const PRODUCT_NAME = /\b(box(?:es)?|etb|elite trainer|tins?|bundle|collections?|pins?|coins?|boosters?|blister|displays?|sleeves?|decks?|playmat|posters?|binders?|calendars?|figures?|plush(?:es)?|erasers?|checklane|kits?|gift sets?|starter sets?|special sets?|build\s*(?:&|and)\s*battle|league battle|portfolios?|dice sets?|chests?|cases?|packs?|albums?|toolkits?|one-touch|ultra pro|constructed starter|high[- ]class|wcd\b|world championships?|case files?|premium files?|empty mini|glass(?:es)?|mugs?|tumblers?|keychains?|exclusives?)\b/i;
const JUMBO_PRODUCT = /\b(jumbo|oversized)\b/i;

function collectorHash(number) {
  const text = String(number || '').trim();
  if (!text) {
    return '';
  }
  return text.split('/')[0].trim();
}

/**
 * Vinted catalog search. Name alone matches every printing (Gumshoos → 500+).
 * Name + collector hash (`184` from `184/182`). Skip English set names and a
 * Pokemon prefix — Vinted ANDs tokens and Italian listings omit those.
 * OP/RB keep the game prefix so character names are not generic.
 */
export function vintedSearchText(card = {}, gameId = 'pokemon') {
  const row = typeof card === 'object' && card ? card : { name: card };
  const name = String(row.name || '').trim();
  if (!name) {
    return '';
  }
  const identity = printingIdentity(row);
  const number = collectorHash(identity.number);
  if (gameId === 'one_piece') {
    return ['One Piece Card Game', name, number].filter(Boolean).join(' ');
  }
  if (gameId === 'riftbound') {
    return ['Riftbound TCG', name, number].filter(Boolean).join(' ');
  }
  return [name, number].filter(Boolean).join(' ');
}

/** Vinted.it Hobby e collezionismo. Do not send search_id / time. */
const VINTED_IT_CATALOG = '4824';

export function vintedSearchUrl(card = {}, gameId = 'pokemon') {
  const query = vintedSearchText(card, gameId);
  const catalog = `catalog[]=${VINTED_IT_CATALOG}`;
  if (!query) {
    return `https://www.vinted.it/catalog?${catalog}`;
  }
  return `https://www.vinted.it/catalog?search_text=${encodeURIComponent(query)}&${catalog}`;
}

export function withPrintingIdentity(card = {}) {
  const identity = printingIdentity(card);
  return {
    ...card,
    number: identity.number,
    rarity: identity.rarity,
    artist: identity.artist || card.artist,
  };
}
