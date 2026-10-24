import { GAMES } from './game.js';

/**
 * CardTrader Zero picking list helpers. Lines arrive from GET /api/cardtrader-zero
 * already in picking order (one line per box, see the shared contract); nothing
 * here re-sorts them except the explicit "Sort by PT order" toggle.
 */

export const PICK_CACHE_KEY = 'pokoin.ctZero.picks.';
export const LEGACY_PICKED_KEY = 'pokoin.ctZero.picked.';
export const VIEW_KEY = 'pokoin.ctZero.view';

/** Power Tools' four picking views; images-vertical is the default. */
export const ZERO_VIEWS = [
  { id: 'list', label: 'List' },
  { id: 'images-vertical', label: 'Images vertical' },
  { id: 'images-horizontal', label: 'Images horizontal' },
  { id: 'single', label: 'Single image' },
];

/** A stored view, PR A's values migrated (`cards` → images-vertical). */
export function normalizeView(raw) {
  const value = String(raw || '');
  if (ZERO_VIEWS.some((view) => view.id === value)) return value;
  return 'images-vertical';
}

export const ISSUE_TYPES = [
  { id: 'missing', label: 'Missing' },
  { id: 'wrong_condition', label: 'Wrong condition' },
  { id: 'wrong_language', label: 'Wrong language' },
  { id: 'wrong_foil', label: 'Wrong foil' },
  { id: 'wrong_first_edition', label: 'Wrong 1st edition' },
  { id: 'other', label: 'Other' },
];
export const ISSUE_NOTE_MAX = 280;

export function issueLabel(issue) {
  if (!issue?.type) return '';
  return ISSUE_TYPES.find((entry) => entry.id === issue.type)?.label || 'Issue';
}

const GAME_LABELS = { magic: 'Magic', pokemon: 'Pokémon', yugioh: 'Yu-Gi-Oh!', riftbound: 'Riftbound' };

