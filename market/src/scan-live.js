// Live card scanner rules for pokoin.com/scan. Ported from the phone scanner
// at scan.pokoin.com (pokoin-scanner service/web/index.html) so both send the
// same identify requests and accept matches at the same scores. Recognition
// itself stays on the Pi API (docs/SCAN_API.md); this module only decides what
// to send and how to read the answer.

import { GAMES, knownGameId } from './game.js';
import { inventoryListingHref } from './inventory-listings.js';
import { publicIdFromPokoinUrl } from './scan-id.js';

export const SCAN_API_BASE = 'https://api.pokoin.com/api/scan';

/** Live frame cadence (ms) between identify calls, as on scan.pokoin.com. */
export const LIVE_MS = 280;
/** A single top hit at or above this score is the card. */
export const ACCEPT = 0.72;
/** Below ACCEPT but at or above this, offer the hit as a possible match. */
export const POSSIBLE = 0.6;
/** Pokémon card face is 63×88 mm. */
export const POKEMON_CARD_ASPECT = 63 / 88;

// Games with a dedicated language picker keep the phone scanner's order; the
// rest of the /catalogs list follows by catalog size.
const GAME_ORDER = ['pokemon', 'one_piece', 'riftbound'];

const LANGUAGE_LABELS = {
  western: 'Western',
  english: 'English',
  japanese: 'Japanese',
  chinese: 'Chinese',
  generic: 'All languages',
  singles: 'All singles',
  all: 'All cards',
};

const LANGUAGE_CODES = {
  western: 'EN',
  english: 'EN',
  japanese: 'JP',
  chinese: 'CN',
  generic: 'ALL',
  singles: 'ALL',
  all: 'ALL',
};

const LANGUAGE_ORDER = ['western', 'english', 'japanese', 'chinese', 'generic', 'singles', 'all'];

export function scanCatalogsUrl(base = SCAN_API_BASE) {
  return `${String(base).replace(/\/$/, '')}/catalogs`;
}

/**
 * POST target for one frame or photo. Live frames ask for 3 hits (8 in multi
 * mode); a still photo asks for 5, the same as the phone scanner.
 */
export function scanIdentifyUrl({ catalog, multi = false, live = false } = {}, base = SCAN_API_BASE) {
  const params = new URLSearchParams({ catalog: String(catalog || ''), multi: multi ? '1' : '0' });
  if (live) {
    params.set('live', '1');
    params.set('top_k', multi ? '8' : '3');
  } else {
    params.set('top_k', '5');
  }
  return `${String(base).replace(/\/$/, '')}/identify?${params}`;
}

/** GET /catalogs rows → games, each with its language catalogs. Unknown games are dropped. */
export function catalogGroups(catalogs) {
  const byGame = new Map();
  for (const row of Array.isArray(catalogs) ? catalogs : []) {
    const id = String(row?.id || '');
    const game = knownGameId(row?.game);
    if (!id || !game || !GAMES[game]) continue;
    const language = String(row.language || '');
    if (!byGame.has(game)) {
      byGame.set(game, { game, name: GAMES[game].name, count: 0, catalogs: [] });
    }
    const group = byGame.get(game);
    group.count += Number(row.count) || 0;
    group.catalogs.push({
      id,
      language,
      label: LANGUAGE_LABELS[language] || language,
      code: game === 'riftbound' && language === 'western' ? 'ALL' : (LANGUAGE_CODES[language] || language.slice(0, 3).toUpperCase()),
      count: Number(row.count) || 0,
    });
  }
  const rank = (lang) => {
    const i = LANGUAGE_ORDER.indexOf(lang);
    return i < 0 ? LANGUAGE_ORDER.length : i;
  };
  for (const group of byGame.values()) {
    group.catalogs.sort((a, b) => rank(a.language) - rank(b.language));
  }
  return [...byGame.values()].sort((a, b) => {
    const ai = GAME_ORDER.indexOf(a.game);
    const bi = GAME_ORDER.indexOf(b.game);
    if (ai >= 0 || bi >= 0) return (ai < 0 ? GAME_ORDER.length : ai) - (bi < 0 ? GAME_ORDER.length : bi);
    return b.count - a.count;
  });
}

