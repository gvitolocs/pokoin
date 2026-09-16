/** Album / suggxst layout: framxd illustration window vs full-bleed art.
 *
 * Layout is per leftover: western OCR chrome text + leftover pixels.
 * CLIP `pokoin_version_sets` is the same painting, not the same frame.
 * Bare "Secret Rare" is not a layout (SM gold trainers stay window until
 * renamed Gold Secret). XY full-art EX secrets are `Secret Rare | n/m` with
 * n > m (BREAKthrough Mewtwo ex 163/162) — album bleed / two-row tiles.
 * Persist `art_layout` on the leftover (then the candidate); the SPA falls
 * back to SIR / Full Art / Hidden Fates trainer Shiny Vault (Lady SV86) /
 * MEP 037–063 / 101–127/M-P. Pokémon Shiny Rare — Paldean Fates n/m and
 * Hidden Fates / Shining Fates SV## — is a framed window.
 * Sword & Shield Amazing Rare is halfart (illustration box, one-row tile),
 * even when CardTrader named it Illustration Rare.
 * Pre-Black & White eras have no Full Art — album is always the era
 * illustration window even if geometry stored bleed (Neo Shining, Gold Star).
 * Prize Pack / League Promo *sets* are not a layout.
 * Regular GX and VMAX are full artwork (attacks on the painting) — album
 * bleed even when leftover_layouts still says window.
 * Item tiles are Spirit Link / Energy — not Potion, Doll, fossils, or stadiums.
 * Original / Base Set has no full-art leftover except Energy.
 * Fossil items (Antique Jaw Fossil) use the era illustration window.
 * Shiny Vault Pokémon SV## leftovers are windows; Lady SV86 trainer is bleed.
 * Terastal Eevee ex SVP 174–176 promos are full-art bleed.
 */
import { printingIdentity } from './identity.js';
import { isLandscapePrintName } from './art-cut-landscape.js';
import { isDollTrainerName, isFossilTrainerName, isRotomItemName, isTrainerItemName, pokedexNumber } from './pokedex.js';
import { matchTcgEra } from './tcg-eras.js';

export const ART_LAYOUTS = ['window', 'bleed', 'landscape', 'item', 'halfart'];

/** Rarity / collector line only — never the expansion title.
 * `illustration rare` / SIR, not PTCG Illustration Contest (framed window). */
export const BLEED_CATALOG_RE = /illustration\s*rare|full\s*art|full-art|fullart|\bart rare\b|special art|trainer gallery|galarian gallery|character rare|shiny vault|hyper rare|gold secret|rainbow rare|special illustration|\bsar\b|\bsir\b/i;
/** SM Alternate Art Promo (Sightseer 189a) keeps the illustration window — not FA bleed. */
export const ALTERNATE_ART_PROMO_WINDOW_RE = /alternate\s*art\s*promo/i;

/** XY-era Full Art EX often catalog as Ultra Rare n/m near set end (no Full-Art token). */
export function isUltraRareFaEx(name, number) {
  const nameS = String(name || "");
  if (!/\bex\b/i.test(nameS)) return false;
  const hay = String(number || "");
  if (!/ultra\s*rare/i.test(hay)) return false;
  const matches = [...hay.matchAll(/(\d+)\s*\/\s*(\d+)/g)];
  if (!matches.length) return false;
  const n = Number(matches.at(-1)[1]);
  const m = Number(matches.at(-1)[2]);
  if (!m) return false;
  if (n > m) return true;
  // Mega EX Ultra Rare in-set keeps the illustration window (M Mewtwo 159/162).
  if (/\bmega\b|^m\s+/i.test(nameS)) return false;
  return n >= Math.max(1, Math.floor(m * 0.85)) || m - n <= 12;
}


/** Hidden Fates / Shining Fates Shiny Vault trainer FA (Lady SV86).
 * Pokémon SV## Shiny Rare is a framed window — not this. */
export const SHINY_VAULT_RE = /shiny vault|shiny rare[\s\S]{0,48}sv\s*\d/i;

/** Framed shiny Pokémon (Paldean Fates n/m, Hidden Fates SV36, Radiant).
 * Not Shiny Ultra Rare full-art, not Lady SV86. */
