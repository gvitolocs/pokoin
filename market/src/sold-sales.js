/** Client sold-graph slices: one card payload, local filter, no per-click API. */

import { cardLanguageQuery, usesAsianCardLanguages, ASIAN_CARD_LANGS } from './locale.js';
import { soldFilterValue } from './sold-graph.js';

export const SOLD_CONDITION_ORDER = ['NM', 'SP', 'MP', 'PL', 'Poor'];
export const SOLD_LANGUAGE_ORDER = [
  'EN', 'IT', 'JP', 'FR', 'DE', 'ES', 'KO', 'ZH', 'ZHT', 'PT', 'NL', 'PL', 'RU', 'ID', 'TH', 'VI',
];

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function dayKey(value) {
  if (!value) {
    return '';
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : String(value).slice(0, 10);
}

function roundPkn(value) {
  return Number(numberValue(value).toFixed(2));
}

function commentList(value) {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set();
  const comments = [];
  for (const row of rows) {
    const text = String(row || '').trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      comments.push(text);
    }
  }
  return comments.slice(0, 8);
}

function sampleCountOf(row = {}) {
  const source = row && typeof row === 'object' ? row : {};
  const samples = Math.max(0, Math.trunc(numberValue(source.sampleCount ?? source.sample_count)));
  if (samples > 0) {
    return samples;
  }
  const listings = Math.max(0, Math.trunc(numberValue(source.listings)));
  if (listings > 0) {
    return listings;
  }
  return Math.max(0, Math.trunc(numberValue(source.soldQty ?? source.sold_qty)));
}

function uniqueOrdered(values, order) {
  const seen = new Set();
  for (const value of values) {
    const key = String(value || '').trim();
    if (key) {
      seen.add(key);
    }
  }
  const ranked = order.filter((key) => seen.has(key));
  const rest = [...seen].filter((key) => !order.includes(key)).sort((left, right) => left.localeCompare(right));
  return [...ranked, ...rest];
}

export function uniqueFlags(values = []) {
  const seen = new Set();
  for (const value of values) {
    if (value === true || value === false) {
      seen.add(value);
      continue;
    }
    const text = String(value ?? '').trim().toLowerCase();
    if (['true', 't', '1', 'yes'].includes(text)) {
      seen.add(true);
    } else if (['false', 'f', '0', 'no'].includes(text)) {
      seen.add(false);
    }
  }
  return [false, true].filter((flag) => seen.has(flag));
}

function medianOf(values) {
  const list = values.map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!list.length) {
    return 0;
  }
  const mid = Math.floor((list.length - 1) / 2);
  if (list.length % 2) {
    return list[mid];
  }
  return (list[mid] + list[mid + 1]) / 2;
}

function strictFlagValue(value) {
  if (value === true || value === '1' || value === 'true') {
    return true;
  }
  if (value === false || value === '0' || value === 'false') {
    return false;
  }
  return null;
}

function rowFlag(row, key) {
  const value = key === 'firstEdition' ? (row.firstEdition ?? row.first_edition) : row[key];
  return strictFlagValue(value) === true;
}

export function soldSlicePayload(slice = {}) {
  return {
    condition: String(slice.condition || '').trim(),
    language: String(slice.language || '').trim().toUpperCase(),
    reverse: strictFlagValue(slice.reverse),
    firstEdition: strictFlagValue(slice.firstEdition),
    graded: strictFlagValue(slice.graded),
  };
}

export function rowMatchesSoldSlice(row, slice = {}, omit = '') {
  const flags = soldSlicePayload(slice);
  if (omit !== 'condition' && flags.condition && String(row.condition || '') !== flags.condition) {
    return false;
  }
  if (omit !== 'language' && flags.language && String(row.language || '').toUpperCase() !== flags.language) {
    return false;
  }
  if (omit !== 'reverse' && flags.reverse !== null && rowFlag(row, 'reverse') !== flags.reverse) {
    return false;
  }
  if (
    omit !== 'firstEdition'
    && flags.firstEdition !== null
    && rowFlag(row, 'firstEdition') !== flags.firstEdition
  ) {
    return false;
  }
  if (omit !== 'graded' && flags.graded !== null && rowFlag(row, 'graded') !== flags.graded) {
    return false;
  }
  return true;
}