export function gameOfCatalog(catalogId, groups) {
  for (const group of groups || []) {
    if (group.catalogs.some((row) => row.id === catalogId)) return group.game;
  }
  return '';
}

/**
 * The site's scan catalog (@market/scan-id.js) as the scanner's starting
 * catalog. scan.pokoin.com opens Pokémon on Western and One Piece on English;
 * the all-languages catalogs stay one tap away. Japanese, Chinese and the
 * other games keep the site's choice.
 */
export function initialScanCatalog(siteCatalog) {
  const id = String(siteCatalog || '');
  if (id === 'pokemon_generic') return 'pokemon_western';
  if (id === 'one_piece_singles') return 'one_piece_english';
  return id;
}

/**
 * First catalog that exists, from: the `?catalog=` the page was opened with,
 * the site's own preference (print language / game path), the game's first
 * catalog, then the first catalog overall.
 */
export function pickCatalog(groups, { requested = '', preferred = '', gameId = '' } = {}) {
  const ids = new Set((groups || []).flatMap((group) => group.catalogs.map((row) => row.id)));
  if (requested && ids.has(requested)) return requested;
  if (preferred && ids.has(preferred)) return preferred;
  const group = (groups || []).find((row) => row.game === gameId) || (groups || [])[0];
  return group?.catalogs[0]?.id || '';
}

/**
 * In-app card path for a hit, or '' when the hit must not open: the id is not
 * a public id, the hit names another game than the catalog that was scanned,
 * or its pokoin_url points at a different card.
 */
export function scanHitHref(hit, gameId) {
  if (!hit || typeof hit !== 'object') return '';
  const id = String(hit.public_id || '').trim();
  if (!/^\d+$/.test(id)) return '';
  const game = knownGameId(gameId);
  if (!game) return '';
  if (hit.game && knownGameId(hit.game) !== game) return '';
  if (hit.pokoin_url) {
    const fromUrl = publicIdFromPokoinUrl(hit.pokoin_url);
    if (fromUrl && fromUrl !== id) return '';
  }
  return inventoryListingHref({ cardId: id, marketplaceGame: game }, game);
}

function score(hit) {
  return Number(hit?.score) || 0;
}

function hitRow(hit, gameId) {
  return {
    id: String(hit.public_id || ''),
    name: String(hit.name || 'Card'),
    set: String(hit.set || ''),
    number: String(hit.collector_number || '').replace(/^[^|]*\|\s*/, ''),
    image: /^https:\/\//.test(String(hit.image_url || '')) ? String(hit.image_url) : '',
    score: score(hit),
    language: String(hit.printing?.language || ''),
    href: scanHitHref(hit, gameId),
  };
}

/**
 * Identify JSON → what the page shows. Mirrors identify() on scan.pokoin.com:
 *
 * - `accepted`: Single mode top hit ≥ ACCEPT. The phone scanner opens the card.
 * - `possible`: a live frame whose top hit is ≥ POSSIBLE, or a photo's top 3.
 * - `multi`: every detected card whose top hit is ≥ ACCEPT.
 * - `detected` / `searching` / `none`: nothing to show yet.
 */
export function readScanResult(data, { mode = 'single', live = false, gameId = '' } = {}) {
  if (!data || typeof data !== 'object') return { state: 'none', hits: [] };
  if (data.busy) return { state: 'busy', hits: [] };
  const boxes = Array.isArray(data.boxes) ? data.boxes.length : 0;
  if (mode === 'multi') {
    const hits = (Array.isArray(data.cards) ? data.cards : [])
      .map((card) => card?.top1)
      .filter((hit) => hit && score(hit) >= ACCEPT)
      .map((hit) => hitRow(hit, gameId));
    if (hits.length) return { state: 'multi', hits };
    return { state: live ? (boxes ? 'detected' : 'searching') : 'none', hits: [] };
  }
  const top = data.top1 || (Array.isArray(data.hits) ? data.hits[0] : null);
  if (top && score(top) >= ACCEPT && scanHitHref(top, gameId)) {
    return { state: 'accepted', hits: [hitRow(top, gameId)] };
  }
  if (live) {
    if (top && score(top) >= POSSIBLE) return { state: 'possible', hits: [hitRow(top, gameId)] };
    return { state: boxes ? 'detected' : 'searching', hits: [] };
  }
  const hits = (Array.isArray(data.hits) ? data.hits : [])
    .slice(0, 3)
    .filter((hit) => score(hit) >= POSSIBLE)
    .map((hit) => hitRow(hit, gameId));
  return { state: hits.length ? 'possible' : 'none', hits };
}

