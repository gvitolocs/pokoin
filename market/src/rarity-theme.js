/**
 * Special rarity color, not the artist or the artwork.
 * Rainbow and gold are full treatments. Ghost is the Yu-Gi-Oh Ghost Rare only.
 * A Pokémon ghost emoji or Psychic type keeps the artwork delta.
 */

const GOLD = { kind: 'gold', shade: '#6e5210', raised: '#8a6818' };
const GHOST = { kind: 'ghost', shade: '#4c1d86', raised: '#6328a8' };
const RAINBOW = { kind: 'rainbow', shade: '', raised: '' };

function haystack(card) {
  return [
    card?.rarity,
    card?.number,
    card?.card_number,
    card?.cardType,
    card?.card_type,
    card?.emoji,
    card?.cardIdentityEmoji,
    card?.rarityVariantEmoji,
    card?.rarity_variant_emoji,
  ].map((part) => String(part || '')).join(' ').toLowerCase();
}

export function rarityRowTheme(card) {
  const text = haystack(card);
  if (!text.trim()) return null;
  if (/rainbow|hyper\s*rare/.test(text)) return RAINBOW;
  if (/\bgold\b/.test(text)) return GOLD;
  if (/\bghost\s+rare\b/.test(text)) return GHOST;
  return null;
}

/** Pokémon ghost/psychic marks are not the Yu-Gi-Oh Ghost Rare. */
export function prefersArtworkDelta(card) {
  if (rarityRowTheme(card)) return false;
  return /👻|\bghost\b|\bpsychic\b/.test(haystack(card));
}
