'use strict';

/**
 * GET /api/marketplace-portfolio-history
 * One stored series per seller. Card value is quantity times that day's sold
 * median (cardtrader_sold_daily). A card with no sale that day is left out.
 * Asks and dump minimums are not used. A visit that already stored today's
 * basis reads the document and does not price the pile again.
 */

const { getFirebaseAdmin, verifyBearerToken } = require('../server/_firebase');
const { marketplaceQuery } = require('../server/_marketplace_db');
const { integrationDocId, COLLECTION } = require('./_cardtrader_integration');
const {
  PRICE_BASIS,
  SERIES_REVISION,
  utcDayKey,
  buildSeries,
  storedIsFresh,
  compactDay,
  applySoldDayValues,
} = require('./_portfolio_history_core');

const HISTORY = 'portfolio_history';

const SOLD_SQL = `
  with held as (
    select blueprint_id, sum(quantity)::numeric as qty
    from public.marketplace_cardtrader_1dr_assets
    where seller_uid = $1
      and quantity > 0
      and blueprint_id ~ '^[0-9]+$'
    group by blueprint_id
  ),
  sold as (
    select observed_day,
           blueprint_id::text as blueprint_id,
           sum(median_pkn * sold_qty) / nullif(sum(sold_qty), 0) as sold_pkn
    from public.cardtrader_sold_daily
    where observed_day >= $2::date
      and median_pkn > 0
      and sold_qty > 0
    group by observed_day, blueprint_id
  )
  select sold.observed_day::text as day,
         round(sum(sold.sold_pkn * held.qty)::numeric, 2) as market_pkn,
         count(*)::int as priced
  from held
  join sold on sold.blueprint_id = held.blueprint_id
  group by sold.observed_day
  order by sold.observed_day
`;

const OWNED_SINCE_SQL = `
  select min(created_at) as since
  from public.marketplace_cardtrader_1dr_assets
  where seller_uid = $1
    and quantity > 0
`;

function cleanDays(value) {
  return (Array.isArray(value) ? value : []).map(compactDay).filter(Boolean);
}

function dayFromStamp(value) {
  return utcDayKey(value);
}

async function readBalance(firestore, uid) {
  const doc = await firestore.collection('balances').doc(uid).get();
  return Math.max(0, Number(doc.exists ? doc.data()?.availablePkn : 0) || 0);
}

async function readLedger(firestore, uid) {
  const col = firestore.collection('ledger_entries');
  let snap;
  try {
    snap = await col.where('uid', '==', uid).orderBy('createdAt', 'desc').limit(200).get();
  } catch (_) {
    snap = await col.where('uid', '==', uid).limit(200).get();
  }
  return snap.docs.map((doc) => doc.data() || {});
}

async function readOwnedSince(uid) {
  try {
    const result = await marketplaceQuery(OWNED_SINCE_SQL, [uid]);
    return result?.rows?.[0]?.since || null;
  } catch (error) {
    console.error('portfolio ownership date failed', { message: error.message });
    return null;
  }
}

async function stampFirstSync(firestore, uid, doc, day) {
  const data = doc?.exists ? doc.data() || {} : {};
  if (!doc?.exists || data.enabled !== true) return;
  if (data.metadata?.firstSyncAt || !day) return;
  try {
    await firestore.collection(COLLECTION).doc(integrationDocId(uid)).set({
      metadata: { ...(data.metadata || {}), firstSyncAt: day },
    }, { merge: true });
  } catch (error) {
    console.error('portfolio first sync stamp failed', { message: error.message });
  }
}

async function readOwnership(firestore, uid) {
  const doc = await firestore.collection(COLLECTION).doc(integrationDocId(uid)).get();
  const data = doc.exists ? doc.data() || {} : {};
  const assetSince = await readOwnedSince(uid);
  const day = [
    data.connectedAt,
    data.metadata?.firstSyncAt,
    assetSince,
  ].map(dayFromStamp).filter(Boolean).sort()[0] || utcDayKey(new Date());
  await stampFirstSync(firestore, uid, doc, day);
  return day;
}

async function readSoldSeries(uid, sinceDay) {
  try {
    const result = await marketplaceQuery(SOLD_SQL, [uid, sinceDay]);
    return { ok: true, rows: result?.rows || [] };
  } catch (error) {
    console.error('portfolio sold history failed', { message: error.message });
    return { ok: false, rows: [] };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  try {
    const decoded = await verifyBearerToken(req);
    const uid = String(decoded.uid || '');
    const firestore = getFirebaseAdmin().firestore();
    const todayKey = utcDayKey(new Date());
    const saved = await firestore.collection(HISTORY).doc(uid).get();
    const data = saved.exists ? saved.data() || {} : {};
    if (storedIsFresh(data, todayKey)) {
      return res.status(200).json({ ok: true, days: cleanDays(data.days) });
    }
    const ownershipDate = await readOwnership(firestore, uid);
    const sold = await readSoldSeries(uid, ownershipDate);
    if (!sold.ok) {
      return res.status(200).json({ ok: true, days: cleanDays(data.days) });
    }
    const balance = await readBalance(firestore, uid);
    const wallet = buildSeries({
      movements: await readLedger(firestore, uid),
      balance,
      marketChecked: false,
      today: new Date(),
    });
    const days = applySoldDayValues(wallet, sold.rows, {
      ownershipDate,
      today: new Date(),
    }).slice(-400);
    const dumpDay = sold.rows.length
      ? String(sold.rows[sold.rows.length - 1].day || sold.rows[sold.rows.length - 1].date || '')
      : '';
    await firestore.collection(HISTORY).doc(uid).set({
      days,
      priceBasis: PRICE_BASIS,
      seriesRevision: SERIES_REVISION,
      dumpDay,
      updatedAt: new Date().toISOString(),
    });
    return res.status(200).json({ ok: true, days });
  } catch (error) {
    console.error('marketplace-portfolio-history failed', {
      code: error.code || '',
      statusCode: error.statusCode || 500,
      message: error.message,
    });
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Portfolio history failed.',
      code: error.code,
    });
  }
};