/** Status line under the camera for a result state. */
export function scanStatusText(state) {
  switch (state) {
    case 'accepted': return 'Match found.';
    case 'possible': return 'Possible match. Check it below.';
    case 'multi': return 'Cards found. Keep scanning to add more.';
    case 'detected': return 'Card found. Hold it steady with its edges visible.';
    case 'searching': return 'Point at a card. Keep all four corners visible.';
    case 'busy': return 'The scanner is busy. Retrying…';
    default: return 'No confident match. Try a clearer photo or another catalog.';
  }
}

/** Grow a detector box to the 63:88 card around its centre. */
export function fitCardRect(rect, aspect = POKEMON_CARD_ASPECT) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const wFromH = rect.h * aspect;
  const w = wFromH >= rect.w ? wFromH : rect.w;
  const h = wFromH >= rect.w ? rect.h : rect.w / aspect;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Detector xyxy in image pixels → rect in an object-fit: contain view. */
export function mapContain(xyxy, imgW, imgH, viewW, viewH) {
  const scale = Math.min(viewW / imgW, viewH / imgH);
  const dx = (viewW - imgW * scale) / 2;
  const dy = (viewH - imgH * scale) / 2;
  return {
    x: xyxy[0] * scale + dx,
    y: xyxy[1] * scale + dy,
    w: (xyxy[2] - xyxy[0]) * scale,
    h: (xyxy[3] - xyxy[1]) * scale,
  };
}

/** Device tilt (beta, gamma) and screen angle → card roll in degrees, or null when held flat. */
export function uprightRoll(beta, gamma, screenAngleDeg) {
  if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return null;
  const b = (beta * Math.PI) / 180;
  const g = (gamma * Math.PI) / 180;
  const ux = -Math.cos(b) * Math.sin(g);
  const uy = Math.sin(b);
  const strength = Math.hypot(ux, uy);
  if (strength < 0.5) return null;
  const a = ((Number.isFinite(screenAngleDeg) ? screenAngleDeg : 0) * Math.PI) / 180;
  const sx = ux * Math.cos(a) - uy * Math.sin(a);
  const sy = ux * Math.sin(a) + uy * Math.cos(a);
  return { roll: (Math.atan2(sx, sy) * 180) / Math.PI, strength };
}

/**
 * The rear main camera: back/rear/environment labels win, wide lenses next;
 * ultra-wide, tele, front and fused virtual cameras lose. Labels cover the
 * languages iOS and Android ship them in.
 */
export function preferredCamera(devices, currentId = '') {
  const cameras = (devices || []).filter((device) => device.kind === 'videoinput');
  const ranked = cameras.map((device) => {
    const label = String(device.label || '').toLowerCase();
    const rear = /back|rear|environment|bagkamera|bagside|ruck|rück|arriere|arrière|posteriore|trasera/.test(label);
    const wide = /wide|vidvinkel|weitwinkel|grand.angle|grandangol/.test(label);
    const avoid = /ultra|\btele(?:photo|foto|obiettivo)?\b|front|user|facetime|selfie/.test(label);
    const combined = /dual|triple|fusion|virtual/.test(label);
    return { device, score: (rear ? 200 : 0) + (wide ? 50 : 0) - (avoid ? 1000 : 0) - (combined ? 400 : 0) };
  }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score);
  return ranked[0]?.device || cameras.find((device) => device.deviceId === currentId) || cameras[0] || null;
}
