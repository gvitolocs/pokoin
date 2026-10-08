'use strict';

function defaultMarketplaceQuery() {
  return require('./_marketplace_db').marketplaceQuery;
}

const CARDMARKET_BASE = 'https://www.cardmarket.com';
const CARDMARKET_LOCALES = ['en', 'it', 'de', 'fr', 'es'];
const LOCALE_SEGMENT_RE = /^\/(en|it|de|fr|es)\/([^/]+)\/Products\/Singles\/(.+)$/;

function cardmarketPathKey(url) {
  let value;
  try {
    value = new URL(String(url || ''), CARDMARKET_BASE);
  } catch (_) {
    return '';
  }
  if (!/cardmarket\.com$/i.test(value.hostname.replace(/^www\./i, ''))) {
    return '';
  }
  let path = value.pathname;
  if (path.endsWith('/')) path = path.slice(0, -1);
  const match = LOCALE_SEGMENT_RE.exec(path);
  if (!match) return '';
  return `/${match[2]}/Products/Singles/${match[3]}`;
}

function candidateUrls(key) {
  return CARDMARKET_LOCALES.map((locale) => `${CARDMARKET_BASE}/${locale}${key}`);
}

let marketplaceQueryOverride = null;

function setMarketplaceQueryForTest(query) {
  marketplaceQueryOverride = query || null;
}

async function lookupCardmarketProduct(url, options = {}) {
  const key = cardmarketPathKey(url);
  if (!key) return null;
  const candidates = candidateUrls(key);
  const query = options.query || marketplaceQueryOverride || defaultMarketplaceQuery();
  let result;
  try {
    result = await query(
    `
      select blueprint_id, cardmarket_url, 0 as priority,
        card_name, expansion_name, collector_number,
        'verified_link' as source, confidence as confidence,
        verified_at, updated_at
      from public.marketplace_cm_verified_links
      where cardmarket_url = any($1::text[])
        and confidence in ('verified', 'manual')
      union all
      select blueprint_id, cardmarket_url, 1 as priority,
        card_name, expansion_name, collector_number,
        'product_parsing' as source, match_status as confidence,
        verified_at, updated_at
      from public.marketplace_cm_product_parsing
      where cardmarket_url = any($1::text[])
        and match_status in ('verified', 'manual')
      order by priority, verified_at desc nulls last, updated_at desc
      limit 1
    `,
      [candidates],
    );
  } catch (error) {
    if (error && error.code === '42P01') {
      return null;
    }
    throw error;
  }
  const row = result && result.rows ? result.rows[0] : null;
  if (!row) return null;
  const blueprintId = BigInt(row.blueprint_id ?? 0n);
  const publicId = String(blueprintId * 2n);
  return {
    blueprintId: String(blueprintId),
    publicId,
    cardName: String(row.card_name || ''),
    expansionName: String(row.expansion_name || ''),
    collectorNumber: String(row.collector_number || ''),
    source: row.source,
    confidence: String(row.confidence || ''),
  };
}

module.exports = {
  cardmarketPathKey,
  candidateUrls,
  lookupCardmarketProduct,
  setMarketplaceQueryForTest,
  CARDMARKET_LOCALES,
};
