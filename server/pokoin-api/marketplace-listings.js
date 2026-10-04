const { marketplaceQuery, marketplaceWriteQuery } = require('./_marketplace_db');
const { getFirebaseAdmin, verifyBearerToken } = require('./_firebase');
const { requireReserveAccess } = require('./_firebase_roles');
const { publicSellerComment } = require('./_seller_comment_filter');
const { beginRequest, finishRequest, timed } = require('./_request_timing');
const { commitListingWrite } = require('./_outbox');
const { kickSync, start: startSync } = require('./_sync_engine');
const { DECREMENT_SQL, decrementHttpStatus } = require('./_listing_inventory');
const {
  readLiveCardTraderListings,
  _test: {
    PKNRESERVE_SELLER_USERNAME,
  },
} = require('./cardtrader-live-listings');
const {
  destroyLinkedCardTraderProduct,
  normalizeTargets,
  pushAndLinkListing,
  pushListingToCardTrader,
} = require('./_cardtrader_seller_listings');
const {
  getPublicSellerProfiles,
  readSellerUidByName,
  rememberSellerUidByName,
} = require('./_seller_profile_cache');
const { invalidateMarketplaceReads } = require('./_marketplace_cache_invalidate');

function parseGameFromRequest(...args) {
  return require('./_marketplace_game').parseGameFromRequest(...args);
}

function normalizeMarketplaceGame(value) {
  try {
    return require('./_marketplace_game').normalizeGame(value);
  } catch (_) {
    const raw = String(value || '').trim().toLowerCase().replace(/-/g, '_');
    return raw || 'pokemon';
  }
}

function cleanLimit(value, fallback = 500) {
  if (value === undefined || value === null || value === '') return fallback;
  const limit = Number(value);
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), 1000);
}

/** Offset pagination for seller inventory top-up pages (0..50k guard). */
function cleanOffset(value) {
  const offset = Number(value);
  if (!Number.isFinite(offset) || offset <= 0) return 0;
  return Math.min(Math.trunc(offset), 50000);
}

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanListingId(value) {
  const text = cleanText(value, 80);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : '';
}

