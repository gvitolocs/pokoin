const GENERIC_RARITY = /^(card|cards|single|singles|product|unknown|pokemon|pokémon)$/i;

/**
 * TCGPlayer-style printing identity.
 *
 * The page BFF often stores CardTrader `expansion_number` in `number`
 * ("Special Illustration Rare | 184/132") and puts the product type "Card"
 * in `rarity`. Split that here so the UI never shows "Card" as a rarity.
 */
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
      number = right;
      rarity = left;
    }
  }

  if (GENERIC_RARITY.test(rarity)) {
    rarity = '';
  }

  const set = String(card.set || card.set_name || '').trim();
  const artist = String(card.artist || card.illustrator || '').trim();

  return {
    set,
    number,
    rarity,
    artist,
    publicId: String(card.id || card.card_id || ''),
    subtitle: [rarity, number].filter(Boolean).join(' · '),
    tileLine: [rarity, number, set].filter(Boolean).join(' · '),
    suggestLine: [number, set].filter(Boolean).join(' · '),
    suggestTitle: number ? `${String(card.name || '').trim()} - ${number}` : String(card.name || '').trim(),
    suggestExpansion: set && collectorHash(number) ? `${set} #${collectorHash(number)}` : set,
  };
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

export function suggestKind(card = {}) {
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
  return 'Singles';
}

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
