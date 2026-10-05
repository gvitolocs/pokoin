import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateLabel,
  buildMerchantProduct,
  cardCanonicalUrl,
  cardLandingUrl,
  catalogShoppingOffer,
  conditionMapping,
  explainListing,
  identifierFields,
  offerIdFor,
  productStructuredData,
  purchasableOffers,
  shoppingCondition,
  validGtin,
} from './google-commerce.js';
import { eurCentsFromPkn, moneyFromPkn } from './pkn.js';

const image = 'https://cdn.pokoin.com/cards/239000.jpg';
const card = {
  id: '239000',
  name: 'Charizard',
  set: 'Base Set',
  number: '4/102',
  artist: 'Mitsuhiro Arita',
  canonicalPath: '/marketplace/en/cards/239000/card-charizard-4-102-base-set',
  heroImageUrl: image,
};

function listing(overrides = {}) {
  return {
    id: 'lst-a',
    sellerUid: 'seller-a',
    sellerName: 'Seller A',
    sellerCountry: 'DE',
    condition: 'NM',
    pricePkn: 64000,
    quantityAvailable: 1,
    status: 'active',
    shippingAvailable: true,
    cardImageUrl: image,
    cardName: 'Charizard',
    setName: 'Base Set',
    collectorNumber: '4/102',
    canonicalPath: card.canonicalPath,
    ...overrides,
  };
}

test('zero Pokoin listings stay indexable without a purchasable offer', () => {
  const data = productStructuredData(card, { offers: [], currency: 'EUR' });
  assert.equal(data['@type'], 'Product');
  assert.equal(data.url, 'https://pokoin.com/marketplace/en/cards/239000/card-charizard-4-102-base-set');
  assert.equal(data.offers, undefined);
  assert.equal(JSON.stringify(data).includes('InStock'), false);
  assert.match(data.description, /No Pokoin listing is currently for sale/);
});

test('a market minimum is out of stock at the same EUR cents as checkout', () => {
  const offer = catalogShoppingOffer({
    nativePkn: 0,
    marketPkn: 50108,
    currency: 'EUR',
  });
  assert.equal(offer.availability, 'out_of_stock');
  assert.equal(offer.money.amount, '250.54');
  assert.equal(offer.money.eurCents, eurCentsFromPkn(50108));
  const data = productStructuredData(card, {
    offers: [],
    currency: 'EUR',
    referencePkn: 50108,
  });
  assert.equal(data.offers.availability, 'https://schema.org/OutOfStock');
  assert.equal(data.offers.price, '250.54');
  assert.equal(data.offers.priceCurrency, 'EUR');
  assert.equal(data.offers.availability.endsWith('/OutOfStock'), true);
  const stocked = catalogShoppingOffer({
    nativePkn: 140,
    nativeQty: 1,
    marketPkn: 50108,
    currency: 'DKK',
  });
  assert.equal(stocked.availability, 'in_stock');
  assert.equal(stocked.money.amount, moneyFromPkn(140, 'DKK').amount);
  assert.equal(shoppingCondition('card'), 'used');
  assert.equal(shoppingCondition('booster_box'), 'new');
});

test('one active listing builds AggregateOffer, Offer, and a Merchant product', () => {
  const row = listing();
  const data = productStructuredData(card, { offers: [row], currency: 'EUR' });
  assert.equal(data.offers['@type'], 'AggregateOffer');
  assert.equal(data.offers.lowPrice, '320.00');
  assert.equal(data.offers.highPrice, '320.00');
  assert.equal(data.offers.offerCount, 1);
  assert.equal(data.offers.priceCurrency, 'EUR');
  const single = productStructuredData(card, { offers: [row], currency: 'EUR', listingId: 'lst-a' });
  assert.equal(single.offers['@type'], 'Offer');
  assert.equal(single.offers.price, '320.00');
  assert.equal(single.offers.itemCondition, 'https://schema.org/UsedCondition');
  assert.equal(single.offers.seller.name, 'Seller A');
  const built = buildMerchantProduct({
    listing: row,
    card,
    currency: 'EUR',
    shipping: [{ country: 'IT', currency: 'EUR', amountMicros: '6990000', amount: '6.99' }],
  });
  assert.equal(built.eligible, true);
  assert.equal(built.input.offerId, 'pokoin-lst-a-EUR');
  assert.equal(built.input.productAttributes.price.amountMicros, moneyFromPkn(64000, 'EUR').amountMicros);
  assert.equal(built.stripe.amountCents, eurCentsFromPkn(64000));
  assert.equal(built.stripe.currency, 'EUR');
  assert.equal(built.input.productAttributes.externalSellerId, 'seller-a');
  assert.equal(built.input.productAttributes.identifierExists, false);
  assert.equal(built.input.productAttributes.gtins, undefined);
  assert.equal(built.input.productAttributes.mpn, undefined);
});

test('multiple listings exclude sold rows from low, high, and offerCount', () => {
  const offers = [
    listing({ id: 'a', pricePkn: 64000, condition: 'NM' }),
    listing({ id: 'b', sellerUid: 'seller-b', pricePkn: 49000, condition: 'LP' }),
    listing({ id: 'c', sellerUid: 'seller-c', pricePkn: 1000, status: 'sold_out', quantityAvailable: 0 }),
    listing({ id: 'd', sellerUid: 'seller-d', source: 'cardtrader_live', pricePkn: 10 }),
  ];
  assert.equal(purchasableOffers(offers).length, 2);
  const data = productStructuredData(card, { offers, currency: 'EUR' });
  assert.equal(data.offers.offerCount, 2);
  assert.equal(data.offers.lowPrice, '245.00');
  assert.equal(data.offers.highPrice, '320.00');
});

