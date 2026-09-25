const { getFirebaseAdmin, verifyBearerToken } = require('../server/_firebase');
const { marketplaceQuery } = require('../server/_marketplace_db');
const { readIntegrationDoc } = require('./_cardtrader_integration');
const { readOneDayReadyAssets, readSellerSync } = require('./_cardtrader_inventory_sync');
const { applyHomepageMinimums, marketPricePkn, oneDayReadyTotals } = require('./_cardtrader_inventory_sync_core');

/**
 * GET /api/cardtrader-assets — the signed-in seller's CardTrader 1-Day Ready
 * inventory as dashboard assets. That stock is CardTrader's to sell, so it is
 * never a Pokoin listing; the dashboard shows it as "CardTrader 1-DR".
 */

const HOMEPAGE_MINIMUM_SQL = `
  select cache.pokoin_card_id as card_id,
         min(cache.cheapest_price_pkn) as pkn
  from public.cheapest_homepage_cache_blueprint cache
  where cache.pokoin_card_id = any($1::text[])
    and cache.cheapest_price_pkn > 0
    and coalesce(cache.eligible_listing_count, 0) > 0
  group by cache.pokoin_card_id
`;

async function withHomepageMinimums(rows) {
  const ids = [...new Set((rows || []).map((row) => String(row.card_id || '')).filter((id) => /^\d+$/.test(id)))];
  if (!ids.length) return applyHomepageMinimums(rows, []);
  const result = await marketplaceQuery(HOMEPAGE_MINIMUM_SQL, [ids]);
  return applyHomepageMinimums(rows, result?.rows || []);
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
    priced = await withHomepageMinimums(rows);
  } catch (error) {
    console.error('1dr homepage minimum failed', { message: error.message });
    priced = applyHomepageMinimums(rows, []);
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
