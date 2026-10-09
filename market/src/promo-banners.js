/** How many set slides a non-Pokémon homepage hero rotates through. */
export const SATELLITE_PROMO_LIMIT = 5;

/**
 * Homepage super-tile slides for a satellite TCG.
 * Rows are the expansions API order (largest catalog first).
 */
export function satellitePromoBanners(rows, gameName, limit = SATELLITE_PROMO_LIMIT) {
  const series = String(gameName || '').trim();
  const cap = Math.max(1, Number(limit) || SATELLITE_PROMO_LIMIT);
  const seen = new Set();
  const slides = [];
  for (const row of rows || []) {
    const slug = String(row?.slug || '').trim();
    const title = String(row?.name || row?.expansionName || '').trim();
    if (!slug || !title || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const count = Number(row?.cardCount || row?.catalog_card_count) || 0;
    slides.push({
      slug,
      series,
      title,
      lede: count > 0
        ? `${count} cards in the catalog.`
        : 'Browse every printing in this expansion.',
      cta: 'Explore cards from this expansion',
      logoImageUrl: String(row?.logoImageUrl || row?.logo_image_url || '').trim(),
      nationality: String(row?.nationality || '').trim().toLowerCase(),
    });
    if (slides.length >= cap) {
      break;
    }
  }
  return slides;
}

/**
 * A western wordmark already writes the expansion name, so the hero
 * does not repeat it as a text title.
 */
export function promoLogoIsName(banner) {
  if (banner?.western === true) {
    return true;
  }
  return String(banner?.nationality || '').trim().toLowerCase() === 'western';
}

/** Official set wordmark for the hero. Pokémon curated slides use the CDN path. */
export function promoLogoSrc(banner, { pokemon = false } = {}) {
  const fromApi = String(banner?.logoImageUrl || '').trim();
  if (fromApi) {
    return fromApi;
  }
  const slug = String(banner?.slug || '').trim();
  if (pokemon && slug) {
    return `/card-images/expansions/logos/${slug}.png`;
  }
  return '';
}

/** Current expansions on the home promo carousel (five slides). */
export const PROMO_BANNERS = [
  {
    slug: 'storm-emeralda',
    series: 'Mega Evolution',
    title: 'Storm Emeralda',
    lede: 'Japanese M6 is on the floor. Chase Mega Rayquaza ex.',
    cta: 'Explore cards from this expansion',
  },
  {
    slug: 'mega-evolution',
    series: 'Mega Evolution',
    title: 'Mega Evolution',
    lede: 'The first Mega Evolution set is on the floor. Chase Mega Lucario ex.',
    cta: 'Explore cards from this expansion',
    western: true,
  },
  {
    slug: 'phantasmal-flames',
    series: 'Mega Evolution',
    title: 'Phantasmal Flames',
    lede: 'The second Mega Evolution set is on the floor. Chase Mega Charizard X ex.',
    cta: 'Explore cards from this expansion',
    western: true,
  },
  {
    slug: 'black-bolt',
    series: 'Black & White',
    title: 'Black Bolt',
    lede: 'Unova returns in black. Zekrom ex and the chase holos.',
    cta: 'Explore cards from this expansion',
    western: true,
  },
  {
    slug: 'white-flare',
    series: 'Black & White',
    title: 'White Flare',
    lede: 'Unova in white. Reshiram ex and the set’s secret rares.',
    cta: 'Explore cards from this expansion',
    western: true,
  },
];
