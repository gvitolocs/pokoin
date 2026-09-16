/** Titles, JSON-LD, related-card scoring, and hub paths for marketplace SEO. */
import { cardDocumentTitle, displayName, printingIdentity } from './identity.js';
import { speciesFromCard, speciesFromSlug } from './pokemon-hubs.js';
import { pokedexNumber } from './pokedex.js';

export const RARITY_HUBS = [
  { slug: 'common', name: 'Common' },
  { slug: 'uncommon', name: 'Uncommon' },
  { slug: 'rare', name: 'Rare' },
  { slug: 'holo-rare', name: 'Holo Rare' },
  { slug: 'ultra-rare', name: 'Ultra Rare' },
  { slug: 'full-art', name: 'Full-Art' },
  { slug: 'illustration-rare', name: 'Illustration Rare' },
  { slug: 'special-illustration-rare', name: 'Special Illustration Rare' },
  { slug: 'secret-rare', name: 'Secret Rare' },
  { slug: 'gold-secret-rare', name: 'Gold Secret Rare' },
  { slug: 'shiny-rare', name: 'Shiny Rare' },
  { slug: 'hyper-rare', name: 'Hyper Rare' },
  { slug: 'rainbow-rare', name: 'Rainbow Rare' },
  { slug: 'promo', name: 'Promo' },
  { slug: 'character-rare', name: 'Character Rare' },
];

export const LANGUAGE_HUBS = [
  { slug: 'english', name: 'English', nationality: 'western', query: 'english' },
  { slug: 'japanese', name: 'Japanese', nationality: 'japanese', query: 'japanese' },
  { slug: 'korean', name: 'Korean', nationality: 'korean', query: 'korean' },
  { slug: 'chinese', name: 'Chinese', nationality: 'chinese', query: 'chinese' },
];

export const SEO_GUIDES = [
  {
    slug: 'pokemon-card-condition-guide',
    title: 'Pokémon card condition guide',
    documentTitle: 'Pokémon Card Condition Guide | Pokoin',
    lede: 'How Pokoin listings use NM, LP, MP, HP, and damaged — the same condition axis as the card desk filters.',
  },
  {
    slug: 'pokemon-card-rarity-guide',
    title: 'Pokémon card rarity guide',
    documentTitle: 'Pokémon Card Rarity Guide | Pokoin',
    lede: 'Catalog rarities from Common through Special Illustration Rare, Full-Art, and promo printings.',
  },
  {
    slug: 'how-to-value-pokemon-cards',
    title: 'How to value Pokémon cards',
    documentTitle: 'How to Value Pokémon Cards | Pokoin',
    lede: 'Use the listed cheapest PKN and the sold-price graph on each card desk. Do not treat inferred sales as a PSA pop report.',
  },
];

export function raritySlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function rarityFromSlug(slug) {
  const key = raritySlug(slug);
  return RARITY_HUBS.find((row) => row.slug === key) || null;
}

export function rarityHref(nameOrSlug, lang = 'en') {
  const row = rarityFromSlug(typeof nameOrSlug === 'string' ? nameOrSlug : '');
  const language = String(lang || 'en').toLowerCase() || 'en';
  return row ? `/marketplace/${language}/rarities/${row.slug}` : `/marketplace/${language}/rarities`;
}

export function languageHref(slug, lang = 'en') {
  const row = LANGUAGE_HUBS.find((item) => item.slug === String(slug || '').toLowerCase());
  const language = String(lang || 'en').toLowerCase() || 'en';
  return row
    ? `/marketplace/${language}/languages/${row.slug}`
    : `/marketplace/${language}/languages`;
}

export function languageHrefFromNationality(nationality, lang = 'en') {
  const value = String(nationality || '').trim().toLowerCase();
  if (value === 'japanese') return languageHref('japanese', lang);
  if (value === 'korean') return languageHref('korean', lang);
  if (value === 'chinese') return languageHref('chinese', lang);
  return languageHref('english', lang);
}

export function guideHref(slug) {
  const row = SEO_GUIDES.find((item) => item.slug === slug);
  return row ? `/marketplace/en/guides/${row.slug}` : '/marketplace/en/guides';
}

