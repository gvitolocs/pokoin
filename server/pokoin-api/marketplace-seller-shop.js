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

function parseGameFromRequest(...args) {
  return require('./_marketplace_game').parseGameFromRequest(...args);
}

function runWithGame(...args) {
  return require('./_marketplace_game').runWithGame(...args);
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
  const raw = cleanText(code, 40).toUpperCase();
  if (!raw) return null;
  const map = {
    NM: ['NM', 'M'],
    M: ['NM', 'M'],
    SP: ['SP', 'LP'],
    LP: ['SP', 'LP'],
    MP: ['MP'],
    PL: ['PL', 'HP'],
    HP: ['PL', 'HP'],
    POOR: ['PO', 'POOR', 'D', 'DMG'],
    PO: ['PO', 'POOR', 'D', 'DMG'],
    D: ['PO', 'POOR', 'D', 'DMG'],
    DMG: ['PO', 'POOR', 'D', 'DMG'],
  };
  const codes = map[raw === 'POOR' ? 'POOR' : raw] || map[raw];
  return codes ? { codes } : null;
}

/** Query flag: reverse=1 / firstEdition=1 means require that trait. */
function truthyFlag(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Rarity filter against listing foil_state and catalog rarity on
 * marketplace_search_candidates (listings do not store rarity text).
 * Returns { sql, push(values) } or null.
 */
function raritySql(key) {
  const rarity = cleanText(key, 40).toLowerCase();
  if (!rarity) return null;

  function catalogMatch(likePatterns, { exclude = [] } = {}) {
    return {
      apply(where, values) {
        const likes = [];
        for (const pattern of likePatterns) {
          values.push(pattern);
          likes.push(`lower(coalesce(c.rarity, '')) like $${values.length}`);
        }
        const nots = [];
        for (const pattern of exclude) {
          values.push(pattern);
          nots.push(`lower(coalesce(c.rarity, '')) not like $${values.length}`);
        }
        const body = [...likes, ...nots].join(' and ');
        where.push(`exists (
          select 1
          from public.marketplace_search_candidates c
          where c.card_id::text = marketplace_user_listings.card_id
            and (${body})
        )`);
      },
    };
  }

  if (rarity === 'holo') {
    return {
      apply(where, values) {
        values.push('%holo%');
        values.push('%holofoil%');
        where.push(`(
          lower(coalesce(foil_state, '')) in ('holo', 'holofoil')
          or exists (
            select 1
            from public.marketplace_search_candidates c
            where c.card_id::text = marketplace_user_listings.card_id
              and (
                lower(coalesce(c.rarity, '')) like $${values.length - 1}
                or lower(coalesce(c.rarity, '')) like $${values.length}
              )
          )
        )`);
      },
    };
  }
  if (rarity === 'common') {
    return catalogMatch(['%common%'], { exclude: ['%uncommon%'] });
  }
  if (rarity === 'uncommon') {
    return catalogMatch(['%uncommon%']);
  }
  if (rarity === 'rare') {
    return catalogMatch(['%rare%'], {
      exclude: ['%ultra%', '%secret%', '%illustration%', '%amazing%', '%uncommon%'],
    });
  }
  if (rarity === 'ultra') {
    return catalogMatch(['%ultra%']);
  }
  if (rarity === 'illustration') {
    return catalogMatch(['%illustration%']);
  }
  if (rarity === 'secret') {
    return catalogMatch(['%secret%']);
  }
  return null;
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

/**
 * Associates roster membership for the profile badge: seller uid → auth email
 * → roster row. Never exposes the email — the caller gets role + name only.
 */
async function associateBadgeForUid(uid) {
  const id = cleanText(uid, 160);
  if (!id) return null;
  try {
    const user = await getFirebaseAdmin().auth().getUser(id);
    const email = cleanText(user.email, 320).toLowerCase();
    if (!email) return null;
    const result = await marketplaceQuery(
      `
        select role, display_name
        from public.marketplace_associates
        where lower(btrim(email)) = $1
          and active
        limit 1
      `,
      [email],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      role: String(row.role || 'associate').trim().toLowerCase(),
      displayName: String(row.display_name || '').trim(),
    };
  } catch (error) {
    console.warn('seller shop associate lookup failed', error.message);
    return null;
  }
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
  // false = card payments only (Profile → "Get paid in PKN" off).
  return { ...seller, acceptsPkn: data.acceptsPkn !== false };
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
    sellerAcceptsPkn: seller.acceptsPkn !== false,
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
    photoUrls: Array.isArray(row.photo_urls) ? row.photo_urls.filter((url) => typeof url === 'string').slice(0, 2) : [],
    setName: row.set_name,
    collectorNumber: row.collector_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function sellerCardIdsForGame(sellerUid, game, {
  query = marketplaceQuery,
  run = withGameContext,
} = {}) {
  // Shared listings live in the pokemon DB; intersect with the selected
  // catalog so Pokemon shops never show satellite TCG rows (and vice versa).
  const catalogGame = game || 'pokemon';
  const listed = await run('pokemon', () => query(
    `
      select distinct card_id
      from public.marketplace_user_listings
      where seller_uid = $1
        and status = 'active'
        and quantity_available > 0
        and nullif(card_id, '') is not null
    `,
    [sellerUid],
  ));
  const ids = listed.rows.map((row) => cleanText(row.card_id, 80)).filter(Boolean);
  if (!ids.length) return [];
  const catalog = await run(catalogGame, () => query(
    `
      select card_id::text as card_id
      from public.marketplace_search_candidates
      where card_id::text = any($1::text[])
    `,
    [ids],
  ));
  return catalog.rows.map((row) => cleanText(row.card_id, 80)).filter(Boolean);
}

async function readSellerShopData(url, game) {
  const sellerUsername = cleanText(url.searchParams.get('sellerUsername'), 64);
  if (!sellerUsername) {
    const error = new Error('sellerUsername is required.');
    error.statusCode = 400;
    throw error;
  }

  const seller = await withGameContext('pokemon', () => sellerProfileForUsername(sellerUsername));
  const limit = cleanLimit(url.searchParams.get('limit'));
  const offset = cleanOffset(url.searchParams.get('offset'));
  const q = cleanText(url.searchParams.get('q') || url.searchParams.get('query'), 120).toLowerCase();
  const condition = cleanText(url.searchParams.get('condition'), 40);
  const language = cleanText(url.searchParams.get('language'), 10).toUpperCase();
  const sort = cleanText(url.searchParams.get('sort'), 40);
  const rarity = cleanText(url.searchParams.get('rarity'), 40);
  const reverseOnly = truthyFlag(url.searchParams.get('reverse'));
  const firstEditionOnly = truthyFlag(url.searchParams.get('firstEdition'));

  const values = [seller.uid];
  const where = [
    'seller_uid = $1',
    "status = 'active'",
    'quantity_available > 0',
  ];

  // Pokemon listings + catalog share one DB. Prefer an EXISTS filter so large
  // shops (thousands of SKUs) do not round-trip every distinct card_id through
  // Node just to page 100 rows. Satellite TCGs still need the id intersect.
  const catalogGame = game || 'pokemon';
  if (catalogGame === 'pokemon') {
    where.push(`exists (
      select 1
      from public.marketplace_search_candidates c
      where c.card_id::text = marketplace_user_listings.card_id
    )`);
  } else {
    const gameCardIds = await sellerCardIdsForGame(seller.uid, catalogGame);
    values.push(gameCardIds);
    where.push(`card_id = any($${values.length}::text[])`);
  }

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

  if (reverseOnly) {
    where.push('reverse = true');
  }
  if (firstEditionOnly) {
    where.push('first_edition = true');
  }

  const rarityFilter = raritySql(rarity);
  if (rarityFilter) {
    rarityFilter.apply(where, values);
  }

  const whereSql = where.join(' and ');

  const totals = await withGameContext('pokemon', () => marketplaceQuery(
    `
      select
        count(*)::int as total,
        count(distinct nullif(card_id, ''))::int as unique_cards
      from public.marketplace_user_listings
      where ${whereSql}
    `,
    values,
  ));
  const total = Number(totals.rows[0]?.total || 0);
  const unique = Number(totals.rows[0]?.unique_cards || 0);

  const pageValues = [...values, limit, offset];
  const result = await withGameContext('pokemon', () => marketplaceQuery(
    `
      select *
      from public.marketplace_user_listings
      where ${whereSql}
      order by ${sortSql(sort)}
      limit $${pageValues.length - 1}
      offset $${pageValues.length}
    `,
    pageValues,
  ));

  return {
    game,
    seller: {
      uid: seller.uid,
      username: seller.username,
      displayName: seller.displayName || seller.username,
      associate: await associateBadgeForUid(seller.uid),
      acceptsPkn: seller.acceptsPkn !== false,
    },
    listings: result.rows.map((row) => listingRow(row, seller)),
    total,
    unique,
    limit,
    offset,
  };
}

function withGameContext(game, fn, runner = runWithGame) {
  return runner(game, fn);
}

async function readSellerShop(url, game = 'pokemon') {
  return readSellerShopData(url, game);
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
    const game = parseGameFromRequest(req);
    const payload = await readSellerShop(url, game);
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
  raritySql,
  truthyFlag,
  sortSql,
  shopSellerFromProfile,
  listingRow,
  sellerCardIdsForGame,
  withGameContext,
};