const POKEMON_SHINY_RARE_RE = /shiny[\s-]*(holo\s*)?rare\b/i;

export const GALLERY_NUMBER_RE = /\btg\s*\d{1,3}\s*\/\s*tg\s*\d{1,3}\b/i;

/** Regular GX leftover: painting to the edges, attacks on the art. */
const GX_NAME_RE = /\bgx\b/i;
/** VMAX leftovers are only full artwork — never a framed illustration box. */
const VMAX_NAME_RE = /\bvmax\b/i;

function isIllustrationContestWindow(card) {
  return /illustration\s*contest/i.test(catalogHay(card));
}

/** Framed stamp leftovers (Professor Program). Pokémon IR stamps keep leftover layout. */
function isFramedStampWindow(card) {
  if (pokedexNumber(card) !== 0) {
    return false;
  }
  const hay = catalogHay(card);
  if (!/\bstamp\b/i.test(hay)) {
    return false;
  }
  if (/illustration\s*rare|special illustration|full\s*-?art|\bfullart\b|\bsir\b|\bsar\b|ultra\s*rare|secret\s*rare|gold secret|hyper rare/i.test(hay)) {
    return false;
  }
  return true;
}

/** SWSH/SV full-art supporters (Serena Secret Rare, Elesa Ultra Rare).
 * Bare Secret Rare is not enough: SM gold items stay window until Gold Secret;
 * BW/XY Secret Rare tools/items/stadiums (Rocky Helmet, ACE SPEC) stay window.
 * Ultra Rare trainers are FA (Elesa, Misty). Pokémon V / ex keep leftover/catalog. */
const ACE_SPEC_RE = /\b(?:rare\s*ace|ace\s*spec)\b/i;
/** Framed Item / Tool / Stadium still-lifes — never Secret Rare FA bleed. */
const FRAMED_TRAINER_STILL_LIFE = /\b(?:(?:super|hyper|max|full\s*heal)?\s*potion|antidote|awakening|(?:burn|ice|paralyze)\s*heal|revive|rare\s*candy|(?:poke|great|ultra|master|nest|net|dive|luxury|timer|quick|dusk|heal|heavy|level|love|lure|friend|moon|fast|sport|beast|dream|safari|premier)\s*ball|rocky\s*helmet|computer\s*search|escape\s*rope|enhanced\s*hammer|dowsing\s*machine|colress\s*machine|vs\s*seeker|switch|pokegear|bicycle|town\s*map|pokemon\s*catcher|super\s*rod|fishing\s*rod|energy\s*(?:search|retrieval|switch|recycler)|tool\s*scrapper|startling\s*megaphone|lucky\s*egg|exp\.?\s*share|float\s*stone|air\s*balloon|choice\s*band|choice\s*specs|assault\s*vest|weakness\s*policy|muscle\s*band|focus\s*sash|life\s*orb|black\s*belt|expert\s*belt|rocky\s*helmet|eviolite|leftovers|stadium|city\s*gym|gym)\b/i;

function isFramedTrainerStillLife(card) {
  const name = String(card?.name || card?.english_name || '').replace(/\s+/g, ' ').trim();
  if (!name) return false;
  if (isItemAlbumCard(card)) return false;
  if (isTrainerItemName(name)) return true;
  if (ACE_SPEC_RE.test(catalogHay(card))) return true;
  return FRAMED_TRAINER_STILL_LIFE.test(name);
}

function isTrainerFullArtBleed(card) {
  const name = String(card?.name || card?.english_name || '').trim();
  if (!name || pokedexNumber(card) !== 0) {
    return false;
  }
  if (isFramedTrainerStillLife(card)) {
    return false;
  }
  if (isIllustrationContestWindow(card) || isFramedStampWindow(card)) {
    return false;
  }
  const hay = catalogHay(card);
  if (ACE_SPEC_RE.test(hay)) {
    return false;
  }
  if (/\bultra\s*rare\b/i.test(hay) || /rainbow\s*(secret\s*)?rare/i.test(hay)) {
    return true;
  }
  if (/gold\s*secret/i.test(hay) || !/secret\s*rare/i.test(hay)) {
    return false;
  }
  const setHay = `${card?.slug || ''} ${card?.set || ''} ${card?.set_name || ''} ${card?.expansion_name || ''}`;
  const era = matchTcgEra(setHay);
  return era === 'Sword & Shield' || era === 'Scarlet & Violet';
}

