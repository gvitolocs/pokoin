/** Thumb edge in px. One card nearly fills the panel; a full cart shrinks to fit. */
export function cartDropThumb(count) {
  const n = Math.max(1, Math.trunc(Number(count)) || 1);
  if (n === 1) return 248;
  if (n === 2) return 148;
  return Math.max(56, Math.min(160, Math.round(240 / Math.sqrt(n))));
}
