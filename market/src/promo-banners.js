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
    });
    if (slides.length >= cap) {
      break;
    }
  }
  return slides;
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
