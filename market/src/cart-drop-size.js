/** Thumb edge in px. One card nearly fills the panel; a full cart shrinks to fit. */
export function cartDropThumb(count) {
  const n = Math.max(1, Math.trunc(Number(count)) || 1);
  if (n === 1) return 152;
  if (n === 2) return 120;
  return Math.max(52, Math.min(112, Math.round(200 / Math.sqrt(n))));
}
