const { marketplaceWriteQuery } = require('../server/_marketplace_db');
const {
  createProduct,
  destroyProduct,
  updateProduct,
} = require('./_cardtrader_client');
const {
  decryptIntegrationToken,
  readIntegrationDoc,
} = require('./_cardtrader_integration');

const PKN_USDT_PRICE = 0.005;

const CONDITION_TO_CT = {
  NM: 'Near Mint',
  LP: 'Slightly Played',
  MP: 'Moderately Played',
  HP: 'Heavily Played',
  PO: 'Poor',
};

const LANG_TO_CT = {
  EN: 'en',
  JP: 'jp',
  JA: 'jp',
  JPN: 'jp',
  KO: 'ko',
  KR: 'ko',
  ZH: 'zh',
  CN: 'zh',
  ZHS: 'zh',
  ZHT: 'zht',
  TW: 'zht',
  FR: 'fr',
  DE: 'de',
  IT: 'it',
  ES: 'es',
  PT: 'pt',
  ID: 'id',
  TH: 'th',
};

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeTargets(raw = {}) {
  const pokoin = raw.pokoin !== false && raw.pokoin !== 'false' && raw.pokoin !== 0;
  const cardtrader = raw.cardtrader === true || raw.cardtrader === 'true' || raw.cardtrader === 1;
  if (!pokoin && !cardtrader) {
    return { pokoin: true, cardtrader: false };
  }
  return { pokoin, cardtrader };
}

function eurFromPkn(pricePkn) {
  const pkn = Number(pricePkn);
  if (!Number.isFinite(pkn) || pkn <= 0) return null;
  return Math.round(pkn * PKN_USDT_PRICE * 100) / 100;
}

function leftoverBlueprintId(cardId) {
  const id = cleanText(cardId, 80);
  if (!/^\d+$/.test(id)) return null;
  try {
    const value = BigInt(id);
    if (value <= 0n) return null;
    if (value % 2n === 0n) return Number(value / 2n);
    return Number(value);
  } catch (_) {
    return null;
  }
}

function ctSourceListingId(productId) {
  return `ct:${cleanText(productId, 80)}`;
}

function parseCtProductId(sourceListingId) {
  const raw = cleanText(sourceListingId, 160);
  const match = raw.match(/^(?:ct|cardtrader):(\d+)$/i);
  return match ? match[1] : '';
}

function pokoinUserDataField(listingId) {
  const id = cleanText(listingId, 80);
  return id ? `pokoin:${id}` : '';
}

function parsePokoinListingId(userDataField) {
  const raw = cleanText(userDataField, 160);
  const match = raw.match(/^pokoin:([0-9a-f-]{36})$/i);
  return match ? match[1] : '';
}

function ctCondition(condition) {
  const short = cleanText(condition, 20).toUpperCase();
  return CONDITION_TO_CT[short] || 'Near Mint';
}

function ctLanguage(language) {
  const code = cleanText(language, 10).toUpperCase();
  return LANG_TO_CT[code] || 'en';
}

function buildProductBody(listing = {}) {
  const blueprintId = leftoverBlueprintId(listing.cardId || listing.card_id);
  if (!blueprintId) {
    const error = new Error('CardTrader listing needs a CardTrader blueprint id.');
    error.statusCode = 400;
    throw error;
  }
  const price = eurFromPkn(listing.pricePkn ?? listing.price_pkn);
  if (price == null || price <= 0) {
    const error = new Error('CardTrader listing needs a positive EUR price.');
    error.statusCode = 400;
    throw error;
  }
  const quantity = Math.max(1, Math.trunc(Number(listing.quantityAvailable ?? listing.quantity_available) || 1));
  const foilState = cleanText(listing.foilState || listing.foil_state, 40).toLowerCase();
  const properties = {
    condition: ctCondition(listing.condition),
    pokemon_language: ctLanguage(listing.language),
    signed: listing.signed === true,
    altered: listing.altered === true,
  };
  if (foilState === 'reverse' || listing.reverse === true) {
    properties.pokemon_reverse = true;
  }
  if (listing.firstEdition === true || listing.first_edition === true) {
    properties.pokemon_first_edition = true;
  }
  const body = {
    blueprint_id: blueprintId,
    price,
    quantity,
    graded: listing.graded === true,
    properties,
  };
  const userData = pokoinUserDataField(listing.id || listing.listingId);
  if (userData) {
    body.user_data_field = userData;
  }
  if (listing.sellerComment || listing.seller_comment) {
    body.description = cleanText(listing.sellerComment || listing.seller_comment, 500);
  }
  return body;
}

function productIdFromCreateResponse(payload) {
  const resource = payload?.resource || payload?.product || payload;
  const id = resource?.id ?? payload?.id;
  return id != null && String(id).trim() ? String(id).trim() : '';
}

