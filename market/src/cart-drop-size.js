/** Thumb edge in px. One card nearly fills the panel; a full cart shrinks to fit.
 * Tuned so a 1-card cart (~200 → ~280px tall art) and Messages (~24.5rem) share
 * a typical desktop column with a small gap instead of overlapping or looking tiny.
 */
export function cartDropThumb(count) {
  const n = Math.max(1, Math.trunc(Number(count)) || 1);
  if (n === 1) return 200;
  if (n === 2) return 136;
  return Math.max(56, Math.min(128, Math.round(220 / Math.sqrt(n))));
}
