'use strict';

/**
 * GET /api/marketplace-native-sales?cardId=<public card id>
 *
 * Public "Sold on Pokoin" rows for a card desk: paid native Pokoin orders
 * (site PKN escrow + EUR Stripe). Date, condition, language, quantity, price —
 * never the buyer or the order id. CardTrader inferred comps stay on the sold
 * graph; this is only what actually sold through Pokoin checkout.
 */

const path = require('path');
const { SALES_COLLECTION, publicSaleRow, sortBySoldAtDesc } = require('./_native_sales');

function requireHelper(name) {
  try {
    return require(path.join(__dirname, '..', 'server', name));
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return require(`./${name}`);
  }
}

function cleanCardId(value) {
  const text = String(value || '').trim().slice(0, 120);
  return /^[A-Za-z0-9_-]{1,120}$/.test(text) ? text : '';
}

function cleanLimit(value) {
  const number = Math.trunc(Number(value) || 20);
  return Math.min(50, Math.max(1, number));
}

function nativeSalesFromDocs(docs, limit) {
  const rows = docs
    .map((doc) => doc.data() || {})
    .filter((data) => data.voided !== true && data.source !== 'cardtrader')
    .map(publicSaleRow)
    .filter((row) => row.quantity > 0);
  return sortBySoldAtDesc(rows).slice(0, limit);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
  const cardId = cleanCardId(url.searchParams.get('cardId') || req.query?.cardId);
  if (!cardId) {
    return res.status(400).json({ error: 'cardId is required.' });
  }
  try {
    const { getFirebaseAdmin } = requireHelper('_firebase');
    const snap = await getFirebaseAdmin().firestore()
      .collection(SALES_COLLECTION)
      .where('cardId', '==', cardId)
      .limit(200)
      .get();
    const sales = nativeSalesFromDocs(snap.docs, cleanLimit(url.searchParams.get('limit')));
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json({ cardId, sales });
  } catch (error) {
    console.error('marketplace-native-sales failed', error.message);
    return res.status(503).json({ error: 'We are working on a solution.' });
  }
};

module.exports._test = { cleanCardId, cleanLimit, nativeSalesFromDocs };
