const { getFirebaseAdmin, verifyBearerToken } = require('../server/_firebase');
const { marketplaceQuery } = require('../server/_marketplace_db');
const { readIntegrationDoc } = require('./_cardtrader_integration');
const { readOneDayReadyAssets, readSellerSync } = require('./_cardtrader_inventory_sync');
const { applyDumpMinimums, marketPricePkn, oneDayReadyTotals } = require('./_cardtrader_inventory_sync_core');

/**
 * GET /api/cardtrader-assets — the signed-in seller's CardTrader 1-Day Ready
 * inventory as dashboard assets. That stock is CardTrader's to sell, so it is
 * never a Pokoin listing; the dashboard shows it as "CardTrader 1-DR".
 */

const DUMP_LATEST_SQL = `
  select distinct on (analytics.blueprint_id)
         analytics.blueprint_id::text as blueprint_id,
         analytics.min_price_pkn as pkn
  from public.cardtrader_blueprint_daily_analytics analytics
  where analytics.blueprint_id::text = any($1::text[])
    and analytics.min_price_pkn > 0
    and analytics.observed_day >= (timezone('utc', now()))::date - 21
  order by analytics.blueprint_id, analytics.observed_day desc
`;

const LISTING_CACHE_SQL = `
  select cache.blueprint_id::text as blueprint_id,
         cache.cheapest_price_pkn as pkn
  from public.cardtrader_blueprint_listing_cache cache
  where cache.blueprint_id::text = any($1::text[])
    and cache.cheapest_price_pkn > 0
`;

async function withDumpMinimums(rows) {
  const ids = [...new Set((rows || []).map((row) => String(row.blueprint_id || '')).filter((id) => /^\d+$/.test(id)))];
  if (!ids.length) return applyDumpMinimums(rows, []);
  let prices = [];
  try {
    const result = await marketplaceQuery(DUMP_LATEST_SQL, [ids]);
    prices = result?.rows || [];
  } catch (error) {
    console.error('1dr dump minimum failed', { message: error.message });
  }
  const have = new Set(prices.map((row) => String(row.blueprint_id || '')));
  const missing = ids.filter((id) => !have.has(id));
  if (missing.length) {
    try {
      const result = await marketplaceQuery(LISTING_CACHE_SQL, [missing]);
      prices = prices.concat(result?.rows || []);
    } catch (error) {
      console.error('1dr listing cache minimum failed', { message: error.message });
    }
  }
  return applyDumpMinimums(rows, prices);
}

function assetItem(row = {}) {
  return {
    ctProductId: String(row.ct_product_id || ''),
    cardId: String(row.card_id || ''),
    cardName: String(row.card_name || ''),
    setName: String(row.set_name || ''),
    collectorNumber: String(row.collector_number || ''),
    imageUrl: String(row.card_image_url || ''),
    condition: String(row.condition || ''),
    language: String(row.language || ''),
    reverse: row.reverse === true,
    firstEdition: row.first_edition === true,
    signed: row.signed === true,
    altered: row.altered === true,
    graded: row.graded === true,
    quantity: Math.max(0, Math.trunc(Number(row.quantity) || 0)),
    pricePkn: marketPricePkn(row),
  };
}

async function readAssetsPayload(firestore, uid) {
  const doc = await readIntegrationDoc(firestore, uid);
  const data = doc.exists ? doc.data() || {} : {};
  const connected = data.enabled === true;
  const sync = connected ? await readSellerSync(uid) : null;
  const oneDayReady = connected && (
    data.metadata?.oneDayReady === true
    || sync?.last_sync_summary?.mode === 'one_day_ready'
  );
  if (!oneDayReady) {
    return { connected, oneDayReady: false, lastSyncAt: null, totals: oneDayReadyTotals([]), items: [] };
  }
  let rows = [];
  try {
    rows = await readOneDayReadyAssets(uid);
  } catch (error) {
    if (!/does not exist/i.test(String(error.message || ''))) throw error;
  }
  let priced = rows;
  try {
    priced = await withDumpMinimums(rows);
  } catch (error) {
    console.error('1dr dump minimum failed', { message: error.message });
    priced = applyDumpMinimums(rows, []);
  }
  const items = priced.map(assetItem).sort((a, b) => (
    ((b.pricePkn || 0) * b.quantity) - ((a.pricePkn || 0) * a.quantity)
    || String(a.cardName).localeCompare(String(b.cardName))
  ));
  return {
    connected,
    oneDayReady: true,
    lastSyncAt: sync?.last_sync_at ? new Date(sync.last_sync_at).toISOString() : null,
    totals: oneDayReadyTotals(items),
    items,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  try {
    const decoded = await verifyBearerToken(req);
    const firestore = getFirebaseAdmin().firestore();
    const payload = await readAssetsPayload(firestore, decoded.uid);
    return res.status(200).json({ ok: true, ...payload });
  } catch (error) {
    console.error('cardtrader-assets failed', {
      code: error.code || '',
      statusCode: error.statusCode || 500,
      message: error.message,
    });
    return res.status(error.statusCode || 500).json({
      error: error.message || 'CardTrader assets failed.',
      code: error.code,
    });
  }
};

module.exports._test = { assetItem, readAssetsPayload };
