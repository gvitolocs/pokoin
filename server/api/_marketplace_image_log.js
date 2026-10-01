const RING_LIMIT = 250;

const ring = [];

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function imagePrefix(url) {
  const match = String(url || '').match(/\/(?:previews\/)?(\d+)_/);
  return match ? match[1] : '';
}

function prefixKind(cardId, ctId, url) {
  const prefix = imagePrefix(url);
  if (!prefix) return 'none';
  const card = String(cardId || '').trim();
  const ct = String(ctId || '').trim();
  if (ct && prefix === ct) return 'ct_id';
  if (card && prefix === card) return 'public_id';
  if (card && Number(card) % 2 === 0 && prefix === String(Number(card) / 2)) {
    return 'ct_id';
  }
  return 'other';
}

function recordMarketplaceImage(input = {}) {
  const entry = {
    at: new Date().toISOString(),
    source: cleanText(input.source, 80) || 'unknown',
    status: cleanText(input.status, 40) || 'served',
    route: cleanText(input.route, 240),
    cardId: cleanText(input.cardId, 32),
    ctId: cleanText(input.ctId, 32),
    name: cleanText(input.name, 80),
    url: cleanText(input.url, 300),
    fallbackUrl: cleanText(input.fallbackUrl, 300),
    prefix: imagePrefix(input.url),
    prefixKind: prefixKind(input.cardId, input.ctId, input.url),
    error: cleanText(input.error, 200),
    sessionId: cleanText(input.sessionId, 80),
  };
  ring.push(entry);
  if (ring.length > RING_LIMIT) {
    ring.shift();
  }
  console.info('marketplace-image', JSON.stringify(entry));
  return entry;
}

function recordHomeImages(snapshot = {}, route = '/marketplace') {
  const cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
  const sections = snapshot.sections || {};
  const wanted = [
    ...(sections.recentlySeenIds || []).slice(0, 6),
    ...(sections.bestSellerIds || []).slice(0, 6),
    ...(sections.featuredIds || []).slice(0, 6),
  ].map((id) => String(id));
  const byId = new Map(cards.map((card) => [String(card.id || ''), card]));
  const seen = new Set();
  for (const id of wanted) {
    if (seen.has(id)) continue;
    seen.add(id);
    const card = byId.get(id) || {};
    recordMarketplaceImage({
      source: 'marketplace-home',
      status: 'served',
      route,
      cardId: card.id || id,
      ctId: card.ct_id || card.ctId,
      name: card.name,
      url: card.homepageImageUrl || card.previewImageUrl || card.imageUrl,
      fallbackUrl: card.imageUrl,
    });
  }
}

function recordVersionImages(rows = [], query = {}) {
  const list = Array.isArray(rows) ? rows.slice(0, 3) : [];
  for (const row of list) {
    recordMarketplaceImage({
      source: 'marketplace-card-versions',
      status: 'served',
      route: cleanText(query.route || query.canonicalPath, 240),
      cardId: row.card_id || row.cardId || query.cardId,
      ctId: row.ct_id || row.ctId || row.blueprint_id,
      name: row.name,
      url: row.image_url || row.imageUrl || row.cdn_image_url,
      fallbackUrl: row.preview_image_url || row.previewImageUrl,
    });
  }
}

function recordCardsImages(rows = [], query = {}) {
  const list = Array.isArray(rows) ? rows.slice(0, 8) : [];
  const route = cleanText(query.route || query.query || '', 240);
  for (const row of list) {
    recordMarketplaceImage({
      source: 'marketplace-cards',
      status: 'served',
      route,
      cardId: row.id || row.card_id || row.cardId,
      ctId: row.ct_id || row.ctId,
      name: row.name,
      url:
        row.homepageImageUrl ||
        row.previewImageUrl ||
        row.imageUrl ||
        row.preview_image_url ||
        row.cdn_image_url ||
        row.image_url,
      fallbackUrl: row.imageUrl || row.image_url,
    });
  }
}

function listMarketplaceImages(limit = 80) {
  const size = Math.min(Math.max(Number(limit) || 80, 1), RING_LIMIT);
  return ring.slice(-size).reverse();
}

module.exports = {
  imagePrefix,
  listMarketplaceImages,
  prefixKind,
  recordCardsImages,
  recordHomeImages,
  recordMarketplaceImage,
  recordVersionImages,
};