/** Display name of a marketplace game slug; "" is "Other". */
export function zeroGameLabel(slug) {
  const id = String(slug || '');
  if (!id) return 'Other';
  if (GAME_LABELS[id]) return GAME_LABELS[id];
  if (GAMES[id]?.name) return GAMES[id].name;
  return id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function lineKeyOf(line) {
  return String(line?.lineKey ?? line?.itemId ?? '');
}

export function lineQuantity(line) {
  const quantity = Number(line?.quantity);
  return Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1;
}

/**
 * A shipment's lines under game headers, in the order the games first arrive.
 * Each line keeps its running place (1..n in server order).
 */
export function groupLinesByGame(lines = []) {
  const groups = [];
  const byGame = new Map();
  lines.forEach((line, index) => {
    const game = String(line?.game || '');
    let group = byGame.get(game);
    if (!group) {
      group = { game, label: zeroGameLabel(game), lines: [], cards: 0 };
      byGame.set(game, group);
      groups.push(group);
    }
    group.lines.push({ line, place: index + 1 });
    group.cards += lineQuantity(line);
  });
  return groups;
}

const ptPosition = (line) => {
  const position = Number(line?.powerTools?.position);
  return position > 0 ? position : null;
};

/** Lines by Power Tools position; lines without one last; stable. */
export function sortByPtOrder(lines = []) {
  return lines
    .map((line, index) => ({ line, index, position: ptPosition(line) }))
    .sort((a, b) => {
      if (a.position == null || b.position == null) {
        if (a.position == null && b.position == null) return a.index - b.index;
        return a.position == null ? 1 : -1;
      }
      return a.position - b.position || a.index - b.index;
    })
    .map((entry) => entry.line);
}

function distinctIds(lines) {
  const seen = new Set();
  const ids = [];
  for (const line of lines) {
    const id = String(line?.itemId ?? '');
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Our picking order against Power Tools' position order for one Zero pack:
 * the distinct CardTrader item ids (first occurrence) in both orders.
 */
export function pickingOrdersMatch(lines = []) {
  if (!lines.length) return { comparable: false, equal: false, mismatches: 0 };
  if (lines.some((line) => ptPosition(line) == null)) return { comparable: false, equal: false, mismatches: 0 };
  const ours = distinctIds(lines);
  const theirs = distinctIds(
    lines
      .map((line, index) => ({ line, index }))
      .sort((a, b) => ptPosition(a.line) - ptPosition(b.line) || a.index - b.index)
      .map((entry) => entry.line),
  );
  const mismatches = ours.reduce((count, id, index) => count + (id === theirs[index] ? 0 : 1), 0);
  return { comparable: true, equal: mismatches === 0, mismatches };
}

/* ---------- picked state: server truth, localStorage offline cache ---------- */

function cleanIssue(issue) {
  if (!issue?.type) return null;
  return { type: String(issue.type), note: String(issue.note || '').slice(0, ISSUE_NOTE_MAX) };
}

function clampPicked(value, quantity) {
  const number = Math.floor(Number(value) || 0);
  return Math.max(0, Math.min(quantity, number));
}

export function sameIssue(a, b) {
  const left = cleanIssue(a);
  const right = cleanIssue(b);
  if (!left || !right) return !left && !right;
  return left.type === right.type && left.note === right.note;
}

/** `{ picked, issue }` shown for a line: the cached entry when there is one, else the server's. */
export function effectivePick(line, cache = {}) {
  const quantity = lineQuantity(line);
  const entry = cache[lineKeyOf(line)];
  const source = entry || line || {};
  return { picked: clampPicked(source.picked, quantity), issue: cleanIssue(source.issue) };
}

/** Done = every copy picked and no open issue. */
export function lineDone(line, cache = {}) {
  const pick = effectivePick(line, cache);
  return !pick.issue && pick.picked >= lineQuantity(line);
}

/**
 * Fresh server data arrived: server wins for every clean entry, dirty
 * (unsaved) entries stay so they can be retried. Entries for lines that are
 * no longer in the order are dropped.
 */
export function reconcilePickCache(cache = {}, lines = []) {
  const keys = new Set(lines.map(lineKeyOf));
  const next = {};
  for (const [key, entry] of Object.entries(cache || {})) {
    if (entry?.dirty && keys.has(key)) next[key] = entry;
  }
  return next;
}

/** Local change (optimistic): `change` is `{ picked }` and/or `{ issue }`. */
export function setPickEntry(cache = {}, line, change = {}) {
  const key = lineKeyOf(line);
  const current = effectivePick(line, cache);
  const entry = {
    picked: 'picked' in change ? clampPicked(change.picked, lineQuantity(line)) : current.picked,
    issue: 'issue' in change ? cleanIssue(change.issue) : current.issue,
    dirty: true,
  };
  return { ...cache, [key]: entry };
}

/** The server accepted `sent`; the entry is clean unless it changed again meanwhile. */
export function confirmPickEntry(cache = {}, lineKey, sent, saved) {
  const entry = cache[lineKey];
  if (!entry || entry.picked !== sent.picked || !sameIssue(entry.issue, sent.issue)) return cache;
  return {
    ...cache,
    [lineKey]: {
      picked: saved?.picked != null ? Number(saved.picked) : sent.picked,
      issue: saved && 'issue' in saved ? cleanIssue(saved.issue) : cleanIssue(sent.issue),
      dirty: false,
    },
  };
}

/** A save rejected by the server (4xx) is dropped; the server value shows again. */
export function dropPickEntry(cache = {}, lineKey) {
  if (!(lineKey in (cache || {}))) return cache;
  const next = { ...cache };
  delete next[lineKey];
  return next;
}

/** Network errors, 5xx, and auth / rate hiccups are retried; other 4xx are final. */
export function retryableSaveError(err) {
  const status = Number(err?.status);
  if (!status || err?.gatewayFailure) return true;
  return status >= 500 || status === 401 || status === 408 || status === 429;
}

/** POST body for one line; always carries `picked` or `issue` (the route 400s on neither). */
export function pickSaveBody(orderId, lineKey, entry, fields = []) {
  const body = { orderId: String(orderId), lineKey };
  const wanted = fields.filter((field) => field === 'picked' || field === 'issue');
  for (const field of wanted.length ? wanted : ['picked']) {
    body[field] = field === 'issue' ? cleanIssue(entry?.issue) : Math.max(0, Math.floor(Number(entry?.picked) || 0));
  }
  return body;
}

/**
 * Picks now move inventory, so they are never replayed from the offline
 * cache: dirty entries keep only an unsaved issue; a dirty entry whose
 * issue already matches the server (an old unsaved pick count) is dropped.
 */
export function dropUnsentPicks(cache = {}, lines = []) {
  const byKey = new Map(lines.map((line) => [lineKeyOf(line), line]));
  const next = {};
  for (const [key, entry] of Object.entries(cache || {})) {
    const line = byKey.get(key);
    if (!line) continue;
    if (!entry?.dirty) {
      next[key] = entry;
      continue;
    }
    if (sameIssue(entry.issue, line.issue)) continue;
    next[key] = { ...entry, picked: clampPicked(line.picked, lineQuantity(line)) };
  }
  return next;
}

/** POST body of a pick / undo: the copy picked (`listingId`) and the copy the sale took. */
export function pickActionBody(order, line, action = 'pick', listingId = '') {
  const allocated = String(line?.listingId || '');
  return {
    orderId: String(order?.orderId ?? line?.orderId ?? ''),
    itemId: String(line?.itemId ?? ''),
    lineKey: lineKeyOf(line),
    listingId: String(listingId || allocated),
    allocatedListingId: allocated,
    quantity: lineQuantity(line),
    action: action === 'undo' ? 'undo' : 'pick',
  };
}

/**
 * Identical copies of this line in other boxes, `[{ listingId, location,
 * quantityAvailable }]`: the server's `candidates` (smart locations off), or
 * `alsoIn` entries that carry a listing id. Never the line's own listing.
 */
export function lineCopies(line) {
  const own = String(line?.listingId || '');
  const source = Array.isArray(line?.candidates) && line.candidates.length ? line.candidates : line?.alsoIn || [];
  const seen = new Set();
  const out = [];
  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    const listingId = String(entry.listingId || '');
    if (!listingId || listingId === own || seen.has(listingId)) continue;
    seen.add(listingId);
    const available = Number(entry.quantityAvailable);
    out.push({
      listingId,
      location: String(entry.location || ''),
      quantityAvailable: Number.isFinite(available) ? available : null,
    });
  }
  return out;
}

/** `alsoIn` as display text (strings, or `{location}` objects). */
export function alsoInLabels(line) {
  return (line?.alsoIn || [])
    .map((entry) => (entry && typeof entry === 'object' ? entry.location : entry))
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

/** The pick result shown on the tile. */
export function inventoryNote(result, copies = []) {
  if (!result) return '';
  // A finalize pick changes no quantity (the sale already took the copy): it left the inventory.
  if (result.inventory === 'removed' || (result.inventory === 'unchanged' && result.action === 'pick')) return 'removed from inventory';
  if (result.inventory === 'swapped') {
    const box = copies.find((copy) => copy.listingId === result.listingId)?.location || result.location || 'another box';
    return `swapped with ${box}`;
  }
  if (result.inventory === 'restored') return 'back in inventory';
  return '';
}

/** "<location>: take N (M available)", the available part only when known. */
export function locationTakeText(line) {
  const location = lineLocation(line) || 'No location';
  const available = Number(line?.quantityAvailable ?? line?.available);
  const tail = Number.isFinite(available) && (line?.quantityAvailable ?? line?.available) != null ? ` (${available} available)` : '';
  return `${location}: take ${lineQuantity(line)}${tail}`;
}

/** "# 41 - OGN - Origins"; the code part only when the line has one. */
export function lineSetText(line) {
  const parts = [];
  if (line?.collectorNumber) parts.push(`# ${line.collectorNumber}`);
  const code = String(line?.expansionCode || '').trim();
  const expansion = String(line?.expansion || '').trim();
  if (code && code !== expansion) parts.push(code);
  if (expansion) parts.push(expansion);
  return parts.join(' - ');
}

const RARITY_SHORT = { 'double rare': 'RR', mythic: 'M', 'mythic rare': 'M', promo: 'P' };

/** `{ short, long }` for the rarity badge: "U Uncommon", "SIR Special Illustration Rare". */
export function rarityBadge(rarity) {
  const long = String(rarity || '').trim();
  if (!long) return null;
  const key = long.toLowerCase();
  const short = RARITY_SHORT[key] || long.split(/[\s/-]+/).filter(Boolean).map((word) => word[0].toUpperCase()).join('');
  return { short, long };
}

/** `[{ lineKey, picked, issue }]` still waiting for the server. */
export function dirtyPickEntries(cache = {}) {
  return Object.entries(cache || {})
    .filter(([, entry]) => entry?.dirty)
    .map(([lineKey, entry]) => ({ lineKey, picked: entry.picked, issue: cleanIssue(entry.issue) }));
}

/**
 * One-time migration of the old per-browser ticks (`pokoin.ctZero.picked.<orderId>`,
 * an array of item ids): every line of those items becomes fully picked, as
 * dirty entries, but only when the server has no picks for the order yet.
 */
export function migrateLegacyPicks(lines = [], legacyIds = [], cache = {}) {
  const ids = new Set((legacyIds || []).map(String));
  if (!ids.size) return cache;
  const serverHasPicks = lines.some((line) => Number(line?.picked) > 0 || line?.issue);
  if (serverHasPicks) return cache;
  let next = { ...cache };
  for (const line of lines) {
    if (!ids.has(String(line?.itemId)) || next[lineKeyOf(line)]) continue;
    next = setPickEntry(next, line, { picked: lineQuantity(line) });
  }
  return next;
}

export function readPickCache(storage, orderId) {
  try {
    const raw = JSON.parse(storage.getItem(PICK_CACHE_KEY + orderId) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (_) {
    return {};
  }
}

export function writePickCache(storage, orderId, cache) {
  try {
    if (Object.keys(cache || {}).length) storage.setItem(PICK_CACHE_KEY + orderId, JSON.stringify(cache));
    else storage.removeItem(PICK_CACHE_KEY + orderId);
  } catch (_) {
    /* private mode: the cache just doesn't survive a reload */
  }
}

/** Old ticks, or null when there is no legacy key. */
export function takeLegacyPicked(storage, orderId) {
  try {
    const raw = storage.getItem(LEGACY_PICKED_KEY + orderId);
    if (raw == null) return null;
    storage.removeItem(LEGACY_PICKED_KEY + orderId);
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch (_) {
    return null;
  }
}

/* ---------- display ---------- */

export function lineFacets(line) {
  return [
    line?.condition,
    line?.language,
    line?.reverse ? 'Reverse' : '',
    line?.foil ? 'Foil' : '',
    line?.firstEdition ? '1st ed.' : '',
    line?.signed ? 'Signed' : '',
    line?.altered ? 'Altered' : '',
    line?.graded ? 'Graded' : '',
  ].filter(Boolean);
}

/** Where to pick: the Pokoin location, else the location the server ranked (a Power Tools name), else Power Tools'. */
export function lineLocation(line) {
  return line?.location || line?.sortLocation || line?.powerTools?.location || '';
}

/** The shown location came from Power Tools, not from MyPokoin. */
export function lineLocationFromPt(line) {
  if (line?.locationSource) return line.locationSource === 'powertools';
  return !line?.location && Boolean(line?.sortLocation || line?.powerTools?.location);
}

/** Lowercase, accents stripped: "Pokémon" matches "pokemon". */
export function foldText(value) {
  return String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Search across name, English name, expansion, collector number, and location. */
export function lineMatches(line, query) {
  const needle = foldText(query).trim();
  if (!needle) return false;
  return [line?.name, line?.nameEn, line?.expansion, line?.collectorNumber, lineLocation(line)]
    .some((field) => foldText(field).includes(needle));
}

/* ---------- CSV (Power Tools picking columns) ---------- */

export const ZERO_CSV_COLUMNS = [
  'status', 'orderBin', 'count', 'category', 'cn', 'color', 'expansionCode', 'expansionName',
  'localizedName', 'englishName', 'language', 'condition', 'price', 'comments', 'finishType',
  'isSigned', 'isAltered', 'issues', 'locationWherePick', 'quantityToPickInLocation', 'totalPickedQuantity',
];

export function csvField(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Power Tools-style picking CSV for one shipment; `cache` overlays unsaved picks. */
export function zeroPickCsv(order, cache = {}) {
  const rows = [ZERO_CSV_COLUMNS];
  for (const line of order?.items || []) {
    const pick = effectivePick(line, cache);
    const quantity = lineQuantity(line);
    const status = pick.issue ? 'WITH ISSUE' : pick.picked >= quantity ? 'PICKED' : 'TO PICK';
    rows.push([
      status,
      line.powerTools?.bin || '',
      quantity,
      zeroGameLabel(line.game),
      line.collectorNumber || '',
      '',
      '',
      line.expansion || '',
      line.name || '',
      line.nameEn || line.name || '',
      line.language || '',
      line.condition || '',
      line.lineCents != null ? (Number(line.lineCents) / 100).toFixed(2) : '',
      '',
      line.reverse ? 'Reverse' : line.foil ? 'Foil' : '',
      line.signed ? 'true' : 'false',
      line.altered ? 'true' : 'false',
      pick.issue?.type || '',
      lineLocation(line),
      quantity,
      `${pick.picked}/${quantity}`,
    ]);
  }
  return `${rows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n`;
}

/* ---- last pack (instant paint on revisit) ---- */

export const LAST_PACK_PREFIX = 'pokoin.ctZero.last.';
const LAST_PACK_MAX_CHARS = 2_000_000;
const LAST_PACK_MAX_AGE_MS = 7 * 86_400_000;

/** The seller's last Zero payload, painted while the fresh one loads (null when none, stale or unreadable). */
export function readLastPack(storage, uid, now = Date.now()) {
  if (!storage || !uid) return null;
  try {
    const saved = JSON.parse(storage.getItem(LAST_PACK_PREFIX + uid) || 'null');
    if (!saved?.data || !(now - Number(saved.savedAt) < LAST_PACK_MAX_AGE_MS)) return null;
    return saved.data;
  } catch (_) {
    return null;
  }
}

/** Keep the payload for the next visit; a pack too big for storage is dropped, not half-kept. */
export function writeLastPack(storage, uid, data, now = Date.now()) {
  if (!storage || !uid || !data) return false;
  try {
    const raw = JSON.stringify({ savedAt: now, data });
    if (raw.length > LAST_PACK_MAX_CHARS) {
      storage.removeItem(LAST_PACK_PREFIX + uid);
      return false;
    }
    storage.setItem(LAST_PACK_PREFIX + uid, raw);
    return true;
  } catch (_) {
    return false;
  }
}
