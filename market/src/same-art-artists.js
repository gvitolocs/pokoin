/** Copy one illustrator onto CLIP siblings that have none. */

export function foldArtistName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function uniqueGroupArtist(members = []) {
  const names = new Map();
  for (const row of members) {
    const display = String(row?.artist || row?.illustrator || '').trim();
    const folded = foldArtistName(display);
    if (!folded) continue;
    if (!names.has(folded)) names.set(folded, display);
  }
  if (names.size !== 1) return '';
  return [...names.values()][0];
}

export function sameArtArtistFills(members = []) {
  const groups = new Map();
  for (const row of members) {
    const version = String(row?.version || '').trim();
    if (!version) continue;
    let bucket = groups.get(version);
    if (!bucket) {
      bucket = [];
      groups.set(version, bucket);
    }
    bucket.push(row);
  }
  const fills = [];
  for (const siblings of groups.values()) {
    const names = new Set(
      siblings.map((row) => foldArtistName(row?.name)).filter(Boolean),
    );
    if (names.size > 1) continue;
    const artist = uniqueGroupArtist(siblings);
    if (!artist) continue;
    for (const row of siblings) {
      if (String(row?.artist || row?.illustrator || '').trim()) continue;
      fills.push({
        ctId: Number(row.ctId || row.ct_id),
        cardId: Number(row.cardId || row.card_id || 0),
        version: String(row.version),
        artist,
      });
    }
  }
  return fills.filter((row) => Number.isFinite(row.ctId) && row.ctId > 0);
}

export function ocrArtistsQuery(name) {
  const needle = String(name || '').trim();
  return needle ? `/ocr/artists?q=${encodeURIComponent(needle)}` : '/ocr/artists';
}
