function hasCollectorNumber(value) {
  const text = String(value || '').trim().toLowerCase();
  return /(^|[^0-9])[0-9]{1,4}[a-z]?\/[0-9]{1,4}([^0-9]|$)/.test(text);
}

function ctIdFromRow(row = {}) {
  const ct = Number(row.ct_id ?? row.ctId);
  if (Number.isSafeInteger(ct) && ct > 0) {
    return String(ct);
  }
  const id = Number(row.card_id ?? row.id);
  if (Number.isSafeInteger(id) && id > 0 && id % 2 === 0) {
    return String(id / 2);
  }
  return '';
}

function rewriteCdnKeyPrefix(url, fromId, toId) {
  const source = String(url || '');
  const from = String(fromId || '').trim();
  const to = String(toId || '').trim();
  if (!source || !from || !to || from === to) {
    return source;
  }
  if (!/^\d+$/.test(from) || !/^\d+$/.test(to)) {
    return source;
  }
  return source.replace(new RegExp(`(^|/)(previews/)?${from}_`, 'g'), `$1$2${to}_`);
}

function rewriteCdnPokoinPrefix(url, row = {}) {
  const source = String(url || '');
  // Prefixed multi-game keys stay raw CardTrader ids
  // (magic/<ct_id>_…, one-piece/<ct_id>_…). Pokemon leftover keys are
  // rewritten to public card_id.
  if (/(?:^|\/)(?:one-piece|riftbound|magic|yugioh|lorcana|flesh-and-blood|digimon|dragon-ball-super|vanguard|star-wars|union-arena|gundam|sorcery|palworld|cyberpunk)\//i.test(source)) {
    return source;
  }
  const pokoin = String(row.card_id ?? row.id ?? '').trim();
  const ct = ctIdFromRow({ ...row, card_id: pokoin || row.card_id });
  return rewriteCdnKeyPrefix(source, ct, pokoin);
}

const IMAGE_KEYS = [
  'image_url',
  'cdn_image_url',
  'preview_image_url',
  'homepage_image_url',
  'imageUrl',
  'previewImageUrl',
  'homepageImageUrl',
];

function isFragilePreviewWebp(url) {
  return /\/previews\/[^?\s]+\.webp(?:\?|$)/i.test(String(url || ''));
}

function isRasterCardImage(url) {
  return /\.(?:jpe?g|png)(?:\?|$)/i.test(String(url || ''));
}

function preferDecodableTileImage(row = {}) {
  const image = row.image_url || row.cdn_image_url || row.imageUrl || '';
  const preview = row.preview_image_url || row.previewImageUrl || '';
  if (isFragilePreviewWebp(preview) && isRasterCardImage(image)) {
    row.preview_image_url = image;
    if (row.previewImageUrl != null) {
      row.previewImageUrl = image;
    }
  }
  return row;
}


function isMarketAvailable(row = {}) {
  const stock = Number(row.stock || row.listed_quantity || row.cardtraderListedQuantity || row.cardtrader_listed_quantity || 0);
  const listingCount = Number(
    row.cardtraderEligibleListingCount ||
    row.cardtrader_eligible_listing_count ||
    0,
  );
  const hasTrader = row.hasCardTraderListing === true ||
    row.has_cardtrader_listing === true ||
    row.cardtrader_available === true ||
    listingCount > 0;
  return (Number.isFinite(stock) && stock > 0) || hasTrader;
}

function normalizeMarketplaceRow(row) {
  const normalized = { ...row };
  const collectorNumber =
    normalized.card_number || normalized.expansion_number || normalized.version;
  if (hasCollectorNumber(collectorNumber)) {
    normalized.item_kind = 'single';
    normalized.product_type = 'card';
  }
  const ct = ctIdFromRow(normalized);
  if (ct && (normalized.ct_id == null || normalized.ct_id === '')) {
    normalized.ct_id = Number(ct);
  }
  for (const key of IMAGE_KEYS) {
    if (normalized[key]) {
      normalized[key] = rewriteCdnPokoinPrefix(normalized[key], normalized);
    }
  }
  const available = isMarketAvailable(normalized);
  normalized.isMarketAvailable = available;
  normalized.inStock = available;
  return preferDecodableTileImage(normalized);
}

function normalizeMarketplaceRows(rows) {
  return rows.map((row) => normalizeMarketplaceRow(row));
}

module.exports = {
  hasCollectorNumber,
  ctIdFromRow,
  rewriteCdnKeyPrefix,
  rewriteCdnPokoinPrefix,
  isFragilePreviewWebp,
  preferDecodableTileImage,
  isMarketAvailable,
  normalizeMarketplaceRow,
  normalizeMarketplaceRows,
};
