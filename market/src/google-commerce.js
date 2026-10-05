/** Google product discovery helpers shared by the SPA, crawler HTML, and Merchant sync.
 * Prices come from market/src/pkn.js (the same PKN → EUR cent rounding as checkout).
 * Canonical card URLs stay /marketplace/{lang}/cards/{id}/{slug}.
 */

import { displayName, printingIdentity } from './identity.js';
import {
  moneyFromEurCents,
  moneyFromPkn,
} from './pkn.js';

export const MERCHANT_CURRENCIES = ['EUR', 'DKK'];
export const SCHEMA = 'https://schema.org';

const PURCHASABLE_STATUS = new Set(['', 'active']);

export function offerIdFor(listingId, currency) {
  const id = String(listingId || '').trim();
  const code = String(currency || '').trim().toUpperCase();
  if (!id || !code) return '';
  return `pokoin-${id}-${code}`;
}

export function validGtin(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return '';
  const body = digits.slice(0, -1);
  const check = Number(digits.slice(-1));
  let sum = 0;
  const reversed = [...body].reverse();
  reversed.forEach((digit, index) => {
    const weight = index % 2 === 0 ? 3 : 1;
    sum += Number(digit) * weight;
  });
  const calc = (10 - (sum % 10)) % 10;
  return calc === check ? digits : '';
}

/** Real GTIN only. Card numbers and internal ids never become a GTIN or MPN. */
export function identifierFields(listing = {}) {
  const raw = listing.gtin || listing.ean || listing.upc || '';
  const gtin = validGtin(raw);
  if (gtin) {
    return { identifierExists: true, gtins: [gtin], ignoredRaw: '' };
  }
  return {
    identifierExists: false,
    gtins: [],
    ignoredRaw: String(raw || '').trim(),
  };
}

/**
 * Pokoin keeps NM / LP / EX on the desk. Google Merchant condition is NEW or USED.
 * Sealed products are NEW. Graded and played singles are USED.
 */
export function conditionMapping(listing = {}) {
  const pokoin = String(listing.condition || 'NM').trim().toUpperCase() || 'NM';
  const sealed = listing.sealed === true || pokoin === 'SEALED';
  if (sealed && listing.graded !== true) {
    return {
      pokoin: listing.sealed === true ? pokoin : 'SEALED',
      schema: `${SCHEMA}/NewCondition`,
      merchant: 'NEW',
    };
  }
  return {
    pokoin,
    schema: `${SCHEMA}/UsedCondition`,
    merchant: 'USED',
  };
}

export function isPurchasableListing(listing) {
  if (!listing) return false;
  const source = String(listing.source || '').toLowerCase();
  if (source === 'cardtrader_live' || source === 'cardtrader') return false;
  if (listing.reserveAvailable === true) return false;
  if (!String(listing.sellerUid || listing.seller_uid || '').trim()) return false;
  const status = String(listing.status || 'active').toLowerCase();
  if (!PURCHASABLE_STATUS.has(status)) return false;
  const qty = Number(listing.quantityAvailable ?? listing.quantity_available ?? 0);
  if (!Number.isFinite(qty) || qty <= 0) return false;
  const price = Number(listing.pricePkn ?? listing.price_pkn ?? 0);
  if (!Number.isFinite(price) || price <= 0) return false;
  if (listing.shippingAvailable === false || listing.shipping_available === false) return false;
  return true;
}

export function inactiveReason(listing) {
  if (!listing) return 'NOT_ACTIVE';
  const source = String(listing.source || '').toLowerCase();
  if (source === 'cardtrader_live' || source === 'cardtrader' || listing.reserveAvailable === true) {
    return 'SELLER_NOT_ELIGIBLE';
  }
  if (!String(listing.sellerUid || listing.seller_uid || '').trim()) return 'SELLER_NOT_ELIGIBLE';
  const status = String(listing.status || 'active').toLowerCase();
  const qty = Number(listing.quantityAvailable ?? listing.quantity_available ?? 0);
  if (!PURCHASABLE_STATUS.has(status) || qty <= 0) return 'NOT_ACTIVE';
  const price = Number(listing.pricePkn ?? listing.price_pkn ?? 0);
  if (!(price > 0)) return 'NO_PRICE';
  if (listing.shippingAvailable === false) return 'SHIPPING_NOT_SUPPORTED';
  return '';
}

