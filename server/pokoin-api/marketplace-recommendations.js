'use strict';

/**
 * Shared Pokoin API — personal card recommendations.
 *
 *   GET /api/marketplace-recommendations
 *       ?cart=<cardIds>&recent=<cardIds>&watch=<cardIds>&sellers=<uids>&listings=<listingIds>&limit=18
 *
 * Every rail holds only buyable cards (an active native listing) and carries
 * the offer to add, so "Add to cart" always works. Signed in (Bearer), the
 * server adds the account's own signals: synced cart, Recently Seen, Poko's
 * watchlist snapshot and paid orders; query ids from the browser are merged
 * in. Signed out, the query ids alone personalise it, and Trending covers a
 * brand-new visitor. Responses are private, never edge-cached.
 *
 * Rails: buy_again, parcel (one per seller in the cart — same parcel),
 * also_carted, inspired (species / name / same artwork), artists, trending,
 * watchlist, recent. Pokémon storefront only for now; other games get [] and
 * the SPA keeps its client-side rails.
 *
 * Canonical source for the Pi overlay — scripts/deploy-cart-api.sh.
 */

const { marketplaceQuery } = require('./_marketplace_db');
const { clientIp } = require('./_client_ip');
const { getFirebaseAdmin, requestHeader, verifyBearerToken } = require('./_firebase');
const { normalizeGame, parseGameFromRequest, runWithGame } = require('./_marketplace_game');
const { setCorsHeaders, toReactCard } = require('./_marketplace_react_card');
const { limitBestEffort } = require('./_rate_limit');
const { getPublicSellerProfiles } = require('./_seller_profile_cache');
const { readCart } = require('./_cart_store');
const {
  DEFAULT_LIMIT,
  boughtCardIds,
  buildAffinity,
  cardIdOf,
  joinLabels,
  parseIds,
  pickOffer,
  rankByAffinity,
  rankCoCarted,
  rankSellerShelf,
  rankTrending,
  topLabels,
} = require('./_recommend');

const POOL_TTL_MS = Number(process.env.POKOIN_RECOMMEND_POOL_TTL_MS || 3 * 60 * 1000);
const REQUESTS_PER_MINUTE = 60;
const MAX_SELLER_SHELVES = 2;

const LISTING_COLUMNS = `
  l.id::text as id, l.card_id::text as card_id, l.seller_uid, l.seller_name, l.seller_country,
  l.seller_reputation_label, l.condition, l.language, l.price_pkn, l.quantity_available,
  l.signed, l.reverse, l.first_edition, l.sealed, l.graded, l.grading_company, l.grade,
  l.reserve_available, l.nft_available, l.source, l.card_name, l.card_image_url,
  l.set_name, l.collector_number, l.marketplace_game`;

const BUYABLE = `
  l.status = 'active' and l.quantity_available > 0 and l.price_pkn > 0
  and l.shipping_available = true and l.card_id ~ '^[0-9]+$'
  and coalesce(nullif(l.marketplace_game, ''), 'pokemon') = 'pokemon'`;

const CARD_COLUMNS = `
  c.card_id::text as card_id, c.ct_id, c.name, c.set_name, c.expansion_name, c.card_number,
  c.rarity, c.rarity_kind, c.product_type, c.item_kind, c.image_url, c.cdn_image_url,
  c.homepage_image_url, c.artist, c.illustrator, c.pokedex_num, c.version, c.art_layout`;