function cleanUsername(value) {
  // Native seller handles are display names ("Raffaella Sabatino"); they
  // resolve through the listings seller_name match. Require at least one
  // letter or digit so punctuation-only strings never reach Firestore doc ids.
  const text = cleanText(value, 64).toLowerCase();
  return /^[\p{L}\p{N} .'_-]{3,64}$/u.test(text) && /\p{L}/u.test(text) ? text : '';
}

function collectionKeyPart(value) {
  return cleanText(value, 240).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function collectionNumberKey(value) {
  return cleanText(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function collectionSignature({ name, setName, number }) {
  const normalizedName = collectionKeyPart(name);
  const normalizedSet = collectionKeyPart(setName);
  const normalizedNumber = collectionNumberKey(number);
  if (!normalizedName || !normalizedSet || !normalizedNumber) return '';
  return `${normalizedName}|${normalizedSet}|${normalizedNumber}`;
}

function isReserveListingBody(body = {}) {
  const source = cleanText(body.source, 80).toLowerCase();
  const sourceListingId = cleanText(body.sourceListingId, 160).toLowerCase();
  return body.reserveAvailable === true ||
    source === 'reserve' ||
    source === 'pokoin_reserve' ||
    source === 'pknreserve' ||
    source.startsWith('reserve_') ||
    source.startsWith('pokoin_reserve_') ||
    sourceListingId.startsWith('reserve:') ||
    sourceListingId.startsWith('pknreserve:');
}

async function verifyOwnedNftForListing({ uid, body, quantityAvailable, reserveListing = false }) {
  if (body.nftAvailable !== true || reserveListing) return;
  const source = cleanText(body.source, 80).toLowerCase();
  if (source !== 'pokoin_user_nft') {
    const error = new Error('NFT listings must use an owned NFT.');
    error.statusCode = 403;
    throw error;
  }
  if (quantityAvailable !== 1) {
    const error = new Error('NFT listings are limited to one owned NFT.');
    error.statusCode = 400;
    throw error;
  }
  const itemId = cleanText(body.sourceListingId, 160);
  if (!itemId) {
    const error = new Error('NFT listing requires an owned NFT id.');
    error.statusCode = 400;
    throw error;
  }
  const admin = getFirebaseAdmin();
  const snapshot = await admin.firestore()
    .collection('user_card_collections')
    .doc(itemId)
    .get();
  const data = snapshot.data?.() || {};
  const ownershipType = cleanText(data.ownershipType, 40).toLowerCase();
  const fulfillmentMode = cleanText(data.fulfillmentMode, 40).toLowerCase();
  const nftStatus = cleanText(data.nftStatus, 40).toLowerCase();
  const ownedCardId = cleanText(data.cardId || data.blueprintId, 80);
  const requestedCardId = cleanText(body.cardId, 80);
  const ownedSignature = collectionSignature({
    name: data.cardName,
    setName: data.setName,
    number: data.collectorNumber,
  });
  const requestedSignature = collectionSignature({
    name: body.cardName,
    setName: body.setName,
    number: body.collectorNumber,
  });
  const isNft = ownershipType === 'nft' ||
    fulfillmentMode === 'nft_only' ||
    nftStatus === 'owned';
  const matchesCard = (ownedCardId && ownedCardId === requestedCardId) ||
    (ownedSignature && ownedSignature === requestedSignature);
  if (!snapshot.exists || data.uid !== uid || !isNft || !matchesCard) {
    const error = new Error('You can only list NFTs you own for this card.');
    error.statusCode = 403;
    throw error;
  }
}

// `location` is the seller's private storage position: only owner reads get it.
function listingRow(row, { owner = false } = {}) {
  const source = row.source || 'pokoin_user_listing';
  const sourceListingId = row.source_listing_id || '';
  const canonicalPath = cleanText(
    row.canonical_path || row.canonicalPath,
    800,
  );
  const sellerDisplayName = displaySellerName(row, source, sourceListingId);
  const marketplaceGame = cleanText(row.marketplace_game || row.marketplaceGame, 40) || 'pokemon';
  return {
    id: row.id,
    cardId: row.card_id,
    sellerUid: row.seller_uid,
    sellerName: sellerDisplayName,
    sellerDisplayName,
    sellerUsername: listingUsername(row, source, sourceListingId),
    sellerCountry: row.seller_country,
    sellerReputationLabel: row.seller_reputation_label,
    marketplaceGame,
    condition: row.condition,
    language: row.language,
    pricePkn: Number(row.price_pkn || 0),
    // false = seller opted out of PKN payments: buyers see local currency first.
    sellerAcceptsPkn: row.profile_accepts_pkn !== false,
    quantityAvailable: Number(row.quantity_available || 0),
    signed: row.signed === true,
    reverse: row.reverse === true,
    firstEdition: row.first_edition === true,
    altered: row.altered === true,
    ...(owner ? { location: row.location || '' } : {}),
    foilState: row.foil_state || 'standard',
    variantState: row.variant_state || '',
    sealed: row.sealed === true,
    graded: row.graded === true,
    gradingCompany: row.grading_company,
    grade: row.grade,
    certificationId: row.certification_id,
    shippingAvailable: row.shipping_available !== false,
    reserveAvailable: row.reserve_available === true,
    nftAvailable: row.nft_available === true,
    sellerComment: publicSellerComment(row.seller_comment),
    source,
    sourceListingId,
    status: row.status,
    cardName: row.card_name,
    cardImageUrl: row.card_image_url,
    photoUrls: Array.isArray(row.photo_urls) ? row.photo_urls.filter((url) => typeof url === 'string').slice(0, 2) : [],
    setName: row.set_name,
    collectorNumber: row.collector_number,
    canonicalPath,
    publicNumber: cleanText(row.public_number || row.publicNumber, 80),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceMetadata: row.source_metadata || {},
  };
}

function displaySellerName(row, source = row.source, sourceListingId = row.source_listing_id) {
  const normalizedSource = cleanText(source, 80).toLowerCase();
  if (
    row.reserve_available === true ||
    normalizedSource === 'cardtrader_live' ||
    isReserveListingBody({ source, sourceListingId })
  ) {
    return PKNRESERVE_SELLER_USERNAME;
  }
  return cleanText(
    row.profile_display_name ||
      row.profile_username ||
      row.display_name ||
      row.username ||
      row.seller_name,
    120,
  ) || 'Pokoin seller';
}

function listingUsername(row, source = row.source, sourceListingId = row.source_listing_id) {
  if (
    row.reserve_available === true ||
    cleanText(source, 80).toLowerCase() === 'cardtrader_live' ||
    isReserveListingBody({ source, sourceListingId })
  ) {
    return PKNRESERVE_SELLER_USERNAME;
  }
  const claimed = cleanUsername(row.profile_username);
  if (claimed && claimed !== PKNRESERVE_SELLER_USERNAME) {
    return claimed;
  }
  return cleanUsername(row.seller_name);
}

function isPublicCardPageListingRead({ cardId, sellerUid, sellerUsername }) {
  return Boolean(cardId) && !sellerUid && !sellerUsername;
}

function sourceListingIdForCardTrader(listing = {}) {
  const externalId = cleanText(
    listing.externalProductId || listing.cardtraderProductId || listing.externalListingId,
    120,
  );
  return externalId ? `cardtrader:live:${externalId}` : '';
}

function foilStateFromCardTraderProperties(properties = {}) {
  const props = properties && typeof properties === 'object' ? properties : {};
  if (String(props.pokemon_reverse || '').toLowerCase() === 'true') return 'reverse';
  const explicit = String(props.foil_state || props.foilState || '').toLowerCase();
  if (['reverse', 'holo', 'foil', 'stamped', 'promo', 'other', 'standard'].includes(explicit)) {
    return explicit;
  }
  for (const [key, value] of Object.entries(props)) {
    const name = String(key || '').toLowerCase();
    if (name !== 'foil' && name !== 'mtg_foil' && !name.endsWith('_foil')) continue;
    const on = value === true || ['true', 'yes', '1', 'foil'].includes(String(value).toLowerCase());
    if (on) return 'foil';
  }
  return 'standard';
}

function syntheticCardTraderListingRow({ listing, seller, fallbackCardId }) {
  const sourceListingId = sourceListingIdForCardTrader(listing);
  if (!sourceListingId || listing.displayPricePkn == null) return null;
  const sourceAccountName = cleanText(listing.seller?.sourceAccountName || listing.seller?.accountName, 120);
  const foilState = cleanText(listing.foilState, 40)
    || foilStateFromCardTraderProperties(listing.properties);
  // Prefer the public Pokoin card id the desk asked for — never leave the
  // blueprint/leftover id on satellite rows (Riftbound 400585 vs 801170).
  const publicCardId = cleanText(fallbackCardId, 80)
    || cleanText(listing.pokoinCardId, 80)
    || cleanText(listing.blueprintId, 80);
  return {
    id: sourceListingId,
    cardId: publicCardId,
    sellerUid: seller.uid,
    sellerName: PKNRESERVE_SELLER_USERNAME,
    sellerCountry: cleanText(listing.seller?.country, 40) || '',
    sellerReputationLabel: 'pknreserve',
    condition: cleanText(listing.condition, 20) || 'NM',
    language: cleanText(listing.language, 10).toUpperCase() || 'EN',
    pricePkn: Number(listing.displayPricePkn),
    quantityAvailable: Math.max(Number(listing.quantity || 0), 0),
    signed: false,
    reverse: foilState === 'reverse',
    firstEdition: false,
    foilState,
    variantState: cleanText(listing.properties?.variant_state || listing.properties?.variantState, 80),
    sealed: false,
    graded: listing.graded === true,
    gradingCompany: null,
    grade: null,
    certificationId: null,
    shippingAvailable: true,
    reserveAvailable: true,
    nftAvailable: true,
    sellerComment: publicSellerComment(listing.sellerComment),
    source: 'cardtrader_live',
    sourceListingId,
    sourceMetadata: {
      provider: 'cardtrader',
      externalListingId: cleanText(listing.externalListingId, 120),
      externalProductId: cleanText(listing.externalProductId || listing.cardtraderProductId, 120),
      cardtraderProductId: cleanText(listing.cardtraderProductId || listing.externalProductId, 120),
      cardtraderBlueprintId: cleanText(listing.cardtraderBlueprintId, 80),
      sourceSellerName: sourceAccountName,
      shippingMode: cleanText(listing.shippingMode, 40),
      shippingLabel: cleanText(listing.shippingLabel, 80),
      sellerComment: publicSellerComment(listing.sellerComment),
      sourcePrice: listing.price == null ? null : Number(listing.price),
      sourceCurrency: cleanText(listing.currency, 12) || 'EUR',
      markupPkn: 0,
      nftTag: true,
    },
    status: 'active',
    cardName: cleanText(listing.name, 240),
    cardImageUrl: '',
    setName: cleanText(listing.expansion?.name, 240) || 'Pokemon',
    collectorNumber: cleanText(listing.externalListingId, 80),
    canonicalPath: '',
    publicNumber: '',
    createdAt: null,
    updatedAt: null,
  };
}

async function enrichListingRowsWithCardUrls(rows = []) {
  const cardIds = [...new Set(
    rows
      .map((row) => cleanText(row.card_id, 80))
      .filter((cardId) => /^\d+$/.test(cardId)),
  )];
  if (cardIds.length === 0) return rows;
  try {
    const result = await marketplaceQuery(
      `
        select distinct on (card_id)
          card_id::text as card_id,
          canonical_path::text as canonical_path,
          split_part(split_part(canonical_path, '/cards/', 2), '/', 1) as public_number
        from public.marketplace_card_urls
        where card_id = any($1::bigint[])
          and language = 'en'
        order by card_id, canonical_path
      `,
      [cardIds.map(Number)],
    );
    const urlsByCardId = new Map(
      result.rows.map((row) => [String(row.card_id || ''), row]),
    );
    return rows.map((row) => {
      const url = urlsByCardId.get(cleanText(row.card_id, 80));
      return url
        ? {
            ...row,
            canonical_path: cleanText(url.canonical_path, 800),
            public_number: cleanText(url.public_number, 80),
          }
        : row;
    });
  } catch (error) {
    console.error('Listing card URL enrichment skipped', {
      message: error.message,
    });
    return rows;
  }
}

async function readLiveCardTraderListingsForCard(cardId, limit, game = 'pokemon') {
  const cleanCard = cleanText(cardId, 80);
  if (!cleanCard) return [];
  let seller;
  try {
    seller = await sellerProfileForUsername(PKNRESERVE_SELLER_USERNAME, { listingsFirst: false });
  } catch (error) {
    // The CardTrader offers only need a seller id. Without a Firestore
    // pknreserve account every game's card page lost all CardTrader offers
    // (2026-09-30), so keep them under a fixed reserve profile instead.
    if (error.statusCode !== 404) {
      console.error('pknreserve seller profile lookup failed', {
        statusCode: error.statusCode || 500,
        message: error.message,
      });
    }
    seller = {
      uid: PKNRESERVE_SELLER_USERNAME,
      username: PKNRESERVE_SELLER_USERNAME,
      displayName: PKNRESERVE_SELLER_USERNAME,
    };
  }
  try {
    const payload = await readLiveCardTraderListings({
      blueprintId: '',
      cardId: cleanCard,
      requestedId: cleanCard,
      requestedParam: 'cardId',
      language: '',
      limit: cleanLimit(limit),
      game: normalizeMarketplaceGame(game),
    });
    return (payload.listings || [])
      .map((listing) => syntheticCardTraderListingRow({ listing, seller, fallbackCardId: cleanCard }))
      .filter((listing) => listing && listing.quantityAvailable > 0 && listing.pricePkn > 0);
  } catch (error) {
    console.error('CardTrader live marketplace merge skipped', {
      code: error.code || '',
      statusCode: error.statusCode || 500,
      message: error.message,
    });
    return [];
  }
}

async function refreshPriceSummary(cardId) {
  const cleanCardId = cleanText(cardId, 80);
  if (!cleanCardId) return;
  await timed('sqlMs', () => marketplaceWriteQuery(
    'select public.refresh_marketplace_blueprint_price_summary($1)',
    [cleanCardId],
  ));
}

function listingChangedEvent(listing, extra = {}) {
  if (!listing?.id) return null;
  return {
    type: 'listing.changed',
    aggregateId: String(listing.id),
    idempotencyKey: `listing.changed:${listing.id}:${listing.updatedAt || listing.updated_at || Date.now()}`,
    payload: {
      cardId: listing.cardId || listing.card_id || '',
      game: extra.game || 'pokemon',
      sellerUid: extra.sellerUid || listing.sellerUid || listing.seller_uid || '',
      listingId: String(listing.id),
      quantityAvailable: listing.quantityAvailable ?? listing.quantity_available,
      status: listing.status || '',
      wantsCardtrader: extra.wantsCardtrader === true,
      destroyCardtrader: extra.destroyCardtrader === true,
      sourceListingId: extra.sourceListingId || listing.sourceListingId || listing.source_listing_id || '',
      listing: extra.cardtraderListing || null,
      steps: {},
    },
  };
}

async function sellerProfileForUsername(username, { listingsFirst = true } = {}) {
  const clean = cleanUsername(username);
  if (!clean) {
    const error = new Error('Seller username is invalid.');
    error.statusCode = 400;
    throw error;
  }

  // Shared slug cache first: a resolved seller name → uid pair is stable and
  // public. Unknown names are never negatively cached (new sellers can
  // appear any time).
  const cachedUid = await readSellerUidByName(clean);
  if (cachedUid?.uid) {
    return {
      uid: cachedUid.uid,
      username: clean,
      displayName: cachedUid.displayName || '',
    };
  }

  let uid = '';
  let displayName = '';
  if (listingsFirst) {
    uid = await sellerUidFromListingName(clean);
  }

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

  await rememberSellerUidByName(clean, { uid, displayName });
  return {
    uid,
    username: clean,
    displayName,
  };
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

async function enrichListingRowsWithSellerProfiles(rows = []) {
  const uidSet = new Set();
  for (const row of rows) {
    const uid = cleanText(row.seller_uid, 160);
    if (!uid || isReserveListingBody({ source: row.source, sourceListingId: row.source_listing_id })) {
      continue;
    }
    uidSet.add(uid);
  }
  const uids = [...uidSet];
  if (uids.length === 0) return rows;
  try {
    // Shared read-through cache: Redis first, one Firestore users/{uid} read
    // per cache-miss only. Display enrichment — never used for authorization.
    const profiles = await getPublicSellerProfiles(uids);
    return rows.map((row) => {
      const profile = profiles.get(cleanText(row.seller_uid, 160));
      return profile
        ? {
            ...row,
            profile_display_name: profile.displayName,
            profile_username: profile.username,
            profile_accepts_pkn: profile.acceptsPkn,
          }
        : row;
    });
  } catch (error) {
    console.error('Seller profile enrichment skipped', {
      message: error.message,
    });
    return rows;
  }
}

function addListingTableAlias(where, alias = 'listings') {
  return where.map((clause) => clause.replace(/\b(card_id|seller_uid|status|quantity_available)\b/g, `${alias}.$1`));
}

function addTextField(sets, values, body, bodyKey, columnName, maxLength, fallback = null) {
  if (body[bodyKey] === undefined) return;
  values.push(cleanText(body[bodyKey], maxLength) || fallback);
  sets.push(`${columnName} = $${values.length}`);
}

function addNonEmptyTextField(sets, values, body, bodyKey, columnName, maxLength) {
  if (body[bodyKey] === undefined) return;
  const value = cleanText(body[bodyKey], maxLength);
  if (!value) return;
  values.push(value);
  sets.push(`${columnName} = $${values.length}`);
}

async function cardMetadataFallback(cardId) {
  const cleanCardId = cleanText(cardId, 80);
  if (!cleanCardId) {
    return {
      cardName: '',
      cardImageUrl: '',
      setName: '',
      collectorNumber: '',
    };
  }
  const result = await marketplaceQuery(
    `
      select
        name,
        image_url,
        expansion_name,
        expansion_number
      from public.marketplace_card_versions
      where card_id = $1
      limit 1
    `,
    [cleanCardId],
  ).catch(() => ({ rows: [] }));
  const row = result.rows[0] || {};
  return {
    cardName: cleanText(row.name, 240),
    cardImageUrl: cleanText(row.image_url, 800),
    setName: cleanText(row.expansion_name, 240),
    collectorNumber: cleanText(row.expansion_number, 80),
  };
}

function addBooleanField(sets, values, body, bodyKey, columnName, trueDefault = false) {
  if (body[bodyKey] === undefined) return;
  values.push(trueDefault ? body[bodyKey] !== false : body[bodyKey] === true);
  sets.push(`${columnName} = $${values.length}`);
}

async function cardIdsInGameCatalog(cardIds, game) {
  const catalogGame = normalizeMarketplaceGame(game);
  const ids = (cardIds || []).map((id) => cleanText(id, 80)).filter(Boolean);
  if (!ids.length) return [];
  let runWithGame;
  try {
    runWithGame = require('./_marketplace_game').runWithGame;
  } catch (_) {
    runWithGame = async (_game, fn) => fn();
  }
  try {
    const catalog = await runWithGame(catalogGame, () => marketplaceQuery(
      `
        select card_id::text as card_id
        from public.marketplace_search_candidates
        where card_id::text = any($1::text[])
      `,
      [ids],
    ));
    return catalog.rows.map((row) => cleanText(row.card_id, 80)).filter(Boolean);
  } catch (error) {
    // Satellite catalogs may be missing; fall back to marketplace_game only.
    if (error.code === '42P01' || /does not exist/i.test(String(error.message || ''))) {
      return null;
    }
    throw error;
  }
}

async function sellerCardIdsForGame(sellerUid, game) {
  const listed = await marketplaceQuery(
    `
      select distinct card_id
      from public.marketplace_user_listings
      where seller_uid = $1
        and nullif(card_id, '') is not null
    `,
    [sellerUid],
  );
  const ids = listed.rows.map((row) => cleanText(row.card_id, 80)).filter(Boolean);
  if (!ids.length) return [];
  return cardIdsInGameCatalog(ids, game);
}

async function readListings(url, decoded, { marketplaceGame = 'pokemon' } = {}) {
  const values = [];
  const where = [];
  const rawListingId = cleanText(url.searchParams.get('id'), 80);
  const listingId = cleanListingId(rawListingId);
  const cardId = cleanText(url.searchParams.get('cardId'), 80);
  const sellerUid = cleanText(url.searchParams.get('sellerUid'), 160);
  const sellerUsername = cleanText(url.searchParams.get('sellerUsername'), 64);
  const game = normalizeMarketplaceGame(marketplaceGame);
  if (rawListingId && !listingId) {
    return [];
  }
  if (sellerUid && sellerUsername) {
    const error = new Error('Use either sellerUid or sellerUsername, not both.');
    error.statusCode = 400;
    throw error;
  }
  if (cardId) {
    values.push(cardId);
    where.push(`card_id = $${values.length}`);
  }
  if (listingId) {
    values.push(listingId);
    where.push(`id = $${values.length}`);
  }
  let ownerUid = '';
  if (sellerUid) {
    if (!decoded || decoded.uid !== sellerUid) {
      const error = new Error('You can only read your own seller listings.');
      error.statusCode = 403;
      throw error;
    }
    ownerUid = sellerUid;
    values.push(sellerUid);
    where.push(`seller_uid = $${values.length}`);
  } else if (sellerUsername) {
    const seller = await sellerProfileForUsername(sellerUsername, { listingsFirst: true });
    ownerUid = seller.uid;
    values.push(seller.uid);
    where.push(`seller_uid = $${values.length}`);
    where.push("status = 'active'");
    where.push('quantity_available > 0');
  } else {
    where.push("status = 'active'");
    where.push('quantity_available > 0');
  }
  // Game scope: tagged marketplace_game from CT sync / createListing, plus
  // catalog intersection for seller inventory so pre-tag mixed CT imports
  // (all stored in the pokemon listings table) stay site-scoped.
  // Public card-desk reads key by card_id only — CT seller imports often leave
  // marketplace_game='pokemon' on satellite printings (Riftbound Sanction
  // 801170), and CardTrader blueprint ids are globally unique so the numeric
  // public card_id already picks the right TCG.
  if (!listingId && !cardId) {
    let gameCardIds = null;
    if (ownerUid) {
      gameCardIds = await sellerCardIdsForGame(ownerUid, game);
    }
    if (game === 'pokemon') {
      values.push(game);
      where.push(`coalesce(nullif(marketplace_game, ''), 'pokemon') = $${values.length}`);
      if (Array.isArray(gameCardIds)) {
        values.push(gameCardIds);
        where.push(`card_id = any($${values.length}::text[])`);
      }
    } else if (Array.isArray(gameCardIds)) {
      values.push(game);
      values.push(gameCardIds);
      where.push(`(
        coalesce(nullif(marketplace_game, ''), 'pokemon') = $${values.length - 1}
        or (
          coalesce(nullif(marketplace_game, ''), 'pokemon') = 'pokemon'
          and card_id = any($${values.length}::text[])
        )
      )`);
    } else {
      values.push(game);
      where.push(`coalesce(nullif(marketplace_game, ''), 'pokemon') = $${values.length}`);
    }
  }
  values.push(cleanLimit(url.searchParams.get('limit')));
  const qualifiedWhere = addListingTableAlias(where);
  const offset = cleanOffset(url.searchParams.get('offset'));
  const offsetSql = offset > 0 ? `\n      offset $${values.length + 1}` : '';
  if (offset > 0) {
    values.push(offset);
  }
  const result = await marketplaceQuery(
    `
      select
        listings.*
      from public.marketplace_user_listings listings
      ${qualifiedWhere.length ? `where ${qualifiedWhere.join(' and ')}` : ''}
      order by price_pkn asc, updated_at desc, created_at desc
      limit $${values.length - (offset > 0 ? 1 : 0)}${offsetSql}
    `,
    values,
  );
  // Owner reads (MyPokoin / stock) skip the Firestore profile enrich: the
  // seller is the caller, rows fall back to their native username columns,
  // and the extra Google round trip dominated the desk's time to first row.
  const enrichedRows = sellerUsername || sellerUid
    ? result.rows
    : await enrichListingRowsWithSellerProfiles(result.rows);
  const urlEnrichedRows = await enrichListingRowsWithCardUrls(enrichedRows);
  const nativeListings = urlEnrichedRows.map((row) => listingRow(row, { owner: Boolean(sellerUid) }));
  const skipLive = url.searchParams.get('nativeOnly') === '1' ||
    url.searchParams.get('live') === '0';
  if (!isPublicCardPageListingRead({ cardId, sellerUid, sellerUsername }) || skipLive) {
    return nativeListings;
  }
  const cardTraderListings = await readLiveCardTraderListingsForCard(cardId, cleanLimit(url.searchParams.get('limit')), game);
  return [...nativeListings, ...cardTraderListings]
    .sort((a, b) => a.pricePkn - b.pricePkn);
}

async function readListingForOwner(id, uid) {
  const result = await marketplaceQuery(
    'select seller_uid, card_id, quantity_available, reserve_available, source, source_listing_id from public.marketplace_user_listings where id = $1 limit 1',
    [id],
  );
  const row = result.rows[0];
  if (!row || row.seller_uid !== uid) {
    const error = new Error('Listing not found for this seller.');
    error.statusCode = 404;
    throw error;
  }
  return row;
}

function isReserveListingRow(row = {}) {
  return row.reserve_available === true ||
    isReserveListingBody({
      source: row.source,
      sourceListingId: row.source_listing_id,
    });
}

async function createListing(req, decoded) {
  const body = req.body || {};
  const targets = normalizeTargets(body.targets || {});
  const pricePkn = Number(body.pricePkn);
  const quantityAvailable = Number(body.quantityAvailable);
  const reserveListing = isReserveListingBody(body);
  const reserveAvailable = reserveListing;
  if (!cleanText(body.cardId, 80)) {
    const error = new Error('Missing card id.');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isFinite(pricePkn) || pricePkn <= 0) {
    const error = new Error('Enter a valid PKN price.');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isSafeInteger(quantityAvailable) || quantityAvailable <= 0 || quantityAvailable > 99) {
    const error = new Error('Quantity must be between 1 and 99.');
    error.statusCode = 400;
    throw error;
  }
  if (reserveListing) {
    await requireReserveAccess(decoded);
  }

  let cardtrader = { ok: true, skipped: true, reason: 'not_requested' };

  // CardTrader-only: push to CT without a Pokoin sellable row.
  if (!targets.pokoin && targets.cardtrader) {
    const firestore = getFirebaseAdmin().firestore();
    try {
      const pushed = await pushListingToCardTrader({
        firestore,
        uid: decoded.uid,
        listing: {
          cardId: cleanText(body.cardId, 80),
          pricePkn,
          quantityAvailable,
          condition: cleanText(body.condition, 20) || 'NM',
          language: cleanText(body.language, 10) || 'EN',
          signed: body.signed === true,
          reverse: body.reverse === true,
          firstEdition: body.firstEdition === true,
          foilState: cleanText(body.foilState, 40) || (body.reverse === true ? 'reverse' : 'standard'),
          graded: body.graded === true,
          altered: body.altered === true,
          sellerComment: cleanText(body.sellerComment, 500),
        },
      });
      cardtrader = { ok: true, productId: pushed.productId, sourceListingId: pushed.sourceListingId };
    } catch (error) {
      cardtrader = { ok: false, error: error.message || 'CardTrader create failed.' };
    }
    return { listing: null, cardtrader, targets };
  }

  await verifyOwnedNftForListing({
    uid: decoded.uid,
    body,
    quantityAvailable,
    reserveListing,
  });
  const metadata = await cardMetadataFallback(body.cardId);
  const cardName = cleanText(body.cardName, 240) || metadata.cardName || cleanText(body.cardId, 80);
  const cardImageUrl = cleanText(body.cardImageUrl, 800) || metadata.cardImageUrl;
  const setName = cleanText(body.setName, 240) || metadata.setName || 'Pokemon';
  const collectorNumber = cleanText(body.collectorNumber, 80) ||
    metadata.collectorNumber ||
    cleanText(body.cardId, 80);
  const values = [
    cleanText(body.cardId, 80),
    decoded.uid,
    cleanText(body.sellerName, 120) || 'Pokoin seller',
    (function sellerCountryOrThrow() {
      const raw = cleanText(body.sellerCountry || body.shipFromCountry, 40).toUpperCase();
      if (!raw || raw === 'EU') {
        const error = new Error('shipFromCountry (ISO country code) is required before listing.');
        error.statusCode = 400;
        error.code = 'missing_ship_from';
        throw error;
      }
      if (!/^[A-Z]{2}$/.test(raw)) {
        const error = new Error('shipFromCountry must be an ISO 3166-1 alpha-2 code.');
        error.statusCode = 400;
        error.code = 'invalid_ship_from';
        throw error;
      }
      return raw;
    })(),
    cleanText(body.sellerReputationLabel, 40) || 'New',
    cleanText(body.condition, 20) || 'NM',
    cleanText(body.language, 10) || 'EN',
    pricePkn,
    quantityAvailable,
    body.signed === true,
    body.reverse === true,
    body.firstEdition === true,
    cleanText(body.foilState, 40) || (body.reverse === true ? 'reverse' : 'standard'),
    cleanText(body.variantState, 80),
    body.sealed === true,
    body.graded === true,
    cleanText(body.gradingCompany, 80) || null,
    cleanText(body.grade, 40) || null,
    cleanText(body.certificationId, 120) || null,
    body.shippingAvailable !== false,
    reserveAvailable,
    body.nftAvailable === true,
    cleanText(body.sellerComment, 500),
    cleanText(body.source, 80) || 'pokoin_user_listing',
    cleanText(body.sourceListingId, 160),
    cardName,
    cardImageUrl,
    setName,
    collectorNumber,
    cleanText(body.location, 64),
    body.altered === true,
    normalizeMarketplaceGame(body.marketplaceGame || parseGameFromRequest(req)),
  ];
  const game = normalizeMarketplaceGame(body.marketplaceGame || parseGameFromRequest(req));
  const written = await timed('sqlMs', () => commitListingWrite({
    sql: `
      insert into public.marketplace_user_listings (
        card_id, seller_uid, seller_name, seller_country, seller_reputation_label,
        condition, language, price_pkn, quantity_available, signed, reverse,
        first_edition, foil_state, variant_state, sealed, graded,
        grading_company, grade, certification_id, shipping_available,
        reserve_available, nft_available, seller_comment, source,
        source_listing_id, card_name,
        card_image_url, set_name, collector_number, location, altered,
        marketplace_game
      )
      values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32
      )
      returning *
    `,
    values,
    writeQuery: marketplaceWriteQuery,
    event: (queryResult) => {
      const raw = queryResult.rows[0];
      if (!raw) return null;
      return listingChangedEvent(raw, {
        game,
        sellerUid: decoded.uid,
        wantsCardtrader: targets.cardtrader === true,
        cardtraderListing: targets.cardtrader ? {
          id: raw.id,
          cardId: raw.card_id,
          pricePkn: raw.price_pkn,
          quantityAvailable: raw.quantity_available,
          condition: raw.condition,
          language: raw.language,
          signed: raw.signed,
          reverse: raw.reverse,
          firstEdition: raw.first_edition,
          foilState: raw.foil_state,
          graded: raw.graded,
          altered: raw.altered,
          sellerComment: raw.seller_comment,
        } : null,
      });
    },
  }));
  const result = written.result;
  const [row] = await timed('firestoreMs', () => enrichListingRowsWithSellerProfiles(result.rows));
  let listing = listingRow(row || result.rows[0], { owner: true });
  await invalidateMarketplaceReads({
    game,
    cardId: listing.cardId,
    sellerUid: decoded.uid,
    reason: 'listing.created',
  });
  if (written.queued) kickSync();
  else await refreshPriceSummary(listing.cardId);

  if (targets.cardtrader && written.queued) {
    cardtrader = { ok: true, pending: true };
  } else if (targets.cardtrader) {
    const firestore = getFirebaseAdmin().firestore();
    try {
      const pushed = await pushAndLinkListing({
        firestore,
        uid: decoded.uid,
        listing: {
          id: listing.id,
          cardId: listing.cardId,
          pricePkn: listing.pricePkn,
          quantityAvailable: listing.quantityAvailable,
          condition: listing.condition,
          language: listing.language,
          signed: listing.signed,
          reverse: listing.reverse,
          firstEdition: listing.firstEdition,
          foilState: listing.foilState,
          graded: listing.graded,
          altered: listing.altered,
          sellerComment: listing.sellerComment,
        },
      });
      cardtrader = { ok: true, productId: pushed.productId, sourceListingId: pushed.sourceListingId };
      listing = { ...listing, sourceListingId: pushed.sourceListingId };
    } catch (error) {
      cardtrader = { ok: false, error: error.message || 'CardTrader create failed.' };
    }
  }

  return { ...listing, cardtrader, targets };
}

async function updateListing(req, decoded, id) {
  const existingListing = await readListingForOwner(id, decoded.uid);
  const body = req.body || {};
  const status = cleanText(body.status, 20);
  const quantityValue = body.quantityAvailable;
  const sets = ['updated_at = now()'];
  const values = [id];
  if (status) {
    values.push(status);
    sets.push(`status = $${values.length}`);
  }
  if (quantityValue !== undefined) {
    const quantity = Number(quantityValue);
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 99) {
      const error = new Error('Quantity must be between 0 and 99.');
      error.statusCode = 400;
      throw error;
    }
    values.push(quantity);
    sets.push(`quantity_available = $${values.length}`);
    if (!status && quantity === 0) {
      sets.push("status = 'paused'");
    }
  }
  if (body.pricePkn !== undefined) {
    const pricePkn = Number(body.pricePkn);
    if (!Number.isFinite(pricePkn) || pricePkn <= 0) {
      const error = new Error('Enter a valid PKN price.');
      error.statusCode = 400;
      throw error;
    }
    values.push(pricePkn);
    sets.push(`price_pkn = $${values.length}`);
  }
  if (isReserveListingRow(existingListing) || isReserveListingBody(body)) {
    await requireReserveAccess(decoded);
  }
  if (body.nftAvailable === true && !isReserveListingRow(existingListing)) {
    await verifyOwnedNftForListing({
      uid: decoded.uid,
      body: {
        ...body,
        cardId: body.cardId || existingListing.card_id,
        source: body.source || existingListing.source,
        sourceListingId: body.sourceListingId || existingListing.source_listing_id,
      },
      quantityAvailable: quantityValue === undefined
        ? Number(existingListing.quantity_available)
        : Number(quantityValue),
      reserveListing: false,
    });
  }
  addTextField(sets, values, body, 'condition', 'condition', 20, 'NM');
  addTextField(sets, values, body, 'language', 'language', 10, 'EN');
  addBooleanField(sets, values, body, 'signed', 'signed');
  addBooleanField(sets, values, body, 'reverse', 'reverse');
  addBooleanField(sets, values, body, 'firstEdition', 'first_edition');
  addBooleanField(sets, values, body, 'altered', 'altered');
  addTextField(sets, values, body, 'location', 'location', 64, '');
  addTextField(sets, values, body, 'foilState', 'foil_state', 40, 'standard');
  addTextField(sets, values, body, 'variantState', 'variant_state', 80, '');
  addBooleanField(sets, values, body, 'sealed', 'sealed');
  addBooleanField(sets, values, body, 'graded', 'graded');
  addTextField(sets, values, body, 'gradingCompany', 'grading_company', 80);
  addTextField(sets, values, body, 'grade', 'grade', 40);
  addTextField(sets, values, body, 'certificationId', 'certification_id', 120);
  addBooleanField(sets, values, body, 'shippingAvailable', 'shipping_available', true);
  addBooleanField(sets, values, body, 'reserveAvailable', 'reserve_available');
  addBooleanField(sets, values, body, 'nftAvailable', 'nft_available');
  addTextField(sets, values, body, 'sellerComment', 'seller_comment', 500, '');
  addTextField(sets, values, body, 'source', 'source', 80, 'pokoin_user_listing');
  addTextField(sets, values, body, 'sourceListingId', 'source_listing_id', 160, '');
  addNonEmptyTextField(sets, values, body, 'cardName', 'card_name', 240);
  addNonEmptyTextField(sets, values, body, 'cardImageUrl', 'card_image_url', 800);
  addNonEmptyTextField(sets, values, body, 'setName', 'set_name', 240);
  addNonEmptyTextField(sets, values, body, 'collectorNumber', 'collector_number', 80);
  const becameInactive = status === 'inactive' || status === 'sold_out'
    || (quantityValue !== undefined && Number(quantityValue) === 0);
  values.push(decoded.uid);
  const sellerParam = values.length;
  const written = await timed('sqlMs', () => commitListingWrite({
    sql: `
      update public.marketplace_user_listings
      set ${sets.join(', ')}
      where id = $1 and seller_uid = $${sellerParam}
      returning *
    `,
    values,
    writeQuery: marketplaceWriteQuery,
    event: (queryResult) => listingChangedEvent(queryResult.rows[0], {
      sellerUid: decoded.uid,
      destroyCardtrader: becameInactive && Boolean(existingListing.source_listing_id),
      sourceListingId: existingListing.source_listing_id,
    }),
  }));
  const result = written.result;
  if (!result.rows[0]) {
    const error = new Error('Listing not found for this seller.');
    error.statusCode = 404;
    throw error;
  }
  const [row] = await timed('firestoreMs', () => enrichListingRowsWithSellerProfiles(result.rows));
  const listing = listingRow(row || result.rows[0], { owner: true });
  await invalidateMarketplaceReads({
    game: listing.marketplaceGame || listing.marketplace_game || 'pokemon',
    cardId: listing.cardId,
    sellerUid: decoded.uid,
    reason: becameInactive ? 'listing.deleted' : 'listing.updated',
  });
  if (written.queued) kickSync();
  else await refreshPriceSummary(listing.cardId);

  if (!written.queued && becameInactive && existingListing.source_listing_id) {
    try {
      const firestore = getFirebaseAdmin().firestore();
      await destroyLinkedCardTraderProduct({
        firestore,
        uid: decoded.uid,
        sourceListingId: existingListing.source_listing_id,
        quantity: Number(existingListing.quantity_available) || 0,
      });
    } catch (error) {
      console.error('linked CardTrader destroy on cancel failed', {
        listingId: id,
        message: error.message,
      });
    }
  }

  return listing;
}

async function decrementListing(req, id, sellerUid) {
  const quantity = Number(req.body?.quantity || 0);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    return { outcome: 'invalid', listing: null, queued: false };
  }
  const written = await timed('sqlMs', () => commitListingWrite({
    sql: DECREMENT_SQL,
    values: [id, sellerUid, quantity],
    writeQuery: marketplaceWriteQuery,
    event: (queryResult) => {
      const outcome = queryResult.rows[0];
      if (outcome?.outcome !== 'updated' || !outcome.listing) return null;
      return listingChangedEvent(outcome.listing, { sellerUid });
    },
  }));
  const outcome = written.result.rows[0] || { outcome: 'missing', listing: null };
  if (outcome.outcome !== 'updated' || !outcome.listing) {
    return { outcome: outcome.outcome || 'missing', listing: null, queued: written.queued };
  }
  const enrichedRows = await timed('firestoreMs', () => enrichListingRowsWithSellerProfiles([outcome.listing]));
  const listing = listingRow(enrichedRows[0] || outcome.listing, { owner: true });
  await invalidateMarketplaceReads({
    game: listing.marketplaceGame || listing.marketplace_game || 'pokemon',
    cardId: listing.cardId,
    sellerUid,
    reason: 'listing.quantity',
  });
  if (written.queued) kickSync();
  else await refreshPriceSummary(listing.cardId);
  return { outcome: 'updated', listing, queued: written.queued };
}

async function readPublicOffersForCard(cardId, limit = 40, options = {}) {
  const url = new URL('https://pokoin.com/api/marketplace-listings');
  url.searchParams.set('cardId', String(cardId || ''));
  url.searchParams.set('limit', String(limit));
  const game = normalizeMarketplaceGame(options.game || 'pokemon');
  url.searchParams.set('game', game);
  if (options.nativeOnly) {
    url.searchParams.set('nativeOnly', '1');
  }
  return readListings(url, null, { marketplaceGame: game });
}

module.exports = async function handler(req, res) {
  const span = beginRequest('marketplace-listings', req.method);
  try {
    const marketplaceGame = normalizeMarketplaceGame(parseGameFromRequest(req));
    if (req.method === 'GET') {
      const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
      const sellerUid = cleanText(url.searchParams.get('sellerUid'), 160);
      const sellerUsername = cleanText(url.searchParams.get('sellerUsername'), 64);
      if (sellerUid && sellerUsername) {
        return res.status(400).json({ error: 'Use either sellerUid or sellerUsername, not both.' });
      }
      const decoded = sellerUid ? await verifyBearerToken(req) : null;
      const listings = await readListings(url, decoded, { marketplaceGame });
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ listings });
    }

    const decoded = await verifyBearerToken(req);
    const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
    const id = cleanListingId(url.searchParams.get('id'));
    const action = cleanText(url.searchParams.get('action'), 40);

    if (req.method === 'POST' && action === 'decrement' && id) {
      const outcome = await decrementListing(req, id, decoded.uid);
      const statusCode = decrementHttpStatus(outcome.outcome);
      if (statusCode === 400) {
        return res.status(400).json({ error: 'Quantity must be a positive integer.' });
      }
      if (statusCode === 404) {
        return res.status(404).json({ error: 'Listing not found for this seller.' });
      }
      if (statusCode === 409) {
        return res.status(409).json({ error: 'Not enough quantity.', code: 'insufficient_quantity' });
      }
      return res.status(200).json({ listing: outcome.listing });
    }
    if (req.method === 'POST') {
      const created = await createListing(req, decoded);
      // Back-compat: desk clients that expect a bare listing still get listing fields
      // at the top level when a Pokoin row was created.
      if (created && created.listing === null) {
        return res.status(200).json(created);
      }
      return res.status(200).json(created);
    }
    if (req.method === 'PATCH' && id) {
      const listing = await updateListing(req, decoded, id);
      return res.status(200).json(listing);
    }

    res.setHeader('Allow', 'GET, POST, PATCH');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (error) {
    console.error('marketplace-listings failed', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Marketplace listings failed.',
    });
  } finally {
    finishRequest(span);
  }
};

if (!process.env.NODE_TEST_CONTEXT) startSync();

module.exports.readPublicOffersForCard = readPublicOffersForCard;
module.exports.readListings = readListings;

module.exports._test = {
  cleanLimit,
  cleanText,
  displaySellerName,
  enrichListingRowsWithSellerProfiles,
  enrichListingRowsWithCardUrls,
  isPublicCardPageListingRead,
  listingRow,
  normalizeMarketplaceGame,
  readLiveCardTraderListingsForCard,
  sourceListingIdForCardTrader,
  syntheticCardTraderListingRow,
};
