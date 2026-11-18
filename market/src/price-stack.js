/**
 * Line order of a two-line buyer price. `{ local, pkn }` parts normally stack the local
 * amount small on top and the PKN amount large below. The Best Deal panel flips that:
 * the local currency is the large figure and PKN the small line above it. A single
 * price (only one of the two present) has no order to flip.
 * Returns [small, large] as part names, or null when the parts are not a pair.
 */
export function stackOrder(parts, flip = false) {
  if (!parts?.local || !parts?.pkn) return null;
  return flip ? ['pkn', 'local'] : ['local', 'pkn'];
}
