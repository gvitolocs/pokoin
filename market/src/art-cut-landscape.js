/** HGSS LEGEND halves and XY BREAK cards are landscape prints stored as 63:88
 * with the name bar on the left of the JPEG. Suggest and artist albums rotate
 * +90deg (no art-cut). Match the English identity name only — not set titles
 * (Call of Legends, BREAKthrough) and not sealed products that mention a
 * BREAK card. */
export function isLandscapePrintName(name) {
  const text = String(name || '').replace(/\s+/g, ' ').trim();
  if (!text || /evolution box|combo deck|\bbooster\b|elite trainer/i.test(text)) {
    return false;
  }
  return /\b(?:legend|break)$/i.test(text);
}
