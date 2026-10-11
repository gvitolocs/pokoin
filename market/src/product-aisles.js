import { fetchGradedCards, fetchSearch } from './api.js';

/** /product/:kind aisles (Products page): one marketplace search or the graded-listing list each. */
export const PRODUCT_AISLES = {
  box: {
    title: 'Booster boxes',
    query: 'booster box',
    productType: 'booster_box',
    unit: 'products',
    lede: 'Marketplace search for booster boxes.',
  },
  pack: {
    title: 'Booster packs',
    query: 'booster',
    productType: 'booster_pack',
    unit: 'products',
    lede: 'Marketplace search for booster packs.',
  },
  graded: {
    title: 'Graded cards',
    mode: 'graded',
    unit: 'cards',
    lede: 'PSA, BGS, CGC, and other slabbed listings from sellers on Pokoin.',
  },
  jumbo: {
    title: 'Jumbo cards',
    query: 'jumbo oversized',
    productType: 'jumbo',
    unit: 'cards',
    lede: 'Oversized jumbo printings — their own product type, across every era.',
  },
  nft: {
    title: 'NFT',
    query: 'nft',
    productType: '',
    unit: 'products',
    lede: 'Live NFT catalog search. Owned holdings and shipping requests live on MyPokoin → Collection after nft_only checkout.',
  },
};

/** The aisle for a route kind; unknown kinds show booster boxes. */
export function productAisle(kind) {
  return PRODUCT_AISLES[kind] || PRODUCT_AISLES.box;
}

export function loadAisle(spec, { offset = 0, limit = 48 } = {}) {
  if (spec.mode === 'graded') {
    return fetchGradedCards({ limit });
  }
  return fetchSearch({
    query: spec.query,
    productType: spec.productType,
    offset,
    limit,
  });
}

export function aisleEmptyLede(kind) {
  return kind === 'graded'
    ? 'No active PSA / BGS / CGC listings yet. List a graded card from inventory or Scan Connect.'
    : 'Try another product type or search from the bar.';
}