export function cardSeoTitle(card = {}) {
  return cardDocumentTitle(card);
}

export function cardSeoDescription(card = {}) {
  const identity = printingIdentity(card);
  const species = speciesFromCard(card);
  const bits = [
    displayName(card),
    identity.number,
    identity.set,
    identity.rarity,
    species ? `${species.name} Pokémon TCG` : '',
  ].filter(Boolean);
  return `${bits.join(' · ')}. Compare printings, languages, and listings on Pokoin.`;
}

export function cardImageAlt(card = {}) {
  const identity = printingIdentity(card);
  return [displayName(card), identity.set, identity.number, 'Pokemon card']
    .filter(Boolean)
    .join(' ');
}

export function setSeoTitle(name) {
  const set = String(name || '').trim();
  return set ? `${set} Card List, Prices & Values | Pokoin` : 'Pokémon TCG Set List | Pokoin';
}

export function pokemonSeoTitle(name) {
  const species = String(name || '').trim();
  return species
    ? `${species} Pokémon Cards: Full List & Prices | Pokoin`
    : 'Pokémon Cards by Species | Pokoin';
}

export function artistSeoTitle(name) {
  const artist = String(name || '').trim();
  return artist ? `${artist} Pokémon Cards & Values | Pokoin` : 'Pokémon Card Artists | Pokoin';
}

export function scoreRelated(cardA, cardB) {
  if (!cardA || !cardB) {
    return 0;
  }
  if (String(cardA.id) === String(cardB.id)) {
    return 0;
  }
  let score = 0;
  const aDex = pokedexNumber(cardA);
  const bDex = pokedexNumber(cardB);
  if (aDex && aDex === bDex) {
    score += 8;
  }
  const a = printingIdentity(cardA);
  const b = printingIdentity(cardB);
  if (a.set && a.set === b.set) {
    score += 5;
  }
  if (a.artist && a.artist === b.artist) {
    score += 3;
  }
  if (a.rarity && a.rarity === b.rarity) {
    score += 2;
  }
  if (displayName(cardA) && displayName(cardA) === displayName(cardB)) {
    score += 4;
  }
  return score;
}

export function pickRelatedCards(card, pools = [], limit = 12) {
  const seen = new Set([String(card?.id || '')]);
  const ranked = [];
  for (const pool of pools) {
    for (const row of pool || []) {
      const id = String(row?.id || row?.card_id || '');
      if (!id || seen.has(id)) {
        continue;
      }
      const score = scoreRelated(card, row);
      if (score <= 0) {
        continue;
      }
      seen.add(id);
      ranked.push({ card: row, score });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit).map((row) => row.card);
}

export function productJsonLd(card = {}, { url, offers } = {}) {
  const identity = printingIdentity(card);
  const listed = (offers || []).filter((row) => Number(row.pricePkn) > 0);
  const prices = listed.map((row) => Number(row.pricePkn));
  const offer = listed.length
    ? {
      '@type': 'AggregateOffer',
      priceCurrency: 'PKN',
      lowPrice: Math.min(...prices),
      highPrice: Math.max(...prices),
      offerCount: listed.length,
      availability: 'https://schema.org/InStock',
    }
    : {
      '@type': 'Offer',
      priceCurrency: 'PKN',
      availability: 'https://schema.org/OutOfStock',
    };
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: displayName(card),
    description: cardSeoDescription(card),
    sku: String(card.id || ''),
    image: card.heroImageUrl || card.imageUrl || '',
    brand: { '@type': 'Brand', name: 'Pokémon TCG' },
    url: url || '',
    additionalProperty: [
      identity.set ? { '@type': 'PropertyValue', name: 'set', value: identity.set } : null,
      identity.number ? { '@type': 'PropertyValue', name: 'number', value: identity.number } : null,
      identity.rarity ? { '@type': 'PropertyValue', name: 'rarity', value: identity.rarity } : null,
      identity.artist ? { '@type': 'PropertyValue', name: 'artist', value: identity.artist } : null,
    ].filter(Boolean),
    offers: offer,
  };
}

export function breadcrumbJsonLd(crumbs = []) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: crumb.href ? `https://pokoin.com${crumb.href}` : undefined,
    })),
  };
}

export { speciesFromSlug };
