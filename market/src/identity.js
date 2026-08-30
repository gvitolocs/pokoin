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
  };
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