export function purchasableOffers(offers) {
  return (offers || []).filter((row) => isPurchasableListing(row));
}

export function countriesForCurrency(currency, countries = []) {
  const code = String(currency || '').trim().toUpperCase();
  const list = (countries || []).map((country) => String(country || '').trim().toUpperCase()).filter(Boolean);
  if (code === 'DKK') return list.filter((country) => country === 'DK');
  if (code === 'USD') return list.filter((country) => country === 'US');
  if (code === 'EUR') return list.filter((country) => country !== 'DK' && country !== 'US');
  return [];
}

export function cardCanonicalUrl({ origin = 'https://pokoin.com', canonicalPath, cardId } = {}) {
  const path = String(canonicalPath || '').trim() || (cardId ? `/marketplace/en/cards/${cardId}` : '/marketplace');
  const url = new URL(path, origin);
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function cardLandingUrl({
  origin = 'https://pokoin.com',
  canonicalPath,
  cardId,
  currency,
  listingId,
} = {}) {
  const url = new URL(cardCanonicalUrl({ origin, canonicalPath, cardId }));
  const code = String(currency || '').trim().toUpperCase();
  if (code) url.searchParams.set('currency', code);
  if (listingId) url.searchParams.set('listing', String(listingId));
  return url.toString();
}

function absoluteImage(image, origin) {
  const raw = String(image || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  return `${String(origin || 'https://pokoin.com').replace(/\/$/, '')}${path}`;
}

function productName(card, listing) {
  return displayName(card) || listing?.cardName || listing?.name || 'Pokémon card';
}

export function explainListing(listing, {
  currency = 'EUR',
  shipping = [],
  currencies = MERCHANT_CURRENCIES,
  image = '',
} = {}) {
  const code = String(currency || '').trim().toUpperCase();
  const offerId = offerIdFor(listing?.id, code);
  const base = {
    listingId: String(listing?.id || ''),
    offerId,
    currency: code,
    externalSellerId: String(listing?.sellerUid || listing?.seller_uid || ''),
  };
  const inactive = inactiveReason(listing);
  if (inactive) return { ...base, reason: inactive };
  const picture = image || listing?.cardImageUrl || listing?.imageUrl || '';
  if (!String(picture).trim()) return { ...base, reason: 'MISSING_IMAGE' };
  if (!currencies.map((row) => String(row).toUpperCase()).includes(code)) {
    return { ...base, reason: 'CURRENCY_NOT_SUPPORTED' };
  }
  if (!moneyFromPkn(listing.pricePkn ?? listing.price_pkn, code)) {
    return { ...base, reason: 'NO_PRICE' };
  }
  if (!Array.isArray(shipping) || shipping.length === 0) {
    return { ...base, reason: 'SHIPPING_NOT_SUPPORTED' };
  }
  return { ...base, reason: 'ELIGIBLE' };
}

export function buildMerchantProduct({
  listing,
  card = {},
  currency,
  shipping = [],
  origin = 'https://pokoin.com',
  contentLanguage = 'en',
  feedLabel,
  currencies = MERCHANT_CURRENCIES,
} = {}) {
  const code = String(currency || '').trim().toUpperCase();
  const image = absoluteImage(
    card.heroImageUrl || card.imageUrl || listing?.cardImageUrl || '',
    origin,
  );
  const diagnosis = explainListing(listing, { currency: code, shipping, currencies, image });
  const label = feedLabel || (code === 'DKK' ? 'DK' : 'EU');
  const canonicalPath = card.canonicalPath || listing?.canonicalPath || '';
  const link = cardLandingUrl({
    origin,
    canonicalPath,
    cardId: card.id || listing?.cardId,
    currency: code,
    listingId: listing?.id,
  });
  if (diagnosis.reason !== 'ELIGIBLE') {
    return { eligible: false, reason: diagnosis.reason, offerId: diagnosis.offerId, feedLabel: label, input: null };
  }
  const money = moneyFromPkn(listing.pricePkn ?? listing.price_pkn, code);
  const identifiers = identifierFields(listing);
  const condition = conditionMapping(listing);
  const identity = printingIdentity({
    ...card,
    name: productName(card, listing),
    set: card.set || card.set_name || listing?.setName,
    number: card.number || card.card_number || listing?.collectorNumber,
  });
  const titleBits = [productName(card, listing), identity.number, identity.set, condition.pokoin].filter(Boolean);
  const input = {
    offerId: diagnosis.offerId,
    contentLanguage,
    feedLabel: label,
    productAttributes: {
      title: titleBits.join(' ').slice(0, 150),
      description: [
        productName(card, listing),
        identity.number,
        identity.set,
        `Condition ${condition.pokoin}`,
        'Sold by an independent Pokoin seller.',
      ].filter(Boolean).join(' · ').slice(0, 5000),
      link,
      imageLink: image,
      availability: 'IN_STOCK',
      condition: condition.merchant,
      price: {
        amountMicros: money.amountMicros,
        currencyCode: money.currency,
      },
      brand: 'Pokemon',
      identifierExists: identifiers.identifierExists,
      externalSellerId: diagnosis.externalSellerId,
      shipping: shipping.map((row) => ({
        country: row.country,
        price: {
          amountMicros: row.amountMicros,
          currencyCode: row.currency,
        },
      })),
    },
  };
  if (identifiers.gtins.length) {
    input.productAttributes.gtins = identifiers.gtins;
  }
  return {
    eligible: true,
    reason: 'ELIGIBLE',
    offerId: diagnosis.offerId,
    feedLabel: label,
    input,
    display: money,
    stripe: { currency: 'EUR', amountCents: money.eurCents },
    condition,
    identifiers,
    link,
    canonical: cardCanonicalUrl({
      origin,
      canonicalPath,
      cardId: card.id || listing?.cardId,
    }),
  };
}

export function shippingMoney(eurCents, currency) {
  return moneyFromEurCents(eurCents, currency);
}

function offerNode(listing, currency, landing) {
  const money = moneyFromPkn(listing.pricePkn ?? listing.price_pkn, currency);
  if (!money || money.currency === 'PKN') return null;
  const condition = conditionMapping(listing);
  return {
    '@type': 'Offer',
    price: money.amount,
    priceCurrency: money.currency,
    availability: `${SCHEMA}/InStock`,
    itemCondition: condition.schema,
    url: landing,
    seller: {
      '@type': 'Organization',
      name: String(listing.sellerName || listing.sellerDisplayName || 'Pokoin seller'),
    },
  };
}

/**
 * Shopping row for one printing. In stock only when a Pokoin seller can fulfill it.
 * Otherwise the market minimum is the price, with availability out of stock.
 */
export function shoppingCondition(productType) {
  const kind = String(productType || 'card').trim().toLowerCase();
  if (!kind || kind === 'card' || kind === 'single') return 'used';
  return 'new';
}

export function catalogShoppingOffer({
  nativePkn = 0,
  nativeQty = 0,
  marketPkn = 0,
  currency = 'EUR',
} = {}) {
  const native = Number(nativePkn);
  const qty = Number(nativeQty);
  const market = Number(marketPkn);
  const code = String(currency || '').trim().toUpperCase();
  if (native > 0 && qty > 0) {
    const money = moneyFromPkn(native, code);
    if (!money || money.currency === 'PKN') return null;
    return { availability: 'in_stock', pricePkn: native, money, source: 'pokoin' };
  }
  const price = market > 0 ? market : (native > 0 ? native : 0);
  if (!(price > 0)) return null;
  const money = moneyFromPkn(price, code);
  if (!money || money.currency === 'PKN') return null;
  return { availability: 'out_of_stock', pricePkn: price, money, source: market > 0 ? 'market' : 'pokoin' };
}

/** Product JSON-LD. In stock only for a purchasable Pokoin listing. */
export function productStructuredData(card = {}, {
  url,
  offers,
  currency = '',
  listingId = '',
  origin = 'https://pokoin.com',
  referencePkn = 0,
} = {}) {
  const identity = printingIdentity(card);
  const canonical = cardCanonicalUrl({
    origin,
    canonicalPath: card.canonicalPath || card.canonical_path,
    cardId: card.id,
  });
  const image = absoluteImage(card.heroImageUrl || card.imageUrl || card.gridImageUrl || '', origin);
  const active = purchasableOffers(offers);
  const code = String(currency || '').trim().toUpperCase();
  const product = {
    '@context': SCHEMA,
    '@type': 'Product',
    name: displayName(card) || card.name || '',
    description: catalogDescription(card, active.length),
    sku: String(card.id || ''),
    image,
    brand: { '@type': 'Brand', name: 'Pokémon TCG' },
    url: canonical || url || '',
    additionalProperty: [
      identity.set ? { '@type': 'PropertyValue', name: 'set', value: identity.set } : null,
      identity.number ? { '@type': 'PropertyValue', name: 'number', value: identity.number } : null,
      identity.rarity ? { '@type': 'PropertyValue', name: 'rarity', value: identity.rarity } : null,
      identity.artist ? { '@type': 'PropertyValue', name: 'artist', value: identity.artist } : null,
    ].filter(Boolean),
  };
  if (!code || code === 'PKN') return product;
  if (listingId) {
    const one = active.find((row) => String(row.id) === String(listingId));
    const node = one
      ? offerNode(one, code, cardLandingUrl({
        origin,
        canonicalPath: card.canonicalPath || card.canonical_path,
        cardId: card.id,
        currency: code,
        listingId,
      }))
      : null;
    if (node) product.offers = node;
    return product;
  }
  const priced = active
    .map((row) => moneyFromPkn(row.pricePkn ?? row.price_pkn, code))
    .filter(Boolean);
  if (!priced.length) {
    const market = moneyFromPkn(referencePkn || card.referencePkn || card.reference_pkn, code);
    if (market && market.currency !== 'PKN') {
      product.offers = {
        '@type': 'Offer',
        price: market.amount,
        priceCurrency: market.currency,
        availability: `${SCHEMA}/OutOfStock`,
        url: canonical || url || '',
      };
    }
    return product;
  }
  const amounts = priced.map((row) => Number(row.amount));
  product.offers = {
    '@type': 'AggregateOffer',
    priceCurrency: code,
    lowPrice: Math.min(...amounts).toFixed(2),
    highPrice: Math.max(...amounts).toFixed(2),
    offerCount: priced.length,
    availability: `${SCHEMA}/InStock`,
  };
  return product;
}

export function aggregateLabel(card, offers, currency) {
  const active = purchasableOffers(offers);
  const code = String(currency || '').trim().toUpperCase();
  if (!active.length || !code || code === 'PKN') return '';
  const priced = active
    .map((row) => moneyFromPkn(row.pricePkn ?? row.price_pkn, code))
    .filter(Boolean);
  if (!priced.length) return '';
  const low = Math.min(...priced.map((row) => Number(row.amount))).toFixed(2);
  const noun = active.length === 1 ? 'listing' : 'listings';
  return `${active.length} Pokoin ${noun} from ${low} ${code}`;
}

function catalogDescription(card, offerCount) {
  const identity = printingIdentity(card);
  const bits = [displayName(card), identity.number, identity.set, identity.rarity].filter(Boolean);
  const base = bits.join(' · ');
  if (offerCount > 0) {
    const noun = offerCount === 1 ? 'listing' : 'listings';
    return `${base}. ${offerCount} Pokoin ${noun} currently for sale.`;
  }
  return `${base}. Pokoin catalog page. No Pokoin listing is currently for sale.`;
}