function cors(res) {
  setCorsHeaders(res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-pokoin-game, x-pokoin-host, x-marketplace-game');
}

function sendPrivate(res, status, body) {
  cors(res);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(status).json(body);
}

function isMissingRelation(error) {
  return error?.code === '42P01' || /relation .* does not exist/i.test(String(error?.message || ''));
}

/** Pokémon DB for listings, catalog and every per-user table. */
function db(fn) {
  return runWithGame('pokemon', fn);
}

async function optionalUid(req) {
  if (!String(requestHeader(req, 'authorization') || '').startsWith('Bearer ')) return '';
  try {
    const decoded = await verifyBearerToken(req);
    return String(decoded?.uid || '').trim();
  } catch (_) {
    // A stale token still gets the signed-out recommendations.
    return '';
  }
}

// --- buyable pool: every card with an active native listing ----------------

let poolCache = { at: 0, cards: [], byId: new Map() };
let poolFlight = null;

async function queryPool() {
  const withExtras = `
    with listed as (
      select l.card_id::bigint as card_id, min(l.price_pkn) as min_price,
             count(*)::int as offer_count, sum(l.quantity_available)::int as stock
        from public.marketplace_user_listings l
       where ${BUYABLE}
       group by 1
    )
    select ${CARD_COLUMNS},
           listed.min_price, listed.offer_count, listed.stock,
           coalesce(h.hot_score_24h, 0) as hot_24h, coalesce(h.hot_score_7d, 0) as hot_7d,
           u.canonical_path
      from listed
      join public.marketplace_search_candidates c on c.card_id = listed.card_id
      left join public.marketplace_hot_blueprints h on h.blueprint_id = c.ct_id
      left join lateral (
        select canonical_path from public.marketplace_card_urls u
         where u.card_id = c.card_id and u.language = 'en'
         order by canonical_path limit 1
      ) u on true`;
  try {
    return (await marketplaceQuery(withExtras)).rows || [];
  } catch (error) {
    if (!isMissingRelation(error)) throw error;
    // Older replica without hot scores or card URLs: rank by catalog only.
    const plain = `
      select ${CARD_COLUMNS}, min(l.price_pkn) as min_price, count(*)::int as offer_count,
             sum(l.quantity_available)::int as stock, 0 as hot_24h, 0 as hot_7d, null as canonical_path
        from public.marketplace_user_listings l
        join public.marketplace_search_candidates c on c.card_id = l.card_id::bigint
       where ${BUYABLE}
       group by ${CARD_COLUMNS.replace(/\bas \w+/g, '')}`;
    return (await marketplaceQuery(plain)).rows || [];
  }
}

/** Shared per process for a few minutes; one query in flight at a time. */
async function loadPool(now = Date.now()) {
  if (poolCache.cards.length && now - poolCache.at < POOL_TTL_MS) return poolCache;
  if (!poolFlight) {
    poolFlight = db(queryPool)
      .then((rows) => {
        const cards = rows.map((row) => ({ ...row, card_id: cardIdOf(row) })).filter((row) => row.card_id);
        poolCache = { at: Date.now(), cards, byId: new Map(cards.map((card) => [card.card_id, card])) };
        return poolCache;
      })
      .finally(() => {
        poolFlight = null;
      });
  }
  try {
    return await poolFlight;
  } catch (error) {
    // Serve a stale pool rather than nothing when one refresh fails.
    if (poolCache.cards.length) return poolCache;
    throw error;
  }
}

// --- the account's own signals ----------------------------------------------

async function readRecentIds(uid) {
  try {
    const result = await marketplaceQuery(
      `select card_ids from public.marketplace_user_recents where user_uid = $1 and game = 'pokemon' limit 1`,
      [uid],
    );
    return parseIds(result.rows?.[0]?.card_ids || []);
  } catch (error) {
    if (isMissingRelation(error) || error?.code === '42703') return [];
    throw error;
  }
}

async function readWatchIds(uid) {
  try {
    const result = await marketplaceQuery(
      `select watchlist_card_ids from public.poko_user_personal_snapshot where firebase_uid = $1 limit 1`,
      [uid],
    );
    return parseIds(result.rows?.[0]?.watchlist_card_ids || []);
  } catch (error) {
    if (isMissingRelation(error)) return [];
    throw error;
  }
}

async function readBought(uid) {
  try {
    const snap = await getFirebaseAdmin().firestore().collection('orders').where('uid', '==', uid).limit(200).get();
    return boughtCardIds(snap.docs.map((doc) => doc.data()));
  } catch (error) {
    console.warn('marketplace-recommendations orders skipped', { message: error.message });
    return [];
  }
}

async function readAccountSignals(uid) {
  if (!uid) return { cart: null, recent: [], watch: [], bought: [] };
  const [cart, recent, watch, bought] = await Promise.all([
    db(() => readCart(marketplaceQuery, uid)).catch(() => null),
    db(() => readRecentIds(uid)).catch(() => []),
    db(() => readWatchIds(uid)).catch(() => []),
    readBought(uid),
  ]);
  return { cart, recent, watch, bought };
}

// --- per-request reads -------------------------------------------------------

async function readCards(ids) {
  if (!ids.length) return [];
  const result = await marketplaceQuery(
    `select ${CARD_COLUMNS}, u.canonical_path
       from public.marketplace_search_candidates c
       left join lateral (
         select canonical_path from public.marketplace_card_urls u
          where u.card_id = c.card_id and u.language = 'en'
          order by canonical_path limit 1
       ) u on true
      where c.card_id = any($1::bigint[])`,
    [ids.map(Number)],
  ).catch((error) => {
    if (isMissingRelation(error)) {
      return marketplaceQuery(
        `select ${CARD_COLUMNS} from public.marketplace_search_candidates c where c.card_id = any($1::bigint[])`,
        [ids.map(Number)],
      );
    }
    throw error;
  });
  return (result.rows || []).map((row) => ({ ...row, card_id: cardIdOf(row) }));
}

async function readOffers(cardIds) {
  if (!cardIds.length) return new Map();
  const result = await marketplaceQuery(
    `select ${LISTING_COLUMNS}
       from public.marketplace_user_listings l
      where l.card_id = any($1::text[]) and ${BUYABLE}
      order by l.card_id, l.price_pkn asc
      limit 4000`,
    [cardIds],
  );
  const byCard = new Map();
  for (const row of result.rows || []) {
    const list = byCard.get(row.card_id) || [];
    list.push(row);
    byCard.set(row.card_id, list);
  }
  return byCard;
}

/**
 * A seller's buyable catalog listings: this buyer's species, names and
 * artists first, then cheapest. Non-catalog rows never reach the shelf.
 */
async function readSellerListings(sellerUid, taste = {}) {
  const lower = (list) => [...new Set((list || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
  const result = await marketplaceQuery(
    `select ${LISTING_COLUMNS}
       from public.marketplace_user_listings l
       join public.marketplace_search_candidates c on c.card_id = l.card_id::bigint
      where l.seller_uid = $1 and ${BUYABLE}
      order by (
                 (case when lower(c.name) = any($3::text[]) then 4 else 0 end)
               + (case when c.pokedex_num = any($2::int[]) then 3 else 0 end)
               + (case when lower(c.set_name) = any($5::text[]) then 3 else 0 end)
               + (case when lower(l.language) = any($6::text[]) then 2 else 0 end)
               + (case when lower(l.condition) = any($7::text[]) then 1 else 0 end)
               + (case when lower(coalesce(nullif(c.artist, ''), c.illustrator, '')) = any($4::text[]) then 1 else 0 end)
               ) desc,
               l.price_pkn asc
      limit 600`,
    [
      sellerUid,
      (taste.species || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0 && n <= 1025),
      lower(taste.names),
      lower(taste.artists),
      lower(taste.sets),
      lower(taste.languages),
      lower(taste.conditions),
    ],
  );
  return result.rows || [];
}

/** The cart's own listings (any status): what each seller parcel already holds. */
async function readListingsById(ids) {
  const wanted = (ids || []).map((id) => String(id || '').trim()).filter((id) => id && id.length <= 80).slice(0, 400);
  if (!wanted.length) return [];
  const result = await marketplaceQuery(
    `select ${LISTING_COLUMNS} from public.marketplace_user_listings l where l.id::text = any($1::text[])`,
    [wanted],
  );
  return result.rows || [];
}

/** Card ids that sit in other buyers' carts next to these. */
async function readCoCarted(cardIds, uid) {
  if (!cardIds.length) return new Map();
  try {
    const result = await marketplaceQuery(
      `select id::text as card_id, count(*)::int as carts
         from public.marketplace_user_carts carts, unnest(carts.card_ids) as id
        where carts.card_ids && $1::bigint[]
          and carts.user_uid <> $2
          and carts.updated_at > now() - interval '120 days'
          and not (id = any($1::bigint[]))
        group by id
        order by carts desc
        limit 200`,
      [cardIds.map(Number), uid || ''],
    );
    return new Map((result.rows || []).map((row) => [String(row.card_id), Number(row.carts) || 0]));
  } catch (error) {
    if (isMissingRelation(error)) return new Map();
    throw error;
  }
}

// --- output ------------------------------------------------------------------

/** Seller labels are public: an email-like stored name is never sent. */
function publicName(value) {
  const name = String(value || '').trim();
  return name && !name.includes('@') ? name.slice(0, 120) : '';
}

function offerJson(row, profile) {
  const pricePkn = Number(row.price_pkn) || 0;
  const name = publicName(profile?.displayName) || publicName(row.seller_name);
  return {
    id: row.id,
    cardId: row.card_id,
    sellerUid: row.seller_uid,
    sellerName: name,
    sellerDisplayName: name,
    sellerUsername: publicName(profile?.username),
    sellerCountry: row.seller_country || '',
    sellerReputationLabel: row.seller_reputation_label || '',
    sellerAcceptsPkn: profile ? profile.acceptsPkn !== false : true,
    condition: row.condition || '',
    language: row.language || '',
    pricePkn,
    quantityAvailable: Number(row.quantity_available) || 0,
    signed: row.signed === true,
    reverse: row.reverse === true,
    firstEdition: row.first_edition === true,
    sealed: row.sealed === true,
    graded: row.graded === true,
    gradingCompany: row.grading_company || '',
    grade: row.grade || '',
    reserveAvailable: row.reserve_available === true,
    nftAvailable: row.nft_available === true,
    source: row.source || '',
    cardName: row.card_name || '',
    cardImageUrl: row.card_image_url || '',
    setName: row.set_name || '',
    collectorNumber: row.collector_number || '',
    marketplaceGame: row.marketplace_game || 'pokemon',
  };
}

function cardJson(card) {
  const price = Number(card.min_price);
  return toReactCard({
    ...card,
    lowest_price_pkn: Number.isFinite(price) && price > 0 ? price : null,
    canonical_path: card.canonical_path || '',
  });
}

function hasSignals(signals) {
  return Boolean(
    signals.cartIds.length || signals.recentIds.length || signals.watchIds.length || signals.bought.length,
  );
}

/**
 * Build every rail for one buyer. `io` is injectable for tests:
 * { loadPool, readCards, readOffers, readSellerListings, readCoCarted, sellerProfiles }.
 */
async function recommend(signals, io, { limit = DEFAULT_LIMIT } = {}) {
  const pool = await io.loadPool();
  const signalIds = [...new Set([
    ...signals.cartIds, ...signals.bought.map((row) => row.cardId), ...signals.watchIds, ...signals.recentIds,
  ])];
  const unlisted = signalIds.filter((id) => !pool.byId.has(id));
  const extra = new Map((await io.readCards(unlisted.slice(0, 120))).map((card) => [card.card_id, card]));
  const lookup = (id) => pool.byId.get(id) || extra.get(id) || null;

  const affinity = buildAffinity([
    ...signals.cartIds.map((id) => ({ card: lookup(id), source: 'cart' })),
    ...signals.bought.map((row) => ({ card: lookup(row.cardId), source: 'bought' })),
    ...signals.watchIds.map((id) => ({ card: lookup(id), source: 'watch' })),
    ...signals.recentIds.map((id) => ({ card: lookup(id), source: 'recent' })),
  ]);
  const seen = new Set(signalIds);
  const used = new Set();
  const rails = [];
  const pushRail = (rail) => {
    if (!rail.items.length) return;
    rail.items.forEach((item) => used.add(cardIdOf(item.card)));
    rails.push(rail);
  };
  const discovery = () => new Set([...seen, ...used]);

  // Buy it again: paid cards that are on sale again.
  pushRail({
    id: 'buy_again',
    kind: 'buy_again',
    title: 'Buy it again',
    items: signals.bought
      .filter((row) => pool.byId.has(row.cardId))
      .slice(0, limit)
      .map((row) => ({ card: pool.byId.get(row.cardId), reason: 'You bought this before', purchasedAt: row.purchasedAt })),
  });

  // Same parcel: more from each seller already in the cart, matched to the
  // cart lines from that seller (name, expansion, language, condition).
  const anchors = io.readListingsById
    ? await io.readListingsById(signals.listingIds).catch(() => [])
    : [];
  const sellerRails = await Promise.all(signals.sellerUids.slice(0, MAX_SELLER_SHELVES).map(async (sellerUid) => {
    const own = anchors.filter((row) => row.seller_uid === sellerUid);
    const ownCards = own.map((row) => pool.byId.get(String(row.card_id)) || {});
    const taste = {
      species: [...ownCards.map((card) => Number(card.pokedex_num)), ...affinity.species.keys()].slice(0, 40),
      names: [...own.map((row, at) => ownCards[at].name || row.card_name), ...[...affinity.names.values()].map((entry) => entry.label)].slice(0, 40),
      artists: [...affinity.artists.values()].map((entry) => entry.label).slice(0, 40),
      sets: own.map((row, at) => ownCards[at].set_name || row.set_name),
      languages: own.map((row) => row.language),
      conditions: own.map((row) => row.condition),
    };
    return {
      sellerUid,
      ranked: rankSellerShelf(await io.readSellerListings(sellerUid, taste), pool.byId, affinity, {
        excludeListings: new Set(signals.listingIds),
        excludeCards: new Set(signals.cartIds),
        anchors: own,
        limit,
      }),
    };
  }));
  for (const { sellerUid, ranked } of sellerRails) {
    pushRail({
      id: `parcel:${sellerUid}`,
      kind: 'parcel',
      sellerUid,
      title: 'More from this seller',
      subtitle: 'Ships in the same parcel as your other cards from them',
      items: ranked.map(({ card, offer, reason }) => ({ card, offer, reason })),
    });
  }

  // Customers who carried these also carried.
  if (signals.cartIds.length) {
    const counts = await io.readCoCarted(signals.cartIds, signals.uid);
    pushRail({
      id: 'also_carted',
      kind: 'also_carted',
      title: 'Customers who carried these also carried',
      items: rankCoCarted(pool.byId, counts, { exclude: discovery(), limit }),
    });
  }

  // Inspired by what this buyer looks at: same artwork, species, name.
  pushRail({
    id: 'inspired',
    kind: 'inspired',
    title: 'Inspired by your browsing history',
    subtitle: affinity.size ? `More ${joinLabels(topLabels(affinity.species))}`.trim() : '',
    items: rankByAffinity(pool.cards, affinity, {
      want: (matches) => matches.includes('version') || matches.includes('species') || matches.includes('name'),
      exclude: discovery(),
      limit,
    }),
  });

  // From artists this buyer keeps choosing.
  pushRail({
    id: 'artists',
    kind: 'artists',
    title: 'From artists you like',
    subtitle: affinity.size ? `Art by ${joinLabels(topLabels(affinity.artists))}` : '',
    items: rankByAffinity(pool.cards, affinity, {
      want: (matches) => matches.includes('artist'),
      exclude: discovery(),
      limit,
    }),
  });

  // Trending covers everyone, signed out and brand new included.
  pushRail({
    id: 'trending',
    kind: 'trending',
    title: 'Trending on Pokoin',
    subtitle: 'Most viewed and carted this week',
    items: rankTrending(pool.cards, affinity, { exclude: discovery(), limit }),
  });

  // The buyer's own lists, hydrated with live offers where one exists.
  const ownRail = (id, title, ids) => ({
    id,
    kind: id,
    title,
    items: ids.map(lookup).filter(Boolean).slice(0, 24).map((card) => ({ card, reason: '' })),
  });
  const watchRail = ownRail('watchlist', 'From your watchlist', signals.watchIds);
  const recentRail = ownRail('recent', 'Your recently viewed cards', signals.recentIds);
  if (watchRail.items.length) rails.push(watchRail);
  if (recentRail.items.length) rails.push(recentRail);

  // One offer per card (the cascade the cart uses), sellers labelled once.
  const needOffers = [...new Set(rails.flatMap((rail) => rail.items
    .filter((item) => !item.offer && pool.byId.has(cardIdOf(item.card)))
    .map((item) => cardIdOf(item.card))))];
  const offers = await io.readOffers(needOffers);
  for (const rail of rails) {
    for (const item of rail.items) {
      if (!item.offer) item.offer = pickOffer(offers.get(cardIdOf(item.card)) || []) || null;
    }
  }
  const sellerUids = [...new Set(rails.flatMap((rail) => [
    rail.sellerUid,
    ...rail.items.map((item) => item.offer?.seller_uid),
  ]).filter(Boolean))];
  const profiles = await io.sellerProfiles(sellerUids).catch(() => new Map());
  for (const rail of rails) {
    if (rail.kind === 'parcel') {
      const profile = profiles.get(rail.sellerUid);
      const sample = rail.items[0]?.offer;
      rail.sellerUsername = publicName(profile?.username);
      rail.sellerName = publicName(profile?.displayName) || publicName(sample?.seller_name);
      rail.sellerCountry = sample?.seller_country || '';
      const label = rail.sellerUsername || rail.sellerName;
      if (label) rail.title = `More from ${label}`;
    }
  }
  return rails.map((rail) => ({
    ...rail,
    items: rail.items.map((item) => ({
      card: cardJson(item.card),
      offer: item.offer ? offerJson(item.offer, profiles.get(item.offer.seller_uid)) : null,
      reason: item.reason || '',
      ...(item.purchasedAt ? { purchasedAt: item.purchasedAt } : {}),
    })),
  }));
}

function liveIo() {
  return {
    loadPool: () => loadPool(),
    readCards: (ids) => db(() => readCards(ids)),
    readOffers: (ids) => db(() => readOffers(ids)),
    readSellerListings: (uid, taste) => db(() => readSellerListings(uid, taste)),
    readListingsById: (ids) => db(() => readListingsById(ids)),
    readCoCarted: (ids, uid) => db(() => readCoCarted(ids, uid)),
    sellerProfiles: (uids) => getPublicSellerProfiles(uids),
  };
}

function signalsFrom(url, account, uid) {
  const cartRows = account.cart?.items || [];
  const savedRows = account.cart?.saved || [];
  const cartIds = parseIds([
    ...parseIds(url.searchParams.get('cart'), 40),
    ...cartRows.map((row) => row.cardId),
    ...savedRows.map((row) => row.cardId),
  ], 60);
  const sellerUids = [...new Set([
    ...String(url.searchParams.get('sellers') || '').split(',').map((value) => value.trim()),
    ...cartRows.filter((row) => row.selected !== false).map((row) => row.sellerUid),
  ].filter((value) => value && value.length <= 160))].slice(0, 6);
  const listingIds = [...new Set([
    ...String(url.searchParams.get('listings') || '').split(',').map((value) => value.trim()),
    ...cartRows.map((row) => row.listingId),
  ].filter((value) => value && value.length <= 80))].slice(0, 400);
  return {
    uid,
    cartIds,
    sellerUids,
    listingIds,
    recentIds: parseIds([...account.recent, ...parseIds(url.searchParams.get('recent'), 24)], 24),
    watchIds: parseIds([...parseIds(url.searchParams.get('watch'), 24), ...account.watch], 24),
    bought: account.bought || [],
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return sendPrivate(res, 405, { error: 'GET only.' });
  }
  try {
    const url = new URL(req.url || '/', `https://${requestHeader(req, 'host') || 'api.pokoin.com'}`);
    const game = normalizeGame(parseGameFromRequest(req) || 'pokemon');
    if (game !== 'pokemon') {
      return sendPrivate(res, 200, { game, personalized: false, rails: [] });
    }
    const uid = await optionalUid(req);
    const limit = await limitBestEffort({
      scope: 'recommendations',
      identity: uid || clientIp(req),
      limit: REQUESTS_PER_MINUTE,
      windowSeconds: 60,
    });
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSec || 60));
      return sendPrivate(res, 429, { error: 'Too many requests. Try again in a minute.' });
    }
    const perRail = Math.max(4, Math.min(30, Math.trunc(Number(url.searchParams.get('limit')) || DEFAULT_LIMIT)));
    const account = await readAccountSignals(uid);
    const signals = signalsFrom(url, account, uid);
    const rails = await recommend(signals, liveIo(), { limit: perRail });
    return sendPrivate(res, 200, {
      game,
      personalized: hasSignals(signals),
      signedIn: Boolean(uid),
      signals: {
        cart: signals.cartIds.length,
        recent: signals.recentIds.length,
        watch: signals.watchIds.length,
        bought: signals.bought.length,
      },
      rails,
    });
  } catch (error) {
    console.error('marketplace-recommendations failed', { message: error.message, code: error.code });
    return sendPrivate(res, 500, { error: 'Recommendations failed.' });
  }
};

module.exports._test = {
  recommend,
  signalsFrom,
  offerJson,
  publicName,
  resetPool() {
    poolCache = { at: 0, cards: [], byId: new Map() };
    poolFlight = null;
  },
  loadPool,
};
