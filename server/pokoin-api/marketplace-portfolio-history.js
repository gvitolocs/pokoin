'use strict';

/**
 * GET /api/marketplace-portfolio-history
 * One stored daily series per seller: wallet PKN plus the seller's CardTrader
 * 1-DR stock and own Pokoin listings marked at each printing slice's last sold median on or before
 * that day (cardtrader_sold_daily, carried forward). A slice that never sold
 * adds 0 PKN. Asks and dump minimums are never used. Days that had ended when
 * the series was stored keep their card value, so a card that sells later
 * does not vanish from the past; only today is re-priced.
 */

const { getFirebaseAdmin, verifyBearerToken } = require('../server/_firebase');
const { marketplaceQuery } = require('../server/_marketplace_db');
const {
  PRICE_BASIS,
  SERIES_REVISION,
  SOLD_BY_BLUEPRINT_SQL,
  buildDailySeries,
  compactDay,
  frozenCardDays,
  holdingSlices,
  soldPriceBook,
  storedIsFresh,
  utcDayKey,
  walletSeries,
} = require('./_portfolio_history_core');

const HISTORY = 'portfolio_history';

// CardTrader 1-DR stock plus the seller's own Pokoin listings (scan batches,
// desk listings). Listings imported from CardTrader are the same physical
// cards as the 1-DR stock, so they are left out rather than counted twice.
const HOLDINGS_SQL = `
  select blueprint_id, condition, language, reverse, first_edition, graded,
         quantity, created_at::text as since
  from public.marketplace_cardtrader_1dr_assets
  where seller_uid = $1
    and quantity > 0
  union all
  select coalesce(v.blueprint_id::text, '') as blueprint_id, l.condition, l.language,
         l.reverse, l.first_edition, l.graded,
         l.quantity_available as quantity, l.created_at::text as since
  from public.marketplace_user_listings l
  left join public.marketplace_card_versions v on v.card_id::text = l.card_id
  where l.seller_uid = $1
    and l.status in ('active', 'paused')
    and l.quantity_available > 0
    and coalesce(l.source, '') <> 'cardtrader_seller_import'
`;

function cleanDays(value) {
  return (Array.isArray(value) ? value : []).map(compactDay).filter(Boolean);
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

/** Held stock and every sold print of its blueprints, or ok:false when the market DB is down. */
async function readCardBook(uid) {
  try {
    const held = await marketplaceQuery(HOLDINGS_SQL, [uid]);
    const rows = held?.rows || [];
    const ids = [...new Set(rows.map((row) => String(row.blueprint_id || '')).filter((id) => /^\d+$/.test(id)))];
    const sold = ids.length ? await marketplaceQuery(SOLD_BY_BLUEPRINT_SQL, [ids]) : { rows: [] };
    return { ok: true, holdings: holdingSlices(rows), book: soldPriceBook(sold?.rows || []) };
  } catch (error) {
    console.error('portfolio card book failed', { message: error.message });
    return { ok: false, holdings: [], book: new Map() };
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
    const now = new Date();
    const saved = await firestore.collection(HISTORY).doc(uid).get();
    const data = saved.exists ? saved.data() || {} : {};
    if (storedIsFresh(data, now)) {
      return res.status(200).json({ ok: true, days: cleanDays(data.days) });
    }
    const cards = await readCardBook(uid);
    if (!cards.ok) {
      // Serve the last good series rather than a chart without cards.
      const stale = data.priceBasis === PRICE_BASIS && data.seriesRevision === SERIES_REVISION;
      return res.status(200).json({ ok: true, days: stale ? cleanDays(data.days) : [] });
    }
    const wallet = walletSeries({
      movements: await readLedger(firestore, uid),
      balance: await readBalance(firestore, uid),
      today: now,
    });
    const days = buildDailySeries({
      wallet,
      holdings: cards.holdings,
      book: cards.book,
      frozen: frozenCardDays(data, utcDayKey(now)),
      today: now,
    });
    await firestore.collection(HISTORY).doc(uid).set({
      days,
      priceBasis: PRICE_BASIS,
      seriesRevision: SERIES_REVISION,
      updatedAt: now.toISOString(),
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

module.exports._test = { readCardBook, HOLDINGS_SQL };
