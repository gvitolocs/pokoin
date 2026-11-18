// Scan desk price suggestions: the default listing price follows the row's
// facets (condition, language, reverse finish, 1st edition) from sold comps
// slices (`marketplace-card-sales?slices=1`), relaxing the condition first and
// then language tiers (KO → JP → European → EN → other) when a facet has no sold data.
// The chain is sold comps → cheapest listed PKN → the €10,000 fallback below, so a
// scanned row always reaches the upload with a default price.
// Spec: docs/SCAN_LISTING_WORKFLOW.md.

import { pknFromPriceInput, priceInputFromPkn } from './seller-currency.js';
import { PKN_USDT_PRICE } from './pkn.js';

// Each array is one tier; an empty tier accepts all remaining languages.
export const PRICE_LANGUAGE_FALLBACK = [
  ['KO'],
  ['JP'],
  ['IT', 'FR', 'DE', 'ES', 'PT', 'NL', 'PL', 'RU'],
  ['EN'],
  [],
];

/** What a row defaults to when the printing has no sold comps and no listing. */
export const SCAN_FALLBACK_PRICE_EUR = 10000;

/**
 * The last rung of the chain, in PKN: nobody sells at €10,000 by accident, the
 * owner reprices later. EUR converts through the fixed 1 PKN = €0.005 parity;
 * the same parity is used directly when the converter yields nothing usable.
 */
export function scanFallbackPricePkn() {
  const pkn = Math.round(pknFromPriceInput(String(SCAN_FALLBACK_PRICE_EUR), 'EUR'));
  return Number.isFinite(pkn) && pkn > 0 ? pkn : Math.round(SCAN_FALLBACK_PRICE_EUR / PKN_USDT_PRICE);
}

export const SCAN_CONDITIONS = ['NM', 'SP', 'MP', 'PL', 'Poor'];

/** Identity of everything a suggestion depends on (version + facets). */
export function facetSignature(row = {}) {
  return [
    String(row.cardId ?? ''),
    row.condition || '',
    row.language || '',
    row.foilState ?? row.foil_state ?? '',
    (row.firstEdition ?? row.first_edition) ? '1' : '0',
  ].join(':');
}

export function scanFacets(row = {}) {
  return {
    condition: row.condition || '',
    language: String(row.language || '').toUpperCase(),
    reverse: (row.foilState ?? row.foil_state) === 'reverse',
    firstEdition: Boolean(row.firstEdition ?? row.first_edition),
  };
}

function byFreshness(a, b) {
  if (a.day !== b.day) return a.day > b.day ? -1 : 1;
  const sa = Number(a.sampleCount) || 0;
  const sb = Number(b.sampleCount) || 0;
  if (sa !== sb) return sb - sa;
  const la = Number(a.listings) || 0;
  const lb = Number(b.listings) || 0;
  if (la !== lb) return lb - la;
  return 0;
}

function conditionDistance(condition, want) {
  const i = SCAN_CONDITIONS.indexOf(condition);
  const j = SCAN_CONDITIONS.indexOf(want);
  if (i < 0 || j < 0) return SCAN_CONDITIONS.length;
  return Math.abs(i - j);
}

/**
 * Best sold-comps median for the facets, relaxing: finish/1st → condition
 * (nearest grade) → language (KO → JP → European → EN → other, skipping
 * the own language). Within each tier, nearest condition then freshness wins.
 * Graded slices never apply.
 * Returns the median PKN or null when the printing has no usable slices.
 */
export function suggestPriceFromSlices(slices, facets = {}) {
  const pool = (slices || []).filter((slice) => (
    slice && !slice.graded && Number(slice.medianPkn) > 0
  ));
  if (!pool.length) return null;
  const { condition, language, reverse, firstEdition } = facets;
  const rungs = [
    (s) => s.condition === condition && s.language === language
      && Boolean(s.reverse) === reverse && Boolean(s.firstEdition) === firstEdition,
    (s) => s.condition === condition && s.language === language,
    (s) => s.language === language,
    ...PRICE_LANGUAGE_FALLBACK.map((tier) => (s) => (
      s.language !== language && (!tier.length || tier.includes(s.language))
    )),
  ];
  for (let i = 0; i < rungs.length; i += 1) {
    const hits = pool.filter(rungs[i]);
    if (!hits.length) continue;
    hits.sort(i >= 2 ? (a, b) => (
      conditionDistance(a.condition, condition) - conditionDistance(b.condition, condition)
      || byFreshness(a, b)
    ) : byFreshness);
    return Number(hits[0].medianPkn);
  }
  return null;
}

/**
 * What leaving the desk price field does with its text. An emptied field
 * never saves "no price": it goes back to the suggested default.
 *   default → restore the suggested price
 *   restore → invalid text; show the saved price again
 *   keep    → same manual price, nothing to save
 *   set     → save pricePkn as a manual price
 */
export function priceFieldCommit(row = {}, raw = '', currency = 'PKN') {
  const value = String(raw ?? '').trim();
  if (value === '') return { action: 'default' };
  // Untouched text: a fiat cent can be coarser than 1 PKN, so never re-save it.
  if (!row.priceSuggested && value === priceInputFromPkn(row.pricePkn, currency)) return { action: 'keep' };
  // Sellers type their local currency; rows store PKN.
  const pricePkn = currency === 'PKN' ? Number(value) : pknFromPriceInput(value, currency);
  if (!Number.isFinite(pricePkn) || pricePkn <= 0) return { action: 'restore' };
  if (pricePkn === Number(row.pricePkn) && !row.priceSuggested) return { action: 'keep' };
  return { action: 'set', pricePkn };
}
