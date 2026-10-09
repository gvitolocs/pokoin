/**
 * The tile a user is about to open, handed to the card desk for its first
 * paint (React passed it as router `state={{ card }}`). Kept in memory, not
 * serialised into every anchor; bounded so a long session cannot grow it.
 */
const MAX = 64;
const cards = new Map();

export function handOffCard(card) {
  const id = String(card?.id || card?.card_id || '');
  if (!id) return;
  cards.delete(id);
  cards.set(id, card);
  if (cards.size > MAX) cards.delete(cards.keys().next().value);
}

export function peekHandoffCard(id) {
  return cards.get(String(id || '')) || null;
}
