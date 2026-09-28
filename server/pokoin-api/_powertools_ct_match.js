'use strict';

/**
 * Match Power Tools CSV stock rows to CardTrader export products so CT imports
 * inherit PT inventory locations (box·stack·pos).
 */

function cleanText(value, max = 240) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** Compact identity for fuzzy name/set/cn matching. */
function compactKey(value) {
  return cleanText(value, 240)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** Collector numbers like 069/101 and 69/101 compare equal. */
function compactCollector(value) {
  const raw = cleanText(value, 40).toLowerCase();
  if (!raw) return '';
  const m = raw.match(/^0*(\d+)\s*\/\s*0*(\d+)/);
  if (m) return `${m[1]}/${m[2]}`;
  return raw.replace(/^0+(\d)/, '$1');
}

function facetBits(row = {}) {
  return [
    cleanText(row.condition, 20).toUpperCase() || 'NM',
    cleanText(row.language, 10).toUpperCase() || 'EN',
    row.reverse === true || row.reverse === 't' || row.reverse === 1 ? '1' : '0',
    row.firstEdition === true || row.first_edition === true || row.firstEdition === 't' ? '1' : '0',
  ].join('|');
}

/**
 * Match key without card id: name + collector + condition/lang/reverse/1st.
 * Set title is a soft hint (PT set names often differ from CT).
 */
function stockMatchKey(row = {}) {
  const name = compactKey(row.name || row.cardName || '');
  const cn = compactCollector(row.collectorNumber || row.collector_number || row.cn || '');
  if (!name) return '';
  return `${name}|${cn}|${facetBits(row)}`;
}

function softSetKey(row = {}) {
  return compactKey(row.setName || row.set_name || row.expansion || row.set || '');
}

/**
 * Build a multimap of PT rows keyed by stockMatchKey.
 * Each entry keeps { row, location, game }.
 */
function indexPowerToolsRows(rows = [], game = 'pokemon') {
  const byKey = new Map();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const key = stockMatchKey(raw);
    if (!key) continue;
    const location = cleanText(raw.location, 120);
    const entry = {
      game: cleanText(game, 40) || 'pokemon',
      location,
      name: cleanText(raw.name, 240),
      setName: cleanText(raw.setName || raw.set, 240),
      collectorNumber: cleanText(raw.collectorNumber || raw.cn, 40),
      condition: cleanText(raw.condition, 20) || 'NM',
      language: cleanText(raw.language, 10).toUpperCase() || 'EN',
      reverse: raw.reverse === true,
      firstEdition: raw.firstEdition === true || raw.first_edition === true,
      quantity: Math.max(0, Math.trunc(Number(raw.quantity) || 0)),
      pricePkn: Math.max(0, Math.trunc(Number(raw.pricePkn) || 0)),
      setCompact: softSetKey(raw),
      raw,
    };
    const bucket = byKey.get(key) || [];
    bucket.push(entry);
    byKey.set(key, bucket);
  }
  return byKey;
}

function collectorFromProduct(product = {}) {
  const props = product.raw?.properties_hash
    || product.raw?.properties
    || product.properties_hash
    || product.properties
    || {};
  return cleanText(
    props.collector_number
      || props.pokemon_number
      || product.collectorNumber
      || product.collector_number
      || '',
    40,
  );
}

function ctRowForMatch(product = {}) {
  return {
    name: product.name || '',
    collectorNumber: collectorFromProduct(product),
    condition: product.condition || 'NM',
    language: product.language || 'EN',
    reverse: product.reverse === true,
    firstEdition: product.firstEdition === true,
    setName: product.raw?.expansion?.name_en || product.raw?.expansion_name || '',
  };
}

/**
 * Prefer exact key match; when several PT rows share a key, prefer same set compact.
 * Consumes matched PT entries from the index (mutates byKey buckets).
 */
function takePowerToolsMatch(byKey, product) {
  const row = ctRowForMatch(product);
  const key = stockMatchKey(row);
  if (!key) return null;
  const bucket = byKey.get(key);
  if (!bucket || !bucket.length) return null;
  const setHint = softSetKey(row);
  let idx = 0;
  if (setHint) {
    const found = bucket.findIndex((entry) => entry.setCompact && entry.setCompact === setHint);
    if (found >= 0) idx = found;
  }
  const [entry] = bucket.splice(idx, 1);
  if (!bucket.length) byKey.delete(key);
  return entry || null;
}

/**
 * Pair CT products (already game-scoped) with PT rows.
 * @returns {{
 *   matched: Array<{ product, powerTools, location }>,
 *   ctOnly: Array<{ product }>,
 *   ptOnly: Array<object>,
 * }}
 */
function reconcilePowerToolsWithCardTrader(products = [], powerToolsRows = [], game = 'pokemon') {
  const byKey = indexPowerToolsRows(powerToolsRows, game);
  const matched = [];
  const ctOnly = [];
  for (const product of products) {
    if (!product?.id) continue;
    const hit = takePowerToolsMatch(byKey, product);
    if (hit) {
      matched.push({
        product,
        powerTools: hit,
        location: hit.location || '',
      });
    } else {
      ctOnly.push({ product });
    }
  }
  const ptOnly = [];
  for (const bucket of byKey.values()) {
    for (const entry of bucket) ptOnly.push(entry);
  }
  return { matched, ctOnly, ptOnly };
}

/**
 * Summarize distinct marketplace games present in a CT export.
 */
function gamesFromCardTraderProducts(products = [], marketplaceGameForProduct) {
  const counts = new Map();
  for (const product of products) {
    const game = typeof marketplaceGameForProduct === 'function'
      ? marketplaceGameForProduct(product)
      : '';
    if (!game) continue;
    counts.set(game, (counts.get(game) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

module.exports = {
  cleanText,
  compactKey,
  compactCollector,
  stockMatchKey,
  softSetKey,
  indexPowerToolsRows,
  collectorFromProduct,
  ctRowForMatch,
  takePowerToolsMatch,
  reconcilePowerToolsWithCardTrader,
  gamesFromCardTraderProducts,
};