function isStampExWindow(card) {
  const name = String(card?.name || card?.english_name || '');
  if (!/\bex\b/i.test(name) || GX_NAME_RE.test(name)) {
    return false;
  }
  return /\bstamp\b/i.test(catalogHay(card));
}

/** XY Full Art EX / Mega EX secrets (163/162). Not in-set ultras (159/162),
 * not Gold Secret Mega with a rule bar, not SM trainer secrets. */
function isExSecretBleed(card) {
  const name = String(card?.name || card?.english_name || '');
  if (!/\bex\b/i.test(name) || GX_NAME_RE.test(name)) {
    return false;
  }
  if (isStampExWindow(card) || isItemAlbumCard(card)) {
    return false;
  }
  const hay = catalogHay(card);
  if (/gold\s*secret/i.test(hay) || !/secret\s*rare/i.test(hay)) {
    return false;
  }
  const compact = compactCollector(hay);
  if (!compact) {
    return false;
  }
  const parts = compact.split('/').map(Number);
  return parts.length === 2 && parts[0] > parts[1];
}

/** First Partner Illustration Collection MEP 037–063. Not MEP 013 / 069. */
export const MEP_ILLUSTRATION_RE = /\bmep\s*0?(?:3[7-9]|4[0-9]|5[0-9]|6[0-3])\b/i;

/** JP First Partner 101/M-P–124/M-P and Paldea M-P 125–127. Not 019/M-P McDonald's. */
export const MP_ILLUSTRATION_RE = /\b1(?:0[1-9]|1[0-9]|2[0-4])\s*\/\s*m-p\b|\bm-p\s*12[5-7]\b/i;

function storedLayout(card) {
  const value = String(card?.artLayout || card?.art_layout || card?.layout || '')
    .trim()
    .toLowerCase();
  return ART_LAYOUTS.includes(value) ? value : '';
}

/** Sword & Shield Amazing Rare (half-art) leftovers. CardTrader named most
 * of these Illustration Rare, which is not a painting-to-edges IR. */
const AMAZING_RARE_COLLECTORS = {
  'vivid voltage': ['9/185', '50/185', '82/185', '102/185', '119/185', '138/185'],
  'shining fates': ['17/72', '21/72', '46/72'],
  'legendary heartbeat': ['9/76', '15/76', '33/76', '44/76', '50/76', '56/76'],
  'shiny star v': ['21/190', '36/190', '117/190'],
};

function compactCollector(number) {
  const matches = String(number || '').match(/\d+\s*\/\s*\d+/g);
  if (!matches?.length) {
    return '';
  }
  const last = matches[matches.length - 1].match(/(\d+)\s*\/\s*(\d+)/);
  return last ? `${Number(last[1])}/${Number(last[2])}` : '';
}

function amazingSetKey(set) {
  const hay = String(set || '').toLowerCase();
  if (/vivid voltage/.test(hay) && !/merch/.test(hay)) {
    return 'vivid voltage';
  }
  if (/shining fates/.test(hay) && !/shiny/.test(hay)) {
    return 'shining fates';
  }
  if (/legendary heartbeat/.test(hay)) {
    return 'legendary heartbeat';
  }
  if (/shiny star v/.test(hay)) {
    return 'shiny star v';
  }
  return '';
}


/** XY Ancient Trait half-arts (Ω/α/Δ/θ) — painting under the trait banner.
 * Album is full-art bleed / two-row, not the modern illustration window.
 * Collectors from western OCR trait text (expand as OCR catches more). */
export const ANCIENT_TRAIT_COLLECTORS = {
  'primal clash': new Set([
    '9/160', '24/160', '26/160', '60/160', '69/160', '81/160', '97/160', '121/160', '151/160',
  ]),
  'roaring skies': new Set(['32/108', '46/108', '74/108', '76/108', '105/108']),
  'xy black star promos': new Set([]), // STAFF / XY59 matched by OCR repair; SPA uses stored bleed
};

