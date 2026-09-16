/** Groups for the /ocr leftover language board. American sits with western. */

export const EXPANSION_LANG_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'junk', label: 'Junk' },
  { id: 'disagree', label: 'Disagree' },
  { id: 'western', label: 'Western' },
  { id: 'japanese', label: 'Japanese' },
  { id: 'korean', label: 'Korean' },
  { id: 'chinese', label: 'Chinese' },
  { id: 'other', label: 'Other' },
];

const EXCLUSIVE = new Set([
  'indonesian', 'thai', 'idth', 'french', 'german', 'american', 'product',
]);

export function englishOcrIsJunk(text) {
  const blob = String(text || '');
  if (!blob.trim()) {
    return true;
  }
  const strong = blob.match(
    /\b(weakness|resistance|retreat|illus|evolves?|ability|supporter|knocked out|mega evolution|poke-body|poke-power)\b/gi,
  ) || [];
  const yours = blob.match(/\byour (deck|hand|bench|opponent)\b/gi) || [];
  const weak = blob.match(/\b(pokemon|pokémon|attack|damage|prize|trainer|stage)\b/gi) || [];
  return (strong.length * 2 + yours.length * 2 + weak.length) < 3;
}

export function qwenPrintToNationality(print) {
  const value = String(print || '').trim().toLowerCase();
  if (value === 'english') {
    return 'western';
  }
  if (value === 'japanese' || value === 'chinese' || value === 'korean') {
    return value;
  }
  return '';
}

export function qwenAgrees(nationality, print) {
  const db = String(nationality || '').trim().toLowerCase();
  const mapped = qwenPrintToNationality(print);
  if (!mapped) {
    return true;
  }
  if (mapped === 'western') {
    return db === 'western' || db === 'american';
  }
  return db === mapped;
}

export function shouldApplyQwenNationality(nationality, print, ocrJunk = true) {
  if (!ocrJunk) {
    return false;
  }
  const db = String(nationality || '').trim().toLowerCase();
  if (EXCLUSIVE.has(db)) {
    return false;
  }
  const next = qwenPrintToNationality(print);
  return next === 'japanese' || next === 'chinese' || next === 'korean'
    ? db !== next
    : false;
}

export function expansionLangGroup(nationality) {
  const value = String(nationality || '').trim().toLowerCase();
  if (value === 'western' || value === 'american') {
    return 'western';
  }
  if (value === 'japanese') {
    return 'japanese';
  }
  if (value === 'korean') {
    return 'korean';
  }
  if (value === 'chinese') {
    return 'chinese';
  }
  return 'other';
}

export function countExpansionLangGroups(expansions) {
  const counts = {
    all: 0, junk: 0, disagree: 0, western: 0, japanese: 0, korean: 0, chinese: 0, other: 0,
  };
  for (const row of expansions || []) {
    counts.all += 1;
    counts[expansionLangGroup(row.nationality)] += 1;
    if (row.ocr_junk) {
      counts.junk += 1;
    }
    if (!qwenAgrees(row.nationality, row.qwen_print)) {
      counts.disagree += 1;
    }
  }
  return counts;
}

export function filterExpansions(expansions, { group = 'all', query = '' } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  const want = String(group || 'all').toLowerCase();
  return (expansions || []).filter((row) => {
    if (want === 'junk') {
      if (!row.ocr_junk) {
        return false;
      }
    } else if (want === 'disagree') {
      if (qwenAgrees(row.nationality, row.qwen_print)) {
        return false;
      }
    } else if (want !== 'all' && expansionLangGroup(row.nationality) !== want) {
      return false;
    }
    if (needle && !String(row.name || '').toLowerCase().includes(needle)) {
      return false;
    }
    return true;
  });
}

export function expansionsBoardUrl() {
  const base = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}review/ocr-expansions.json`;
}