export function buildSalesFilters(rows = [], slice = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const facet = (omit) => list.filter((row) => rowMatchesSoldSlice(row, slice, omit));
  return {
    conditions: uniqueOrdered(facet('condition').map((row) => row.condition), SOLD_CONDITION_ORDER),
    languages: uniqueOrdered(facet('language').map((row) => row.language), SOLD_LANGUAGE_ORDER),
    reverse: uniqueFlags(facet('reverse').map((row) => row.reverse)),
    firstEdition: uniqueFlags(facet('firstEdition').map((row) => row.firstEdition ?? row.first_edition)),
    graded: uniqueFlags(facet('graded').map((row) => row.graded)),
  };
}

export function mergeSoldDailyRows(rows = []) {
  const byDay = new Map();
  for (const row of rows || []) {
    const day = dayKey(row.day);
    if (!day) {
      continue;
    }
    const bucket = byDay.get(day) || [];
    bucket.push(row);
    byDay.set(day, bucket);
  }
  return [...byDay.entries()].map(([day, slices]) => {
    const prices = [];
    const comments = [];
    let minPkn = Infinity;
    let maxPkn = 0;
    let soldQty = 0;
    let listings = 0;
    let sampleCount = 0;
    for (const slice of slices) {
      const median = numberValue(slice.medianPkn ?? slice.median_pkn);
      const qty = Math.max(1, Math.trunc(numberValue(slice.soldQty ?? slice.sold_qty, 1)));
      for (let i = 0; i < qty; i += 1) {
        prices.push(median);
      }
      minPkn = Math.min(minPkn, numberValue(slice.minPkn ?? slice.min_pkn, median));
      maxPkn = Math.max(maxPkn, numberValue(slice.maxPkn ?? slice.max_pkn, median));
      soldQty += Math.max(0, Math.trunc(numberValue(slice.soldQty ?? slice.sold_qty)));
      listings += Math.max(0, Math.trunc(numberValue(slice.listings)));
      sampleCount += sampleCountOf(slice);
      comments.push(...commentList(slice.comments ?? slice.graded_comments));
    }
    return {
      day,
      medianPkn: slices.length === 1 ? numberValue(slices[0].medianPkn ?? slices[0].median_pkn) : medianOf(prices),
      minPkn: minPkn === Infinity ? 0 : minPkn,
      maxPkn,
      soldQty,
      listings,
      sampleCount: sampleCount || listings,
      comments: commentList(comments),
    };
  });
}

function shiftDay(day, delta) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + Number(delta || 0));
  return date.toISOString().slice(0, 10);
}

/** A vanished listing is a sale only after it has stayed gone for 3 days. */
export const SOLD_CHANGE_DAYS = 3;

export function changeOverConfirmedDays(days, span = SOLD_CHANGE_DAYS) {
  const rows = days || [];
  if (rows.length < 2) return null;
  const latest = rows[rows.length - 1];
  const cutoff = shiftDay(latest.day, -span);
  if (!cutoff) return null;
  let previous = null;
  for (const row of rows) {
    if (row.day <= cutoff) previous = row;
    else break;
  }
  if (!previous || !(previous.medianPkn > 0) || !(latest.medianPkn > 0)) return null;
  return Number(((latest.medianPkn - previous.medianPkn) / previous.medianPkn).toFixed(6));
}

export function buildSalesSeries(dayRows = []) {
  const days = (Array.isArray(dayRows) ? dayRows : [])
    .map((row) => ({
      day: dayKey(row.day),
      medianPkn: roundPkn(row.medianPkn ?? row.median_pkn),
      minPkn: roundPkn(row.minPkn ?? row.min_pkn),
      maxPkn: roundPkn(row.maxPkn ?? row.max_pkn),
      soldQty: Math.max(0, Math.trunc(numberValue(row.soldQty ?? row.sold_qty))),
      listings: Math.max(0, Math.trunc(numberValue(row.listings))),
      sampleCount: sampleCountOf(row),
      comments: commentList(row.comments),
    }))
    .filter((row) => row.day && row.medianPkn > 0)
    .sort((left, right) => left.day.localeCompare(right.day));
  const change24hPct = changeOverConfirmedDays(days);
  return {
    days,
    sampleCount: days.reduce((sum, row) => sum + row.sampleCount, 0),
    soldQty: days.reduce((sum, row) => sum + row.soldQty, 0),
    change24hPct,
    firstDay: days[0]?.day || null,
    lastDay: days[days.length - 1]?.day || null,
    lastMedianPkn: days[days.length - 1]?.medianPkn || null,
  };
}

