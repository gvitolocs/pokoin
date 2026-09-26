/** Thumb edge in px. One card is large; a full cart shrinks so the cards still fit. */
export function cartDropThumb(count) {
  const n = Math.max(1, Math.trunc(Number(count)) || 1);
  return Math.max(36, Math.min(200, Math.round(200 / Math.sqrt(n))));
}
