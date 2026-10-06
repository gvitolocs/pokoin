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
  crawlableCardImage,
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

test('zero Pokoin listings stay indexable as an ItemPage, not a bare Product', () => {
  const data = productStructuredData(card, { offers: [], currency: 'EUR' });
  assert.equal(data['@type'], 'ItemPage');
  assert.equal(data.url, 'https://pokoin.com/marketplace/en/cards/239000/card-charizard-4-102-base-set');
  assert.equal(data.name, 'Charizard');
  assert.equal(data.image, image);
  assert.equal(data.offers, undefined);
  assert.equal(data.review, undefined);
  assert.equal(data.aggregateRating, undefined);
  assert.equal(data.brand, undefined);
  assert.equal(JSON.stringify(data).includes('Product'), false);
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
  assert.equal(data['@type'], 'Product');
  assert.equal(data.brand.name, 'Pokémon TCG');
  assert.equal(data.offers['@type'], 'Offer');
  assert.equal(data.offers.availability, 'https://schema.org/OutOfStock');
  assert.equal(data.offers.price, '250.54');
  assert.equal(data.offers.priceCurrency, 'EUR');
  assert.equal(data.offers.url, data.url);
  assert.equal(data.review, undefined);
  assert.equal(data.aggregateRating, undefined);
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
  assert.equal(data['@type'], 'Product');
  assert.equal(data.brand.name, 'Pokémon TCG');
  assert.equal(data.offers['@type'], 'AggregateOffer');
  assert.equal(data.offers.lowPrice, '320.00');
  assert.equal(data.offers.highPrice, '320.00');
  assert.equal(data.offers.offerCount, 1);
  assert.equal(data.offers.priceCurrency, 'EUR');
  assert.equal(data.offers.availability, 'https://schema.org/InStock');
  assert.equal(data.offers.url, data.url);
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
  assert.equal(sold['@type'], 'ItemPage');
  assert.equal(sold.offers, undefined);
  assert.equal(sold.review, undefined);
  assert.equal(sold.aggregateRating, undefined);
});

test('card photos are the CDN file, never the pokoin.com redirect or the site logo', () => {
  assert.equal(
    crawlableCardImage('/card-images/261377_charizard-ex-special-illustration-rare-199-165-151.jpg'),
    'https://cdn.pokoin.com/261377_charizard-ex-special-illustration-rare-199-165-151.jpg',
  );
  assert.equal(
    crawlableCardImage('https://pokoin.com/card-images/one-piece/299280_tony-tony-chopper.jpg'),
    'https://cdn.pokoin.com/one-piece/299280_tony-tony-chopper.jpg',
  );
  assert.equal(crawlableCardImage('https://pokoin.com/pokoin-512.png'), '');
  assert.equal(crawlableCardImage('/home/missing-card.webp'), '');
  const data = productStructuredData({
    ...card,
    heroImageUrl: '/card-images/261377_charizard-ex.jpg',
  }, { offers: [listing()], currency: 'EUR' });
  assert.equal(data.image, 'https://cdn.pokoin.com/261377_charizard-ex.jpg');
  const logo = productStructuredData({
    ...card,
    heroImageUrl: 'https://pokoin.com/pokoin-512.png',
  }, { offers: [], currency: 'EUR' });
  assert.equal(logo.image, undefined);
  assert.equal(logo['@type'], 'ItemPage');
});

test('an unpinned PKN view still publishes the real EUR offer', () => {
  const data = productStructuredData(card, { offers: [listing()], currency: '' });
  assert.equal(data['@type'], 'Product');
  assert.equal(data.offers.priceCurrency, 'EUR');
  assert.equal(data.offers.lowPrice, '320.00');
  assert.equal(data.offers.availability, 'https://schema.org/InStock');
  assert.equal(data.offers.url, data.url);
  const pinned = productStructuredData(card, {
    offers: [],
    currency: 'PKN',
    referencePkn: 50108,
  });
  assert.equal(pinned.offers.priceCurrency, 'EUR');
  assert.equal(pinned.offers.price, '250.54');
  assert.equal(pinned.offers.availability, 'https://schema.org/OutOfStock');
});

test('a non-Pokémon card keeps its brand and game prefix, with or without an offer', () => {
  const chopper = {
    id: '598560',
    name: 'Tony Tony.Chopper',
    set: 'Two Legends',
    number: 'OP08-007a',
    canonicalPath: '/marketplace/en/cards/598560/alternate-art-tony-tony-chopper-op08-007a-op-08-two-legends',
    heroImageUrl: 'https://cdn.pokoin.com/one-piece/chopper.jpg',
  };
  const bare = productStructuredData(chopper, { offers: [], currency: 'EUR', game: 'one_piece' });
  assert.equal(bare['@type'], 'ItemPage');
  assert.equal(bare.offers, undefined);
  assert.equal(bare.review, undefined);
  assert.equal(bare.aggregateRating, undefined);
  assert.equal(
    bare.url,
    'https://pokoin.com/one-piece/marketplace/en/cards/598560/alternate-art-tony-tony-chopper-op08-007a-op-08-two-legends',
  );
  assert.equal(bare.image, chopper.heroImageUrl);
  const priced = productStructuredData(chopper, {
    offers: [],
    currency: 'EUR',
    game: 'one_piece',
    referencePkn: 1000,
  });
  assert.equal(priced['@type'], 'Product');
  assert.equal(priced.brand.name, 'One Piece');
  assert.equal(priced.url, bare.url);
  assert.equal(priced.offers.priceCurrency, 'EUR');
  assert.equal(priced.offers.availability, 'https://schema.org/OutOfStock');
  assert.equal(priced.offers.url, bare.url);
  assert.ok(priced.offers.price);
  const already = productStructuredData({
    ...chopper,
    canonicalPath: '/one-piece/marketplace/en/cards/598560/alternate-art-tony-tony-chopper-op08-007a-op-08-two-legends',
  }, { offers: [], game: 'one-piece' });
  assert.equal(already.url, bare.url);
  const student = productStructuredData({
    ...chopper,
    id: '795832',
    name: 'The Student Guides the Master',
    canonicalPath: '/marketplace/en/cards/795832/uncommon-the-student-guides-the-master',
  }, { offers: [listing()], currency: 'EUR', game: 'star_wars' });
  assert.equal(student['@type'], 'Product');
  assert.equal(student.brand.name, 'Star Wars');
  assert.match(student.url, /^https:\/\/pokoin\.com\/star-wars\/marketplace\/en\/cards\/795832\//);
  assert.equal(student.offers.url, student.url);
  assert.equal(student.offers.priceCurrency, 'EUR');
  const missingListing = productStructuredData(chopper, {
    offers: [],
    currency: 'EUR',
    game: 'one_piece',
    listingId: 'gone',
  });
  assert.equal(missingListing['@type'], 'ItemPage');
});