async function pushListingToCardTrader({ firestore, uid, listing }) {
  const token = await decryptIntegrationToken(firestore, uid);
  const body = buildProductBody(listing);
  const payload = await createProduct(token, body);
  const productId = productIdFromCreateResponse(payload);
  if (!productId) {
    const error = new Error('CardTrader did not return a product id.');
    error.statusCode = 502;
    throw error;
  }
  return { productId, sourceListingId: ctSourceListingId(productId) };
}

async function linkListingToCardTraderProduct(listingId, productId, {
  sellerUid = '',
  blueprintId = '',
  quantity = 0,
} = {}) {
  const sourceListingId = ctSourceListingId(productId);
  const result = await marketplaceWriteQuery(
    `
      update public.marketplace_user_listings
      set source_listing_id = $2, updated_at = now()
      where id = $1
      returning id, source_listing_id, card_id, seller_uid, quantity_available
    `,
    [listingId, sourceListingId],
  );
  const row = result.rows[0] || null;
  if (row && (sellerUid || row.seller_uid)) {
    try {
      await marketplaceWriteQuery(
        `
          insert into public.marketplace_cardtrader_product_links (
            seller_uid, ct_product_id, listing_id, blueprint_id,
            last_ct_quantity, last_seen_at, origin, missing_from_ct, updated_at
          )
          values ($1, $2, $3::uuid, $4, $5, now(), 'push', false, now())
          on conflict (seller_uid, ct_product_id) do update set
            listing_id = excluded.listing_id,
            blueprint_id = excluded.blueprint_id,
            last_ct_quantity = excluded.last_ct_quantity,
            last_seen_at = now(),
            origin = 'push',
            missing_from_ct = false,
            updated_at = now()
        `,
        [
          sellerUid || row.seller_uid,
          cleanText(productId, 80),
          row.id,
          cleanText(blueprintId, 80),
          Math.max(0, Math.trunc(Number(quantity) || Number(row.quantity_available) || 0)),
        ],
      );
    } catch (error) {
      if (!/does not exist/i.test(String(error.message || ''))) throw error;
    }
  }
  return row;
}

async function pushAndLinkListing({ firestore, uid, listing }) {
  const pushed = await pushListingToCardTrader({ firestore, uid, listing });
  if (listing.id) {
    await linkListingToCardTraderProduct(listing.id, pushed.productId, {
      sellerUid: uid,
      blueprintId: leftoverBlueprintId(listing.cardId || listing.card_id) || '',
      quantity: listing.quantityAvailable ?? listing.quantity_available,
    });
  }
  return pushed;
}

async function destroyLinkedCardTraderProduct({ firestore, uid, sourceListingId, quantity }) {
  const productId = parseCtProductId(sourceListingId);
  if (!productId) return { skipped: true, reason: 'not_linked' };
  const doc = await readIntegrationDoc(firestore, uid);
  if (!doc.exists || doc.data()?.enabled !== true) {
    return { skipped: true, reason: 'not_connected' };
  }
  const token = await decryptIntegrationToken(firestore, uid);
  const qty = Number(quantity);
  if (Number.isFinite(qty) && qty > 0) {
    try {
      await updateProduct(token, productId, { quantity: 0 });
    } catch (_) {
      // Fall through to destroy.
    }
  }
  try {
    await destroyProduct(token, productId);
    return { ok: true, productId };
  } catch (error) {
    console.error('cardtrader destroy linked product failed', {
      uid,
      productId,
      message: error.message,
    });
    return { ok: false, productId, error: error.message };
  }
}

async function decrementLinkedCardTraderProduct({
  firestore,
  uid,
  sourceListingId,
  quantity,
  remainingQuantity,
}) {
  const productId = parseCtProductId(sourceListingId);
  if (!productId) return { skipped: true, reason: 'not_linked' };
  const doc = await readIntegrationDoc(firestore, uid);
  if (!doc.exists || doc.data()?.enabled !== true) {
    return { skipped: true, reason: 'not_connected' };
  }
  const token = await decryptIntegrationToken(firestore, uid);
  const remaining = Number(remainingQuantity);
  try {
    if (Number.isFinite(remaining) && remaining > 0) {
      await updateProduct(token, productId, { quantity: Math.trunc(remaining) });
      return { ok: true, productId, remaining: Math.trunc(remaining) };
    }
    await destroyProduct(token, productId);
    return {
      ok: true,
      productId,
      destroyed: true,
      quantity: Math.max(1, Math.trunc(Number(quantity) || 1)),
    };
  } catch (error) {
    console.error('cardtrader decrement linked product failed', {
      uid,
      productId,
      message: error.message,
    });
    return { ok: false, productId, error: error.message };
  }
}

module.exports = {
  PKN_USDT_PRICE,
  buildProductBody,
  ctSourceListingId,
  decrementLinkedCardTraderProduct,
  destroyLinkedCardTraderProduct,
  eurFromPkn,
  leftoverBlueprintId,
  linkListingToCardTraderProduct,
  normalizeTargets,
  parseCtProductId,
  parsePokoinListingId,
  pokoinUserDataField,
  productIdFromCreateResponse,
  pushAndLinkListing,
  pushListingToCardTrader,
};
