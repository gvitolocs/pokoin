// Scan desk price suggestions: the default listing price follows the row's
// facets (condition, language, reverse finish, 1st edition) from sold comps
// slices (`marketplace-card-sales?slices=1`), relaxing the condition first and
// then the language (English preferred) when a facet has no sold data, with
// the cheapest listed PKN as the floor. Spec: docs/SCAN_LISTING_WORKFLOW.md.

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
 * (nearest grade) → language (English first). Graded slices never apply.
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
    (s) => s.condition === condition,
    () => true,
  ];
  for (let i = 0; i < rungs.length; i += 1) {
    const hits = pool.filter(rungs[i]);
    if (!hits.length) continue;
    if (i === 2) {
      hits.sort((a, b) => (
        conditionDistance(a.condition, condition) - conditionDistance(b.condition, condition)
        || byFreshness(a, b)
      ));
    } else if (i >= 3) {
      hits.sort((a, b) => (
        (b.language === 'EN' ? 1 : 0) - (a.language === 'EN' ? 1 : 0)
        || byFreshness(a, b)
      ));
    } else {
      hits.sort(byFreshness);
    }
    return Number(hits[0].medianPkn);
  }
  return null;
}
