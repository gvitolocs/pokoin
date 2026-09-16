/** Parse pkmncards.com illustrator pages and match leftover printings. */

export const PKMNCARDS_ORIGIN = 'https://pkmncards.com';

const CARD_ANCHOR = /<a([^>]*href="https:\/\/pkmncards\.com\/card\/[^"]+"[^>]*)>/gi;
const HREF = /href="(https:\/\/pkmncards\.com\/card\/[^"]+)"/;
const TITLE_ATTR = /\btitle="([^"]+)"/;
const TITLE = /^(.+?)\s+·\s+(.+?)\s+\(([A-Za-z0-9]+)\)\s+#(\d+[A-Za-z]?)\s*$/;

export function foldMatchKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/♀/g, 'female')
    .replace(/♂/g, 'male')
    .replace(/\bfemale\b/g, '')
    .replace(/\bmale\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

export function collectorNumber(num) {
  const text = String(num || '');
  const slash = text.match(/(\d{1,4})[a-z]?\s*\/\s*\d{1,4}/i);
  if (slash) return String(Number(slash[1]));
  const promo = text.match(/\b([A-Z]{2,6}\s*\d{1,4}[a-z]?)\b/i);
  if (promo) return promo[1].replace(/\s+/g, '').toUpperCase();
  const plain = text.match(/^(\d{1,4})[a-z]?$/i);
  return plain ? String(Number(plain[1])) : '';
}

export function artistPageUrl(slug) {
  const clean = String(slug || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean ? `${PKMNCARDS_ORIGIN}/artist/${clean}/` : '';
}

export function parseArtistPage(html, { artist = '', pageUrl = '' } = {}) {
  const cards = [];
  const seen = new Set();
  CARD_ANCHOR.lastIndex = 0;
  let match;
  while ((match = CARD_ANCHOR.exec(html))) {
    const attrs = match[1];
    const href = HREF.exec(attrs)?.[1] || '';
    const title = (TITLE_ATTR.exec(attrs)?.[1] || '').replace(/\s+/g, ' ').trim();
    const parsed = TITLE.exec(title);
    if (!href || !parsed) continue;
    const card = {
      name: parsed[1].trim(),
      set: parsed[2].trim(),
      setCode: parsed[3].trim(),
      number: parsed[4].trim(),
      url: href,
      artist,
      pageUrl,
    };
    if (seen.has(href)) continue;
    seen.add(href);
    cards.push(card);
  }
  return cards;
}

export function printingKey(name, set, num) {
  const foldedName = foldMatchKey(name);
  const foldedSet = foldMatchKey(String(set || '').replace(/\s+jp$/i, ''));
  const number = collectorNumber(num);
  return foldedName && foldedSet && number ? `${foldedName}|${foldedSet}|${number}` : '';
}

export function matchPkmncardsPrinting(card, rows) {
  const key = printingKey(card.name, card.set, card.number);
  if (!key) return [];
  return rows.filter((row) => printingKey(row.name, row.set_name || row.set, row.card_number) === key);
}

export const PROTECTED_ARTIST_SOURCES = new Set([
  'ocr_illus',
  'pokemontcg.io',
  'pokemon_tcg_data',
  'tcgdex',
  'pkmncards',
]);

export function shouldWriteArtist(existingSource, existingArtist, nextArtist) {
  const have = String(existingArtist || '').trim();
  const next = String(nextArtist || '').trim();
  if (!next) return false;
  if (!have) return true;
  const source = String(existingSource || '').trim();
  if (source === 'same_artwork' && foldMatchKey(have) !== foldMatchKey(next)) {
    return true;
  }
  return false;
}
