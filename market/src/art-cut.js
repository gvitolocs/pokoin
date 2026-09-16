/** Landscape illustration window on a leftover / homepage Pokemon scan.
 *
 * CSS crops the leftover JPEG — do not fetch a second art file.
 * Layout families were re-measured 14 Sep 2026 on leftover scans plus
 * Qwen3-VL outer bounds (VL includes the frame/name; SPA uses the inner
 * painting). Official commissioned art is 2.13×1.34 in on a 2.5×3.5 in
 * card (PTCG Illustration Contest) — that is the file under the frame,
 * not the visible window.
 *
 * Inner painting (fractions of leftover JPEG), then pixels on that scan:
 *   wotc   Base Alakazam 55574 1260×1760 → 166,310 927×486
 *   neo    SI Wartortle 127870 500×688  → 41,105 418×246
 *          Neo Ampharos 123587 600×825  → 49,125 502×295
 *   ecard  Expedition Alakazam 118548 500×688 → 66,105 374×208
 *   ex     EX Emerald Blaziken 115739 500×688 → 36,77 428×219
 *   dp     DP Dialga 113939 500×688 → 39,88 422×233
 *   modern SV Sprigatito 237709 749×1050 → 64,132 620×355
 *   bleed  Mega Feraligatr SIR 741824 660×920 → 32,118 597×569
 *          (album two-row tile only; suggest keeps the era window)
 * EX stops above the STAGE / Illus. overlay. Original WotC sits inside
 * the gold frame. Neo / Southern Islands EN use the larger Neo window
 * (English SI was reframed to Neo in 2001; JP SI keeps the large watercolor
 * box). Map: docs/CARD_ART.md.
 */
import { matchTcgEra } from './tcg-eras.js';
import { isLandscapePrintName } from './art-cut-landscape.js';
import { isFeatureAlbumArt, isItemAlbumCard, resolveArtLayout } from './art-layout.js';

export { isLandscapePrintName, isFeatureAlbumArt, resolveArtLayout, isItemAlbumCard };

export const ART_CUT_CARD_RATIO = 63 / 88;

/** Shared fallback / modern (BW → Mega) window. */
export const POKEMON_ART_CUT = {
  left: 0.086,
  top: 0.126,
  width: 0.828,
  height: 0.338,
  cardRatio: ART_CUT_CARD_RATIO,
};

export const ART_CUT_LAYOUTS = {
  wotc: {
    left: 0.132,
    top: 0.176,
    width: 0.736,
    height: 0.276,
    cardRatio: ART_CUT_CARD_RATIO,
  },
  neo: {
    left: 0.082,
    top: 0.152,
    width: 0.836,
    height: 0.358,
    cardRatio: ART_CUT_CARD_RATIO,
  },
  ecard: {
    left: 0.132,
    top: 0.152,
    width: 0.748,
    height: 0.302,
    cardRatio: ART_CUT_CARD_RATIO,
  },
  ex: {
    left: 0.072,
    top: 0.112,
    width: 0.856,
    height: 0.318,
    cardRatio: ART_CUT_CARD_RATIO,
  },
  dp: {
    left: 0.078,
    top: 0.128,
    width: 0.844,
    height: 0.338,
    cardRatio: ART_CUT_CARD_RATIO,
  },
  modern: POKEMON_ART_CUT,
};

/** Full-art / IR / SIR album painting. The .tile-tall box is two regular
 * album cells (+ gap). Full art still has a card edge and HP/attacks — those
 * are overlays on the painting, not an illustration window. Fit leftover
 * width and start near the top of the scan so the two-row cell fills with
 * the painting (no shade under the card). Attack names on the art stay. */
export const ART_CUT_BLEED = {
  left: 0.048,
  top: 0.028,
  width: 0.904,
  height: 0.618,
  cardRatio: ART_CUT_CARD_RATIO,
};

/** Amazing Rare half-art: illustration box above the attack sheet, not HP. */
export const ART_CUT_HALFART = {
  left: 0.07,
  top: 0.102,
  width: 0.86,
  height: 0.358,
  cardRatio: ART_CUT_CARD_RATIO,
};

const ERA_LAYOUT = {
  Original: 'wotc',
  Neo: 'neo',
  'Legendary Collection': 'wotc',
  'VS / web': 'wotc',
  'e-Card': 'ecard',
  EX: 'ex',
  'Diamond & Pearl': 'dp',
  Platinum: 'dp',
  'HeartGold & SoulSilver': 'dp',
  'Call of Legends': 'dp',
  'Black & White': 'modern',
  XY: 'modern',
  'Sun & Moon': 'modern',
  'Sword & Shield': 'modern',
  'Scarlet & Violet': 'modern',
  'Mega Evolution': 'modern',
  Other: 'modern',
};

export function artCutLayoutName(card) {
  const hay = `${card?.slug || ''} ${card?.set || card?.set_name || card?.expansion_name || ''}`;
  const era = matchTcgEra(hay) || 'Other';
  return ERA_LAYOUT[era] || 'modern';
}

export function artCutFor(card, surface) {
  const layout = resolveArtLayout(card);
  if (layout === 'halfart') {
    return ART_CUT_HALFART;
  }
  if (surface === 'album' && layout === 'bleed') {
    return ART_CUT_BLEED;
  }
  return ART_CUT_LAYOUTS[artCutLayoutName(card)] || POKEMON_ART_CUT;
}

export function artCutVars(card, surface) {
  const cut = artCutFor(card, surface);
  return {
    '--art-left': String(cut.left),
    '--art-top': String(cut.top),
    '--art-width': String(cut.width),
    '--art-height': String(cut.height),
    '--card-ratio': String(cut.cardRatio),
  };
}

export function artCutPixels(width, height, card, surface) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return null;
  }
  const cut = artCutFor(card, surface);
  const x = Math.round(cut.left * w);
  const y = Math.round(cut.top * h);
  return {
    x,
    y,
    width: Math.min(Math.round(cut.width * w), Math.max(0, Math.round(w) - x)),
    height: Math.min(Math.round(cut.height * h), Math.max(0, Math.round(h) - y)),
  };
}
