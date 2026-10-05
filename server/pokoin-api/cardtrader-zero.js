'use strict';

const { getFirebaseAdmin, verifyBearerToken } = require('../server/_firebase');
const { marketplaceQuery } = require('../server/_marketplace_db');
const { fetchSellerOrders } = require('./_cardtrader_client');
const { decryptIntegrationToken, readIntegrationDoc } = require('./_cardtrader_integration');
const {
  PENDING_STATE,
  WEEKLY_STATE,
  attachPokoinListings,
  attachPowerToolsOrders,
  buildZeroList,
  linkedSourceIds,
  sortForPicking,
} = require('./_cardtrader_zero');
const {
  decryptPowerToolsSession,
  fetchPowerToolsOrders,
  markSessionExpired,
  readPowerToolsDoc,
  safePowerToolsStatus,
} = require('./_powertools_session');

// Zero orders are few per seller; direct `paid` orders share the state filter,
// so page far enough to reach every open Zero order behind them.
const ORDER_PAGES = { pageSize: 100, maxPages: 10 };

async function loadListings(uid, sourceIds, query = marketplaceQuery) {
  if (!sourceIds.length) return [];
  const result = await query(
    `
      select id, card_id, source_listing_id, location, collector_number, card_image_url
      from public.marketplace_user_listings
      where seller_uid = $1 and source_listing_id = any($2::text[])
    `,
    [uid, sourceIds],
  );
  return result.rows || [];
}

/** Power Tools overlay; never fails the CardTrader list. */
async function powerToolsOverlay(list, { admin, firestore, uid, fetchOrders = fetchPowerToolsOrders }) {
  const doc = await readPowerToolsDoc(firestore, uid);
  const status = safePowerToolsStatus(doc);
  if (!status.connected) return { connected: false };
  try {
    const jwt = await decryptPowerToolsSession(firestore, uid);
    const orders = await fetchOrders(jwt);
    const match = attachPowerToolsOrders(list, orders);
    return {
      connected: true,
      ok: true,
      username: status.account?.username || '',
      ...match,
    };
  } catch (error) {
    if (error.code === 'powertools_session_expired') {
      await markSessionExpired({ admin, firestore, uid }).catch(() => {});
    }
    return {
      connected: true,
      ok: false,
      username: status.account?.username || '',
      code: error.code || '',
      error: error.message || 'Power Tools orders failed.',
    };
  }
}

async function zeroList({ admin, firestore, uid, deps = {} }) {
  const fetchOrders = deps.fetchSellerOrders || fetchSellerOrders;
  const token = await decryptIntegrationToken(firestore, uid);
  const [weeklyOrders, pendingOrders] = await Promise.all([
    fetchOrders(token, { ...ORDER_PAGES, state: WEEKLY_STATE }),
    fetchOrders(token, { ...ORDER_PAGES, state: PENDING_STATE }),
  ]);
  const list = buildZeroList([...weeklyOrders, ...pendingOrders]);
  attachPokoinListings(list, await loadListings(uid, linkedSourceIds(list), deps.query));
  const powerTools = await powerToolsOverlay(list, {
    admin,
    firestore,
    uid,
    fetchOrders: deps.fetchPowerToolsOrders,
  });
  sortForPicking(list);
  const ctDoc = await readIntegrationDoc(firestore, uid);
  const ctData = ctDoc?.exists ? ctDoc.data() || {} : {};
  const ctUser = ctData.metadata?.user || {};
  return {
    fetchedAt: new Date().toISOString(),
    cardtrader: { username: String(ctUser.username || ''), userId: String(ctUser.id || '') },
    oneDayReady: ctData.enabled === true && ctData.metadata?.oneDayReady === true,
    ...list,
    powerTools,
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
    const admin = getFirebaseAdmin();
    const firestore = admin.firestore();
    const result = await zeroList({ admin, firestore, uid: decoded.uid });
    console.log('cardtrader-zero', {
      uid: decoded.uid,
      weeklyOrders: result.weekly.length,
      weeklyUnits: result.totals.weekly.units,
      pendingUnits: result.totals.pending.units,
      powerTools: result.powerTools.connected ? (result.powerTools.ok ? 'ok' : result.powerTools.code) : 'off',
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    const notConnected = error.statusCode === 404;
    console.error('cardtrader-zero failed', {
      code: error.code || '',
      statusCode: error.statusCode || 500,
      message: error.message,
    });
    return res.status(error.statusCode || 500).json({
      error: error.message || 'CardTrader Zero list failed.',
      code: notConnected ? 'cardtrader_not_connected' : error.code,
    });
  }
};

module.exports._test = { loadListings, powerToolsOverlay, zeroList };
