'use strict';

/**
 * Pokoin Associates desk — GET /api/marketplace-associate.
 *
 * Role-scoped revenue-share partners (distributor, ambassador, …) read their
 * live campaign earnings here. The royalty pool is the platform checkout
 * commission (market/src/checkout-fees.js CHECKOUT_COMMISSION_RATE); each
 * associate row in public.marketplace_associates carries their share of that
 * pool and the campaign window the promise covers.
 *
 * A sale qualifies when the seller ships from Italy and the buyer ships to
 * Italy: buyer country is the order's shippingAddressCountryCode (EUR orders)
 * or the shipments' toCountry, seller country is the shipment fromCountry or
 * the listing row's seller_country. Orders with unresolvable countries are
 * reported as unverified, never guessed into the pool.
 *
 * Canonical source for the Pi overlay. Deploy with
 * `scripts/deploy-associate-api.sh` from an origin/main commit. Sibling
 * requires (_marketplace_db, _firebase, _marketplace_react_card) come from
 * the live Pi release base.
 */

const { marketplaceQuery } = require('./_marketplace_db');
const { authErrorResponse, getFirebaseAdmin, verifyBearerToken } = require('./_firebase');
const { setCorsHeaders } = require('./_marketplace_react_card');

const RECENT_MAX = 30;
const ORDER_SCAN_MAX = 5000;
const PAID_STATUSES = new Set(['paid', 'escrow', 'released']);
const DEAD_STATUSES = new Set(['cancelled', 'failed', 'expired', 'void']);
const QUALIFYING_COUNTRY = 'IT';

