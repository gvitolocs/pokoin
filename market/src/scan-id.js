import { gameIdFromHost } from './game.js';
import { getPrintLang } from './locale.js';

/** Live leftover-JPEG catalogs (`GET /catalogs`). Do not use default identify catalog tcgplayer on the desk. Map: docs/SCAN.md */
export function scanCatalogId(hostname, printLang = getPrintLang()) {
  const game = gameIdFromHost(hostname);
  const print = String(printLang || 'all').toLowerCase();
  if (game === 'one_piece') {
    return print === 'japanese' ? 'one_piece_japanese' : 'one_piece_singles';
  }
  if (game === 'riftbound') {
    return 'riftbound_western';
  }
  if (print === 'japanese') {
    return 'pokemon_japanese';
  }
  if (print === 'chinese') {
    return 'pokemon_chinese';
  }
  return 'pokemon_generic';
}

export function publicIdFromPokoinUrl(url) {
  const text = String(url || '');
  const canonical = text.match(/pokoin\.com\/marketplace\/[a-z0-9-]+\/cards\/(\d+)/i);
  if (canonical) {
    return canonical[1];
  }
  const short = text.match(/pokoin\.com\/(\d+)(?:\/|$|\?)/i);
  return short ? short[1] : '';
}

function leftoverPublicId(value) {
  const leftover = String(value || '').trim();
  if (!/^\d+$/.test(leftover)) {
    return '';
  }
  try {
    return (BigInt(leftover) * 2n).toString();
  } catch (_) {
    return '';
  }
}

/** Desk id from a cardscan 2.1 hit. Prefer `public_id` / `pokoin_url`.
 * `ct_id` doubles. TCGPlayer `id` does not. `identity: public_id` uses `id` as-is. */
export function publicIdFromScanHit(hit) {
  if (!hit || typeof hit !== 'object') {
    return '';
  }
  const publicId = String(hit.public_id || hit.publicId || '').trim();
  if (/^\d+$/.test(publicId)) {
    return publicId;
  }
  const fromUrl = publicIdFromPokoinUrl(hit.pokoin_url || hit.pokoinUrl || '');
  if (fromUrl) {
    return fromUrl;
  }
  const fromLeftover = leftoverPublicId(
    hit.ct_id || hit.ctId || hit.blueprint_id || hit.blueprintId,
  );
  if (fromLeftover) {
    return fromLeftover;
  }
  const identity = String(hit.identity || '').toLowerCase();
  const raw = String(hit.id || '').trim();
  if (!/^\d+$/.test(raw)) {
    return '';
  }
  if (identity === 'public_id') {
    return raw;
  }
  if (identity === 'tcgplayer') {
    return '';
  }
  return leftoverPublicId(raw);
}
