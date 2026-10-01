function emojiTokens(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), ({ segment }) => segment)
      .map((segment) => segment.trim())
      .filter(Boolean);
  }
  return Array.from(text.matchAll(/\p{Extended_Pictographic}\uFE0F?|\S/gu), (match) => match[0]);
}

function cardIdentityEmojisForCard(row = {}) {
  const structured = row.cardIdentityEmojis || row.card_identity_emojis;
  return Array.isArray(structured)
    ? structured.flatMap(emojiTokens)
    : emojiTokens(row.cardIdentityEmoji || row.card_identity_emoji);
}

function cardEmojiFields(row = {}) {
  const identity = cardIdentityEmojisForCard(row);
  const variant = emojiTokens(
    row.rarityVariantEmoji ||
      row.rarity_variant_emoji ||
      row.variantEmoji ||
      row.variant_emoji,
  )[0] || '';
  const emoji = String(row.emoji || '').trim();
  return {
    cardIdentityEmoji: identity.join(' '),
    card_identity_emoji: identity.join(' '),
    cardIdentityEmojis: identity,
    card_identity_emojis: identity,
    rarityVariantEmoji: variant,
    rarity_variant_emoji: variant,
    emoji,
  };
}

function withCardEmojiFields(row = {}) {
  return {
    ...row,
    ...cardEmojiFields(row),
  };
}

module.exports = {
  cardEmojiFields,
  withCardEmojiFields,
  cardIdentityEmojisForCard,
};