test('EUR and DKK landing URLs stay on one canonical and match checkout cents', () => {
  const row = listing();
  const eur = cardLandingUrl({ canonicalPath: card.canonicalPath, currency: 'EUR', listingId: row.id });
  const dkk = cardLandingUrl({ canonicalPath: card.canonicalPath, currency: 'DKK', listingId: row.id });
  assert.equal(cardCanonicalUrl({ canonicalPath: card.canonicalPath }), 'https://pokoin.com/marketplace/en/cards/239000/card-charizard-4-102-base-set');
  assert.match(eur, /\?currency=EUR&listing=lst-a$/);
  assert.match(dkk, /\?currency=DKK&listing=lst-a$/);
  const eurMoney = moneyFromPkn(64000, 'EUR');
  const dkkMoney = moneyFromPkn(64000, 'DKK');
  assert.equal(eurMoney.amount, '320.00');
  assert.equal(dkkMoney.amount, '2400.00');
  assert.equal(eurMoney.eurCents, 32000);
  assert.equal(dkkMoney.eurCents, 32000);
  const eurLd = productStructuredData(card, { offers: [row], currency: 'EUR' });
  const dkkLd = productStructuredData(card, { offers: [row], currency: 'DKK' });
  assert.equal(eurLd.offers.lowPrice, '320.00');
  assert.equal(dkkLd.offers.lowPrice, '2400.00');
  assert.equal(eurLd.url, cardCanonicalUrl({ canonicalPath: card.canonicalPath }));
  assert.equal(aggregateLabel(card, [row], 'DKK'), '1 Pokoin listing from 2400.00 DKK');
});

test('a price change keeps schema, merchant payload, and stripe on the same cents', () => {
  const before = listing({ pricePkn: 21000 });
  const after = listing({ pricePkn: 19800 });
  const shipping = [{ country: 'IT', currency: 'EUR', amountMicros: '6990000' }];
  const first = buildMerchantProduct({ listing: before, card, currency: 'EUR', shipping });
  const second = buildMerchantProduct({ listing: after, card, currency: 'EUR', shipping });
  assert.equal(first.offerId, second.offerId);
  assert.equal(offerIdFor(before.id, 'EUR'), 'pokoin-lst-a-EUR');
  assert.equal(productStructuredData(card, { offers: [before], currency: 'EUR' }).offers.lowPrice, '105.00');
  assert.equal(productStructuredData(card, { offers: [after], currency: 'EUR' }).offers.lowPrice, '99.00');
  assert.equal(second.display.amount, '99.00');
  assert.equal(second.stripe.amountCents, 9900);
});

test('invalid identifiers are dropped and card numbers are not GTINs', () => {
  assert.equal(validGtin('4/102'), '');
  assert.equal(validGtin('239000'), '');
  assert.equal(identifierFields(listing({ gtin: '4/102' })).identifierExists, false);
  const built = buildMerchantProduct({
    listing: listing({ gtin: 'not-a-gtin', collectorNumber: '4/102' }),
    card,
    currency: 'EUR',
    shipping: [{ country: 'IT', currency: 'EUR', amountMicros: '1' }],
  });
  assert.equal(built.input.productAttributes.identifierExists, false);
  assert.equal(JSON.stringify(built.input).includes('4/102') ? built.input.productAttributes.gtins : undefined, undefined);
});

test('a sealed product with a real GTIN is NEW', () => {
  const gtin = '4006381333931';
  assert.equal(validGtin(gtin), gtin);
  const row = listing({
    id: 'box-1',
    sealed: true,
    condition: 'NM',
    gtin,
    cardName: 'Base Set Booster Box',
  });
  assert.equal(conditionMapping(row).merchant, 'NEW');
  assert.equal(conditionMapping(listing({ condition: 'LP' })).merchant, 'USED');
  assert.equal(conditionMapping(listing({ condition: 'NM' })).pokoin, 'NM');
  const built = buildMerchantProduct({
    listing: row,
    card: { ...card, name: 'Base Set Booster Box' },
    currency: 'EUR',
    shipping: [{ country: 'IT', currency: 'EUR', amountMicros: '1' }],
  });
  assert.equal(built.input.productAttributes.condition, 'NEW');
  assert.deepEqual(built.input.productAttributes.gtins, [gtin]);
  assert.equal(built.input.productAttributes.identifierExists, true);
});

test('missing shipping or a dead listing is not eligible', () => {
  assert.equal(explainListing(listing({ status: 'sold_out', quantityAvailable: 0 }), {
    currency: 'EUR',
    shipping: [{ country: 'IT' }],
    image,
  }).reason, 'NOT_ACTIVE');
  assert.equal(explainListing(listing(), { currency: 'EUR', shipping: [], image }).reason, 'SHIPPING_NOT_SUPPORTED');
  assert.equal(explainListing(listing({ pricePkn: 0 }), { currency: 'EUR', shipping: [{}], image }).reason, 'NO_PRICE');
  assert.equal(explainListing(listing({ cardImageUrl: '' }), {
    currency: 'EUR',
    shipping: [{ country: 'IT' }],
    image: '',
  }).reason, 'MISSING_IMAGE');
  const sold = productStructuredData(card, {
    offers: [listing({ status: 'sold_out', quantityAvailable: 0 })],
    currency: 'EUR',
  });
  assert.equal(sold.offers, undefined);
});
