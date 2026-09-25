'use strict';

/**
 * Public seller shop page — server-backed totals + offset pagination.
 *
 * Overlay onto Pi /srv/pokoin/api/current/api/. Sibling requires come from the
 * live release base (_marketplace_db, _firebase). Deploy after merge with
 * scripts/deploy-seller-shop-api.sh. Does not change marketplace-listings
 * defaults used by the card desk / dashboard.
 */

function marketplaceQuery(...args) {
  return require('./_marketplace_db').marketplaceQuery(...args);
}

function getFirebaseAdmin(...args) {
  return require('./_firebase').getFirebaseAdmin(...args);
}

const PAGE_DEFAULT = 100;
const PAGE_MAX = 100;

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanUsername(value) {
  const text = cleanText(value, 64).toLowerCase();
  return /^[\p{L}\p{N} .'_@+-]{3,64}$/u.test(text) && /\p{L}/u.test(text) ? text : '';
}

function currentHandle(value) {
  const handle = String(value || '').trim().toLowerCase();
  return /^[a-z0-9]{3,32}$/.test(handle) ? handle : '';
}

function cleanLimit(value, fallback = PAGE_DEFAULT) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), PAGE_MAX);
}

function cleanOffset(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

function conditionSql(code) {
  // Listings store short codes (NM/LP/MP/HP/PO). UI filters use Pokoin chips
  // (NM/SP/MP/PL/Poor); LP displays as SP and HP as PL.
  const c = String(code || '').toUpperCase().replace(/\s+/g, '');
  if (!c) return null;
  if (c === 'NM' || c === 'M' || c.includes('NEAR')) return { codes: ['NM', 'M'] };
  if (c === 'SP' || c === 'LP' || c.includes('SLIGHT') || c.includes('LIGHT')) {
    return { codes: ['SP', 'LP'] };
  }
  if (c === 'MP' || c.includes('MODERATE')) return { codes: ['MP'] };
  if (c === 'PL' || c === 'HP' || c === 'PLAYED' || c.includes('HEAVY')) {
    return { codes: ['PL', 'HP'] };
  }
  if (c === 'PO' || c.includes('POOR') || c === 'D' || c === 'DMG' || c.includes('DAMAGE')) {
    return { codes: ['PO', 'POOR', 'D', 'DMG'] };
  }
  return { codes: [c] };
}

function sortSql(sort) {
  switch (String(sort || '').toLowerCase()) {
    case 'price-desc':
      return 'price_pkn desc nulls last, updated_at desc, created_at desc';
    case 'qty':
      return 'quantity_available desc nulls last, price_pkn asc, updated_at desc';
    case 'name':
      return 'lower(coalesce(card_name, \'\')) asc, price_pkn asc';
    case 'price-asc':
    default:
      return 'price_pkn asc nulls last, updated_at desc, created_at desc';
  }
}

async function sellerUidFromListingName(username) {
  const result = await marketplaceQuery(
    `
      select seller_uid
      from public.marketplace_user_listings
      where lower(btrim(seller_name)) = $1
        and seller_uid is not null
        and btrim(seller_uid) <> ''
      order by updated_at desc nulls last, created_at desc nulls last
      limit 1
    `,
    [username],
  ).catch(() => ({ rows: [] }));
  return cleanText(result.rows[0]?.seller_uid, 160);
}

function shopSellerFromProfile({ uid, profile = {}, queried = '', via = '' }) {
  const handle = currentHandle(profile.username);
  const asked = currentHandle(queried);
  if (via === 'listing-name' && handle && handle !== asked) return null;
  const username = handle || asked;
  const rawName = cleanText(profile.displayName, 120);
  const displayName = rawName && !rawName.includes('@') ? rawName : username;
  return { uid, username, displayName };
}

async function registeredSeller(firestore, username) {
  const usernameDoc = await firestore.collection('usernames').doc(username).get();
  const fromRegistry = cleanText(usernameDoc.data()?.uid, 160);
  if (fromRegistry) return fromRegistry;
  const users = await firestore.collection('users').where('usernameLower', '==', username).limit(1).get();
  const userDoc = users.docs?.[0];
  return cleanText(userDoc?.data?.()?.uid || userDoc?.id, 160);
}

async function sellerProfileForUsername(username) {
  const clean = cleanUsername(username);
  if (!clean) {
    const error = new Error('Seller username is invalid.');
    error.statusCode = 400;
    throw error;
  }

  const admin = getFirebaseAdmin();
  const firestore = admin.firestore();
  let via = 'firebase';
  let uid = await registeredSeller(firestore, clean);
  if (!uid) {
    uid = await sellerUidFromListingName(clean);
    via = 'listing-name';
  }
  if (!uid) {
    const error = new Error('Seller not found.');
    error.statusCode = 404;
    throw error;
  }

  const userDoc = await firestore.collection('users').doc(uid).get();
  const data = userDoc.data() || {};
  const seller = shopSellerFromProfile({
    uid,
    queried: clean,
    via,
    profile: {
      username: data.username || data.usernameLower || '',
      displayName: data.displayName || '',
    },
  });
  if (!seller) {
    const error = new Error('Seller not found.');
    error.statusCode = 404;
    throw error;
  }
  return seller;
}

function listingRow(row, seller = {}) {
  const username = currentHandle(seller.username);
  const rawName = cleanText(seller.displayName, 120);
  const displayName = rawName && !rawName.includes('@') ? rawName : (username || 'Pokoin seller');
  return {
    id: row.id,
    cardId: row.card_id,
    sellerUid: cleanText(row.seller_uid, 160) || seller.uid || '',
    sellerName: displayName,
    sellerDisplayName: displayName,
    sellerUsername: username,
    sellerCountry: row.seller_country,
    sellerReputationLabel: row.seller_reputation_label,
    condition: row.condition,
    language: row.language,
    pricePkn: Number(row.price_pkn || 0),
    quantityAvailable: Number(row.quantity_available || 0),
    signed: row.signed === true,
    reverse: row.reverse === true,
    firstEdition: row.first_edition === true,
    altered: row.altered === true,
    foilState: row.foil_state || 'standard',
    variantState: row.variant_state || '',
    sealed: row.sealed === true,
    graded: row.graded === true,
    shippingAvailable: row.shipping_available !== false,
    reserveAvailable: row.reserve_available === true,
    nftAvailable: row.nft_available === true,
    status: row.status,
    cardName: row.card_name,
    cardImageUrl: row.card_image_url,
    setName: row.set_name,
    collectorNumber: row.collector_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readSellerShop(url) {
  const sellerUsername = cleanText(url.searchParams.get('sellerUsername'), 64);
  if (!sellerUsername) {
    const error = new Error('sellerUsername is required.');
    error.statusCode = 400;
    throw error;
  }

  const seller = await sellerProfileForUsername(sellerUsername);
  const limit = cleanLimit(url.searchParams.get('limit'));
  const offset = cleanOffset(url.searchParams.get('offset'));
  const q = cleanText(url.searchParams.get('q') || url.searchParams.get('query'), 120).toLowerCase();
  const condition = cleanText(url.searchParams.get('condition'), 40);
  const language = cleanText(url.searchParams.get('language'), 10).toUpperCase();
  const sort = cleanText(url.searchParams.get('sort'), 40);

  const values = [seller.uid];
  const where = [
    'seller_uid = $1',
    "status = 'active'",
    'quantity_available > 0',
  ];

  if (q) {
    values.push(`%${q}%`);
    where.push(`(
      lower(coalesce(card_name, '')) like $${values.length}
      or lower(coalesce(set_name, '')) like $${values.length}
      or lower(coalesce(collector_number, '')) like $${values.length}
    )`);
  }

  const cond = conditionSql(condition);
  if (cond?.codes?.length) {
    values.push(cond.codes);
    where.push(`upper(btrim(coalesce(condition, ''))) = any($${values.length}::text[])`);
  }

  if (language) {
    values.push(`${language}%`);
    where.push(`upper(coalesce(language, '')) like $${values.length}`);
  }

  const whereSql = where.join(' and ');

  const totals = await marketplaceQuery(
    `
      select
        count(*)::int as total,
        count(distinct nullif(card_id, ''))::int as unique_cards
      from public.marketplace_user_listings
      where ${whereSql}
    `,
    values,
  );
  const total = Number(totals.rows[0]?.total || 0);
  const unique = Number(totals.rows[0]?.unique_cards || 0);

  const pageValues = [...values, limit, offset];
  const result = await marketplaceQuery(
    `
      select *
      from public.marketplace_user_listings
      where ${whereSql}
      order by ${sortSql(sort)}
      limit $${pageValues.length - 1}
      offset $${pageValues.length}
    `,
    pageValues,
  );

  return {
    seller: {
      uid: seller.uid,
      username: seller.username,
      displayName: seller.displayName || seller.username,
    },
    listings: result.rows.map((row) => listingRow(row, seller)),
    total,
    unique,
    limit,
    offset,
  };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
    const payload = await readSellerShop(url);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(payload);
  } catch (error) {
    console.error('marketplace-seller-shop failed', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Seller shop failed.',
    });
  }
};

module.exports.readSellerShop = readSellerShop;
module.exports._test = {
  cleanLimit,
  cleanOffset,
  cleanUsername,
  conditionSql,
  sortSql,
  shopSellerFromProfile,
  listingRow,
};