export function sharedSoldTraits(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return null;
  }
  const conditions = uniqueOrdered(list.map((row) => row.condition), SOLD_CONDITION_ORDER);
  const languages = uniqueOrdered(list.map((row) => row.language), SOLD_LANGUAGE_ORDER);
  const reverse = uniqueFlags(list.map((row) => row.reverse));
  const firstEdition = uniqueFlags(list.map((row) => row.firstEdition ?? row.first_edition));
  const graded = uniqueFlags(list.map((row) => row.graded));
  return {
    condition: conditions.length === 1 ? conditions[0] : '',
    language: languages.length === 1 ? languages[0] : '',
    reverse: reverse.length === 1 && reverse[0] === true,
    firstEdition: firstEdition.length === 1 && firstEdition[0] === true,
    graded: graded.length === 1 && graded[0] === true,
  };
}

export function nationalitySoldSlices(slices, nationality) {
  const list = Array.isArray(slices) ? slices : [];
  if (!usesAsianCardLanguages(nationality)) {
    return list;
  }
  return list.filter((row) => ASIAN_CARD_LANGS.includes(String(row.language || '').toUpperCase()));
}

/**
 * Strict foil flags for the desk graph: an unselected chip plots standard
 * copies only (reverse / 1st Ed. / Graded excluded), a pressed chip plots that
 * variant only. A printing that never sold the standard variant snaps the chip
 * back on so its graph is not blanked by the stricter default.
 */
function strictFlagState(rows, wanted) {
  const effective = {};
  for (const key of ['reverse', 'firstEdition', 'graded']) {
    const on = rows.some((row) => rowFlag(row, key));
    const off = rows.some((row) => !rowFlag(row, key));
    if (wanted[key] === true) {
      effective[key] = on;
    } else {
      effective[key] = !off && on;
    }
  }
  return effective;
}

function flagVariants(rows, key) {
  const seen = new Set();
  for (const row of rows) {
    seen.add(rowFlag(row, key));
  }
  return [false, true].filter((value) => seen.has(value));
}

function soldGraphSliceState(slices, {
  nationality,
  language = '',
  condition = '',
  reverse = false,
  firstEdition = false,
  graded = false,
} = {}) {
  const scoped = nationalitySoldSlices(slices, nationality);
  const flags = strictFlagState(scoped, { reverse, firstEdition, graded });
  const flagged = scoped.filter((row) => rowMatchesSoldSlice(row, flags));
  const filters = buildSalesFilters(flagged.length ? flagged : scoped);
  const next = {
    language: cardLanguageQuery(nationality, filters.languages, language),
    condition: soldFilterValue(filters.conditions, condition),
    ...flags,
  };
  return {
    filters,
    filtered: scoped.filter((row) => rowMatchesSoldSlice(row, next)),
    flags,
    // Chip visibility is printing-wide, not scoped to the current foil combo.
    chips: {
      reverse: flagVariants(scoped, 'reverse').includes(true),
      firstEdition: flagVariants(scoped, 'firstEdition').includes(true),
      graded: flagVariants(scoped, 'graded').includes(true),
    },
  };
}

/** Traits to apply when the user clicks a plotted day in the current graph slice. */
export function soldTraitsForGraphDay(slices, slice = {}, day) {
  const want = dayKey(day);
  if (!want) {
    return null;
  }
  const { filtered } = soldGraphSliceState(slices, slice);
  return sharedSoldTraits(filtered.filter((row) => dayKey(row.day) === want));
}

/** Series + faceted menus from the cached card slices. */
export function soldGraphView(slices, slice = {}) {
  const { filters, filtered, flags, chips } = soldGraphSliceState(slices, slice);
  return {
    series: buildSalesSeries(mergeSoldDailyRows(filtered)),
    filters,
    flags,
    chips,
  };
}
