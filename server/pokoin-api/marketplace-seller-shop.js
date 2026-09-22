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
  return /^[\p{L}\p{N} .'_-]{3,64}$/u.test(text) && /\p{L}/u.test(text) ? text : '';
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
  const c = String(code || '').toUpperCase();
  if (!c) return null;
  if (c === 'NM' || c.includes('NEAR')) return { op: 'ilike', value: '%near%' };
  if (c === 'SP' || c.includes('SLIGHT')) return { op: 'ilike', value: '%slight%' };
  if (c === 'MP' || c.includes('MODERATE')) return { op: 'ilike', value: '%moderate%' };
  if (c === 'PL' || c === 'PLAYED') return { op: 'ilike', value: '%played%' };
  if (c.includes('POOR')) return { op: 'ilike', value: '%poor%' };
  return { op: 'ilike', value: `%${c}%` };
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

async function sellerProfileForUsername(username) {
  const clean = cleanUsername(username);
  if (!clean) {
    const error = new Error('Seller username is invalid.');
    error.statusCode = 400;
    throw error;
  }

  let uid = await sellerUidFromListingName(clean);
  let displayName = '';

  if (!uid) {
    const admin = getFirebaseAdmin();
    const firestore = admin.firestore();
    const usernameDoc = await firestore.collection('usernames').doc(clean).get();
    const usernameData = usernameDoc.data() || {};
    uid = cleanText(usernameData.uid, 160);
    displayName = cleanText(usernameData.displayName, 120);

    if (!uid) {
      const users = await firestore
        .collection('users')
        .where('usernameLower', '==', clean)
        .limit(1)
        .get();
      const userDoc = users.docs?.[0];
      const userData = userDoc?.data?.() || {};
      uid = cleanText(userData.uid || userDoc?.id, 160);
      displayName = cleanText(userData.displayName, 120);
    }
  }

  if (!uid) {
    const error = new Error('Seller not found.');
    error.statusCode = 404;
    throw error;
  }

  return { uid, username: clean, displayName };
}

function listingRow(row) {
  return {
    id: row.id,
    cardId: row.card_id,
    sellerUid: row.seller_uid,
    sellerName: cleanText(row.seller_name, 120) || 'Pokoin seller',
    sellerDisplayName: cleanText(row.seller_name, 120) || 'Pokoin seller',
    sellerUsername: cleanText(row.seller_name, 120),
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
  if (cond) {
    values.push(cond.value);
    where.push(`lower(coalesce(condition, '')) like $${values.length}`);
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
    listings: result.rows.map(listingRow),
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
};