function ancientTraitSetKey(setName) {
  const hay = String(setName || '').toLowerCase();
  if (/primal clash/.test(hay)) return 'primal clash';
  if (/roaring skies/.test(hay) && !/promo/.test(hay)) return 'roaring skies';
  return '';
}


/** XY Black Star full-art legend promos (Latios XY79) — painting under HP/attacks.
 * Yellow era_border falsely stored window; album is bleed / two-row. */
const XY_FULLART_PROMO_RE = /\bxy\s*79\b/i;

/** SV Black Star Terastal Eevee ex promo trio (SVP 174–176): painting to the
 * edges under the Tera bar — full-art bleed even when leftover geometry
 * stored window. Framed SVP promos (Cosmos Holo, Illustration Contest,
 * stamps) are not in this cohort. */
export const SVP_FULLART_PROMO_RE = /\bsvp\s*17[4-6]\b/i;

export function isSvpFullArtPromoBleed(card) {
  return SVP_FULLART_PROMO_RE.test(catalogHay(card));
}

export function isXyFullArtPromoBleed(card) {
  return XY_FULLART_PROMO_RE.test(catalogHay(card));
}

export function isXyAncientTraitFullArt(card) {
  const name = String(card?.name || card?.english_name || '');
  if (!name) return false;
  const hay = catalogHay(card);
  // XY46 Altaria / XY59 Salamence Ancient Trait promos (CLIP often split from set print).
  if (/\bxy\s*46\b|\bxy\s*59\b/i.test(hay)) {
    return true;
  }
  const key = ancientTraitSetKey(card?.set || card?.set_name || card?.expansion_name || '');
  const collectors = ANCIENT_TRAIT_COLLECTORS[key];
  if (!collectors) return false;
  return collectors.has(compactCollector(hay));
}

export function isAmazingRare(card) {
  const hay = catalogHay(card);
  if (/\bamazing\s*rare\b/i.test(hay)) {
    return true;
  }
  const key = amazingSetKey(card?.set || card?.set_name || card?.expansion_name || '');
  const collectors = AMAZING_RARE_COLLECTORS[key];
  if (!collectors) {
    return false;
  }
  return collectors.includes(compactCollector(hay));
}

/** Pokémon Shiny Rare / Shiny Holo Rare: illustration box, HP, attacks.
 * Hidden Fates Diancie SV36 is this — not full-art bleed. Lady SV86 stays
 * bleed (no Pokédex). Shiny Ultra Rare full-arts do not match. */
export function isPokemonShinyRareWindow(card) {
  const name = String(card?.name || card?.english_name || '');
  if (GX_NAME_RE.test(name) || VMAX_NAME_RE.test(name)) {
    return false;
  }
  if (pokedexNumber(card) === 0) {
    return false;
  }
  return POKEMON_SHINY_RARE_RE.test(catalogHay(card));
}

function catalogHay(card) {
  const identity = printingIdentity(card || {});
  return [
    identity.rarity,
    identity.number,
    card?.rarity,
    card?.number,
    card?.card_number,
    card?.expansion_number,
  ].filter(Boolean).join(' ');
}

/** Full Art as a rarity starts in Black & White (2011). Earlier blocks
 * still have HP/attacks in a frame (Neo Shining, Gold Star, Crystal) —
 * album uses the era illustration window, not a two-row leftover.
 * Energy / Spirit Link stay `.tile-item`. Potion and Doll use the era window.
 * LEGEND / BREAK stay landscape. */
export const FULL_ART_ERAS = new Set([
  'Black & White',
  'XY',
  'Sun & Moon',
  'Sword & Shield',
  'Scarlet & Violet',
  'Mega Evolution',
]);

export function eraHasFullArt(card) {
  const hay = `${card?.slug || ''} ${card?.set || card?.set_name || card?.expansion_name || ''}`;
  const era = matchTcgEra(hay);
  if (!era) return true;
  return FULL_ART_ERAS.has(era);
}

/** Basic / special Energy leftover: energy symbol, not a painting window. */
const ENERGY_CARD_NAME = /\benergy$/i;

/** Spirit Link tools — XY still-life, not a Pokémon window. */
const SPIRIT_LINK_NAME = /\bspirit link$/i;