function cors(res) {
  setCorsHeaders(res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

function jsonPrivate(res, body) {
  cors(res);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json(body);
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function maskEmail(value) {
  const email = cleanEmail(value);
  const at = email.indexOf('@');
  if (!email || at <= 0) return 'hidden';
  const name = email.slice(0, at);
  return `${name.slice(0, 1)}${'*'.repeat(Math.min(Math.max(name.length - 1, 2), 5))}${email.slice(at)}`;
}

function tsToMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function utcDayKey(millis) {
  return new Date(millis).toISOString().slice(0, 10);
}

function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function associateRowForEmail(email) {
  const result = await marketplaceQuery(
    `
      select email, role, display_name, share_pct, royalty_pct,
             window_start, window_end, active, city
      from public.marketplace_associates
      where lower(btrim(email)) = $1
      limit 1
    `,
    [cleanEmail(email)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return serializeAssociateRow(row);
}

function serializeAssociateRow(row) {
  return {
    email: cleanEmail(row.email),
    role: String(row.role || 'associate').trim().toLowerCase(),
    displayName: String(row.display_name || '').trim(),
    sharePct: Number(row.share_pct),
    royaltyPct: Number(row.royalty_pct),
    windowStart: row.window_start instanceof Date ? row.window_start.toISOString() : String(row.window_start || ''),
    windowEnd: row.window_end instanceof Date ? row.window_end.toISOString() : String(row.window_end || ''),
    active: row.active === true,
    city: String(row.city || '').trim(),
  };
}

async function associateRowsAll() {
  const result = await marketplaceQuery(
    `
      select email, role, display_name, share_pct, royalty_pct,
             window_start, window_end, active, city
      from public.marketplace_associates
      order by active desc, lower(coalesce(display_name, email)), email
    `,
  );
  return result.rows.map(serializeAssociateRow);
}

/** Same admin signal the SPA derives from the users/{uid} profile (auth.jsx). */
async function callerIsAdmin(firestore, decoded) {
  if (decoded?.admin === true) return true;
  const uid = String(decoded?.uid || '').trim();
  if (!uid) return false;
  try {
    const doc = await firestore.collection('users').doc(uid).get();
    const profile = doc.data() || {};
    if (profile.admin === true || profile.isAdmin === true) return true;
    if (String(profile.role || '').trim().toLowerCase() === 'admin') return true;
    const roles = Array.isArray(profile.roles)
      ? profile.roles
      : typeof profile.roles === 'string'
        ? profile.roles.split(',')
        : [];
    return roles.map((role) => String(role || '').trim().toLowerCase()).includes('admin');
  } catch (error) {
    console.warn('marketplace-associate admin lookup failed', error.message);
    return false;
  }
}

/** True when the order's money actually moved (paid, escrowed, or released). */
function orderIsPaidish(data) {
  const paymentStatus = String(data?.paymentStatus || data?.status || '').toLowerCase();
  const status = String(data?.status || '').toLowerCase();
  if (DEAD_STATUSES.has(status) || DEAD_STATUSES.has(paymentStatus)) return false;
  return PAID_STATUSES.has(paymentStatus) || PAID_STATUSES.has(status);
}

function isEurOrder(data) {
  return String(data?.currency || '').toUpperCase() === 'EUR'
    || String(data?.paymentMethod || '').toLowerCase() === 'stripe'
    || numberValue(data?.totalEURCents) > 0;
}

/** Card subtotal for the royalty base, netted by refunds when present. */
function orderSubtotal(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const eur = isEurOrder(data);
  let subtotal = 0;
  if (eur) {
    subtotal = numberValue(data?.itemsSubtotalCents);
    if (!subtotal) {
      for (const item of items) {
        subtotal += numberValue(item?.totalPriceEURCents)
          || numberValue(item?.unitPriceEURCents) * Math.max(1, numberValue(item?.quantity));
      }
    }
  } else {
    subtotal = numberValue(data?.subtotalPkn);
    if (!subtotal) {
      for (const item of items) {
        subtotal += numberValue(item?.totalPricePkn)
          || numberValue(item?.unitPricePkn) * Math.max(1, numberValue(item?.quantity));
      }
    }
  }
  const total = eur ? numberValue(data?.totalEURCents) : numberValue(data?.totalPkn);
  const refunded = numberValue(data?.refundedTotal);
  if (total > 0 && refunded > 0) {
    if (refunded >= total) return 0;
    subtotal *= 1 - refunded / total;
  }
  return Math.max(0, subtotal);
}

function shipmentSellerCountries(data) {
  const out = new Map();
  for (const shipment of Array.isArray(data?.shipments) ? data.shipments : []) {
    const sellerId = String(shipment?.sellerId || '').trim();
    const from = String(shipment?.fromCountry || '').trim().toUpperCase();
    if (sellerId && from && !out.has(sellerId)) out.set(sellerId, from);
  }
  return out;
}

function buyerCountryOf(data) {
  const direct = String(data?.shippingAddressCountryCode || '').trim().toUpperCase();
  if (direct) return direct;
  const tos = new Set();
  for (const shipment of Array.isArray(data?.shipments) ? data.shipments : []) {
    const to = String(shipment?.toCountry || '').trim().toUpperCase();
    if (to) tos.add(to);
  }
  return tos.size === 1 ? [...tos][0] : '';
}

function missingSellerUids(data, known) {
  const uids = new Set();
  for (const sellerUid of Array.isArray(data?.sellerUids) ? data.sellerUids : []) {
    const uid = String(sellerUid || '').trim();
    if (uid && !known.has(uid)) uids.add(uid);
  }
  return [...uids];
}

async function listingSellerCountries(uids) {
  const out = new Map();
  if (!uids.length) return out;
  const result = await marketplaceQuery(
    `
      select distinct on (seller_uid) seller_uid, seller_country
      from public.marketplace_user_listings
      where seller_uid = any($1::text[])
        and coalesce(btrim(seller_country), '') <> ''
      order by seller_uid, updated_at desc nulls last, created_at desc nulls last
    `,
    [uids],
  );
  for (const row of result.rows) {
    const country = String(row.seller_country || '').trim().toUpperCase().slice(0, 2);
    if (row.seller_uid && country) out.set(String(row.seller_uid), country);
  }
  return out;
}

/**
 * Classify one order against the IT→IT rule. Returns null for orders that
 * never count (unpaid), else { qualifying, unverified, volume, currency }.
 */
function classifyOrder(data, sellerCountries) {
  if (!orderIsPaidish(data)) return null;
  const shipments = shipmentSellerCountries(data);
  const buyerCountry = buyerCountryOf(data);
  const sellerUids = (Array.isArray(data?.sellerUids) ? data.sellerUids : [])
    .map((uid) => String(uid || '').trim()).filter(Boolean);
  const sellerSet = sellerUids.length
    ? sellerUids
    : [...new Set((Array.isArray(data?.items) ? data.items : [])
      .map((item) => String(item?.sellerUid || '').trim()).filter(Boolean))];

  const countries = sellerSet.map((uid) => sellerCountries.get(uid) || shipments.get(uid) || '');
  const sellerMissing = countries.some((country) => !country);
  const sellerItalian = countries.length > 0 && countries.every((country) => country === QUALIFYING_COUNTRY);
  const volume = orderSubtotal(data);
  const currency = isEurOrder(data) ? 'EUR' : 'PKN';

  // Fully refunded orders net to zero volume — no commission, no accrual.
  if (volume <= 0) {
    return { qualifying: false, unverified: false, volume, currency };
  }
  if (buyerCountry === QUALIFYING_COUNTRY && sellerItalian) {
    return { qualifying: true, unverified: false, volume, currency };
  }
  if (buyerCountry === QUALIFYING_COUNTRY && !sellerMissing && !sellerItalian) {
    return { qualifying: false, unverified: false, volume, currency };
  }
  if (buyerCountry && !sellerMissing) {
    return { qualifying: false, unverified: false, volume, currency };
  }
  return { qualifying: false, unverified: true, volume, currency };
}

function blankTotals() {
  return { gross: 0, royalty: 0, earning: 0, orders: 0 };
}

function emptyEarnings() {
  return {
    qualifyingOrders: 0,
    unverifiedOrders: 0,
    grossPkn: 0,
    royaltyPkn: 0,
    earningPkn: 0,
    grossEurCents: 0,
    royaltyEurCents: 0,
    earningEurCents: 0,
    daily: [],
    orders: [],
  };
}

/**
 * Fold classified orders into the campaign aggregate. `classify` returns the
 * classifyOrder shape plus `data`, `id`, and `createdAtMillis`.
 */
function summarizeOrders(entries, { royaltyPct, sharePct }) {
  const earnings = emptyEarnings();
  const daily = new Map();
  const recent = [];

  for (const entry of entries) {
    const verdict = classifyOrder(entry.data, entry.sellerCountries);
    if (!verdict) continue;
    if (verdict.unverified) earnings.unverifiedOrders += 1;
    if (!verdict.qualifying) continue;

    const royalty = round2(verdict.volume * (royaltyPct / 100));
    const share = round2(royalty * (sharePct / 100));
    const key = verdict.currency === 'EUR' ? 'eur' : 'pkn';
    const totals = key === 'eur'
      ? { gross: earnings.grossEurCents, royalty: earnings.royaltyEurCents, earning: earnings.earningEurCents }
      : { gross: earnings.grossPkn, royalty: earnings.royaltyPkn, earning: earnings.earningPkn };

    // EUR totals are integer cents; PKN carries two decimals.
    const fixed = key === 'eur'
      ? { gross: Math.round(verdict.volume), royalty: Math.round(royalty), earning: Math.round(share) }
      : { gross: round2(verdict.volume), royalty, earning: share };

    totals.gross = round2(totals.gross + fixed.gross);
    totals.royalty = round2(totals.royalty + fixed.royalty);
    totals.earning = round2(totals.earning + fixed.earning);
    earnings.qualifyingOrders += 1;
    if (key === 'eur') {
      earnings.grossEurCents = totals.gross;
      earnings.royaltyEurCents = totals.royalty;
      earnings.earningEurCents = totals.earning;
    } else {
      earnings.grossPkn = totals.gross;
      earnings.royaltyPkn = totals.royalty;
      earnings.earningPkn = totals.earning;
    }

    const day = utcDayKey(entry.createdAtMillis);
    if (!daily.has(day)) daily.set(day, { date: day, orders: 0, earningPkn: 0, earningEurCents: 0 });
    const bucket = daily.get(day);
    bucket.orders += 1;
    if (key === 'eur') bucket.earningEurCents = Math.round(bucket.earningEurCents + fixed.earning);
    else bucket.earningPkn = round2(bucket.earningPkn + fixed.earning);

    const data = entry.data;
    recent.push({
      orderId: String(entry.id || ''),
      date: day,
      buyer: maskEmail(data?.buyerEmail),
      sellers: (Array.isArray(data?.sellerUids) ? data.sellerUids : []).length
        || (Array.isArray(data?.items) ? data.items : []).length
        || 1,
      currency: verdict.currency,
      gross: fixed.gross,
      royalty: fixed.royalty,
      earning: fixed.earning,
    });
  }

  earnings.daily = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  earnings.orders = recent
    .sort((a, b) => b.date.localeCompare(a.date) || b.orderId.localeCompare(a.orderId))
    .slice(0, RECENT_MAX);
  return earnings;
}

async function loadWindowOrders(firestore, windowStartIso, windowEndIso, { nowMs } = {}) {
  const start = new Date(windowStartIso);
  const end = new Date(windowEndIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    const error = new Error('Associate campaign window is invalid.');
    error.statusCode = 500;
    throw error;
  }
  const now = nowMs || Date.now();
  const snap = await firestore
    .collection('orders')
    .where('createdAt', '>=', start)
    .where('createdAt', '<=', end)
    .orderBy('createdAt', 'desc')
    .limit(ORDER_SCAN_MAX)
    .get();
  const entries = [];
  const needsLookup = new Set();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const sellerCountries = shipmentSellerCountries(data);
    for (const uid of missingSellerUids(data, sellerCountries)) {
      needsLookup.add(uid);
    }
    entries.push({
      id: doc.id,
      data,
      sellerCountries,
      createdAtMillis: tsToMillis(data.createdAt) || now,
    });
  }
  const fromListings = await listingSellerCountries([...needsLookup]);
  if (fromListings.size) {
    for (const entry of entries) {
      entry.sellerCountries = new Map([...entry.sellerCountries, ...fromListings]);
    }
  }
  return entries;
}

function windowProgress(windowStartIso, windowEndIso, nowMs) {
  const start = new Date(windowStartIso).getTime();
  const end = new Date(windowEndIso).getTime();
  const now = nowMs || Date.now();
  const daysTotal = Math.max(1, Math.round((end - start) / 86400000));
  const clamped = Math.min(Math.max(now, start), end);
  const daysElapsed = Math.min(daysTotal, Math.max(0, Math.round((clamped - start) / 86400000)));
  const daysRemaining = Math.max(0, Math.round((end - clamped) / 86400000));
  return { start: windowStartIso, end: windowEndIso, daysTotal, daysElapsed, daysRemaining, live: now >= start && now <= end };
}

async function readAssociateForClient(firestore, associate, options = {}) {
  const now = options.nowMs || Date.now();
  const progress = windowProgress(associate.windowStart, associate.windowEnd, now);
  let earnings = emptyEarnings();
  if (associate.active && progress.start && progress.end) {
    const entries = await loadWindowOrders(firestore, associate.windowStart, associate.windowEnd, { nowMs: now });
    earnings = summarizeOrders(entries, { royaltyPct: associate.royaltyPct, sharePct: associate.sharePct });
  }
  return { associate, window: progress, earnings };
}

/**
 * Admin overview: every roster row with its live earnings. Orders are loaded
 * once per distinct campaign window and summarized per associate terms.
 */
async function overviewForAdmin(firestore, { nowMs } = {}) {
  const rows = await associateRowsAll();
  const now = nowMs || Date.now();
  const entriesByWindow = new Map();
  const overview = [];
  for (const associate of rows) {
    const windowKey = `${associate.windowStart}|${associate.windowEnd}`;
    if (!entriesByWindow.has(windowKey)) {
      entriesByWindow.set(windowKey, associate.active
        ? await loadWindowOrders(firestore, associate.windowStart, associate.windowEnd, { nowMs: now })
        : []);
    }
    let earnings = emptyEarnings();
    if (associate.active) {
      earnings = summarizeOrders(entriesByWindow.get(windowKey), {
        royaltyPct: associate.royaltyPct,
        sharePct: associate.sharePct,
      });
    }
    overview.push({
      associate,
      window: windowProgress(associate.windowStart, associate.windowEnd, now),
      earnings,
    });
  }
  return overview;
}

/**
 * Handler payload: the caller's own desk when they are on the roster, plus the
 * full associates overview for admins. Admin-only callers get overview alone.
 */
async function readAssociatePayload(firestore, decoded, options = {}) {
  const now = options.nowMs || Date.now();
  const admin = await callerIsAdmin(firestore, decoded);
  const email = cleanEmail(decoded?.email);
  const associate = email ? await associateRowForEmail(email) : null;
  if (!associate && !admin) {
    const error = new Error('Not a Pokoin associate.');
    error.statusCode = 403;
    throw error;
  }
  const payload = { associate: null, window: null, earnings: emptyEarnings() };
  if (associate) {
    const own = await readAssociateForClient(firestore, associate, { nowMs: now });
    payload.associate = own.associate;
    payload.window = own.window;
    payload.earnings = own.earnings;
  }
  if (admin) {
    payload.admin = true;
    payload.overview = await overviewForAdmin(firestore, { nowMs: now });
  }
  return payload;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'GET only.' });
  }
  try {
    const decoded = await verifyBearerToken(req);
    const firestore = getFirebaseAdmin().firestore();
    const payload = await readAssociatePayload(firestore, decoded);
    return jsonPrivate(res, payload);
  } catch (error) {
    if (error.statusCode === 403) {
      return res.status(403).json({ error: error.message, associate: null });
    }
    if (error.statusCode === 401
      || String(error.code || '').startsWith('auth/')
      || /bearer|id token|authentication/i.test(String(error.message || ''))) {
      const auth = authErrorResponse(error);
      return res.status(auth.statusCode).json(auth.body);
    }
    console.error('marketplace-associate failed', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Associate desk failed.',
    });
  }
};

module.exports.readAssociateForClient = readAssociateForClient;
module.exports.readAssociatePayload = readAssociatePayload;
module.exports._test = {
  associateRowForEmail,
  associateRowsAll,
  callerIsAdmin,
  classifyOrder,
  orderIsPaidish,
  orderSubtotal,
  summarizeOrders,
  windowProgress,
  maskEmail,
  tsToMillis,
  listingSellerCountries,
  loadWindowOrders,
  overviewForAdmin,
};
