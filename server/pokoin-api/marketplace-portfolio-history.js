'use strict';

/**
 * GET /api/marketplace-portfolio-history
 * One stored series per seller. The homepage minimum for their 1-Day Ready
 * cards is summed once per UTC day and kept. Later visits that day read the
 * document and do not price the pile again.
 */

const { getFirebaseAdmin, verifyBearerToken } = require('../server/_firebase');
const { marketplaceQuery } = require('../server/_marketplace_db');
const {
  utcDayKey,
  buildSeries,
  storedIsFresh,
  upsertDay,
  compactDay,
} = require('./_portfolio_history_core');

const HISTORY = 'portfolio_history';

const MARKET_SQL = `
  select coalesce(sum(a.quantity * c.pkn), 0) as market_pkn,
         count(c.pkn)::int as priced
  from public.marketplace_cardtrader_1dr_assets a
  left join lateral (
    select min(cache.cheapest_price_pkn) as pkn
    from public.cheapest_homepage_cache_blueprint cache
    where cache.pokoin_card_id = a.card_id
      and cache.cheapest_price_pkn > 0
      and coalesce(cache.eligible_listing_count, 0) > 0
  ) c on true
  where a.seller_uid = $1
    and a.quantity > 0
    and a.card_id <> ''
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

async function readMarket(uid) {
  const result = await marketplaceQuery(MARKET_SQL, [uid]);
  const row = result?.rows?.[0] || {};
  const priced = Number(row.priced) || 0;
  const value = Number(row.market_pkn) || 0;
  return priced > 0 ? Math.round(value * 100) / 100 : null;
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
    const existing = cleanDays(saved.exists ? saved.data()?.days : []);
    if (storedIsFresh(existing, todayKey)) {
      return res.status(200).json({ ok: true, days: existing });
    }
    let market = null;
    let checked = false;
    try {
      market = await readMarket(uid);
      checked = true;
    } catch (error) {
      console.error('portfolio history market failed', { message: error.message });
    }
    const balance = await readBalance(firestore, uid);
    const days = existing.length
      ? upsertDay(existing, {
        date: todayKey,
        currencyPkn: balance,
        cardsValuePkn: market,
        cardsKnown: checked,
      })
      : buildSeries({
        movements: await readLedger(firestore, uid),
        balance,
        marketCardsPkn: market,
        marketChecked: checked,
        today: new Date(),
      });
    if (checked) {
      await firestore.collection(HISTORY).doc(uid).set({
        days,
        updatedAt: new Date().toISOString(),
      });
    }
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