export function isItemAlbumCard(card) {
  const name = String(card?.name || card?.english_name || '').replace(/\s+/g, ' ').trim();
  if (!name) return false;
  if (isLandscapePrintName(name)) return false;
  if (isFossilTrainerName(name)) return false;
  if (isRotomItemName(name)) return false;
  if (isDollTrainerName(name)) return false;
  return SPIRIT_LINK_NAME.test(name) || ENERGY_CARD_NAME.test(name);
}

export function catalogArtLayout(card) {
  if (isLandscapePrintName(card?.name)) {
    return 'landscape';
  }
  if (isItemAlbumCard(card)) {
    return 'item';
  }
  if (ALTERNATE_ART_PROMO_WINDOW_RE.test(catalogHay(card))) {
    return 'window';
  }
  if (isXyFullArtPromoBleed(card) || isXyAncientTraitFullArt(card) || isSvpFullArtPromoBleed(card)) {
    return 'bleed';
  }
  if (isFramedTrainerStillLife(card)) {
    return 'window';
  }
  if (isAmazingRare(card)) {
    return 'halfart';
  }
  if (isIllustrationContestWindow(card) || isFramedStampWindow(card) || isStampExWindow(card)) {
    return 'window';
  }
  if (isTrainerFullArtBleed(card)) {
    return 'bleed';
  }
  if (!eraHasFullArt(card)) {
    return 'window';
  }
  if (GX_NAME_RE.test(String(card?.name || card?.english_name || ''))) {
    return 'bleed';
  }
  if (VMAX_NAME_RE.test(String(card?.name || card?.english_name || ''))) {
    return 'bleed';
  }
  if (isPokemonShinyRareWindow(card)) {
    return 'window';
  }
  if (isExSecretBleed(card)) {
    return 'bleed';
  }
  if (isUltraRareFaEx(card?.name || card?.english_name, catalogHay(card))) {
    return 'bleed';
  }
  const hay = catalogHay(card);
  if (
    BLEED_CATALOG_RE.test(hay)
    || SHINY_VAULT_RE.test(hay)
    || GALLERY_NUMBER_RE.test(hay)
    || MEP_ILLUSTRATION_RE.test(hay)
    || MP_ILLUSTRATION_RE.test(hay)
  ) {
    return 'bleed';
  }
  return 'window';
}

export function resolveArtLayout(card) {
  if (isItemAlbumCard(card)) {
    return 'item';
  }
  if (isLandscapePrintName(card?.name)) {
    return 'landscape';
  }
  if (ALTERNATE_ART_PROMO_WINDOW_RE.test(catalogHay(card))) {
    return 'window';
  }
  if (isXyFullArtPromoBleed(card) || isXyAncientTraitFullArt(card) || isSvpFullArtPromoBleed(card)) {
    return 'bleed';
  }
  if (isFramedTrainerStillLife(card)) {
    return 'window';
  }
  if (isAmazingRare(card)) {
    return 'halfart';
  }
  if (isIllustrationContestWindow(card) || isFramedStampWindow(card) || isStampExWindow(card)) {
    return 'window';
  }
  if (isTrainerFullArtBleed(card)) {
    return 'bleed';
  }
  if (!eraHasFullArt(card)) {
    return 'window';
  }
  if (GX_NAME_RE.test(String(card?.name || card?.english_name || ''))) {
    return 'bleed';
  }
  if (VMAX_NAME_RE.test(String(card?.name || card?.english_name || ''))) {
    return 'bleed';
  }
  if (isPokemonShinyRareWindow(card)) {
    return 'window';
  }
  if (isStampExWindow(card)) {
    return 'window';
  }
  if (isExSecretBleed(card)) {
    return 'bleed';
  }
  if (isUltraRareFaEx(card?.name || card?.english_name, catalogHay(card))) {
    return 'bleed';
  }
  const stored = storedLayout(card);
  if (stored === 'item') {
    return catalogArtLayout(card);
  }
  return stored || catalogArtLayout(card);
}

export function isFeatureAlbumArt(card) {
  const layout = resolveArtLayout(card);
  return layout === 'bleed' || layout === 'landscape' || layout === 'item';
}

export { isLandscapePrintName };
