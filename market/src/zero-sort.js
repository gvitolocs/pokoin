/**
 * CardTrader Zero picking sort: Power Tools' sort model (up to 4 levels of
 * `field.asc` / `field.desc`, `none`, `extras`) and a port of the Rust
 * comparator (pokoin-rust/crates/external/src/cardtrader/zero.rs). Both are
 * tested against the same fixture, fixtures/zero-sort-cases.json.
 */

export const SORT_LEVELS = 4;
export const DEFAULT_SORT_FIELDS = ['game.asc', 'location.asc', 'none', 'none'];
export const DUPLICATE_SORT_MESSAGE = 'You cannot use the same sorting field more than once';

/** Power Tools' sort fields in its menu order; `bare` fields have no direction. */
export const SORT_FIELDS = [
  { field: 'none', label: 'None', bare: true },
  { field: 'extras', label: 'Extras', bare: true },
  { field: 'cn', label: 'CN' },
  { field: 'color', label: 'Color (alphabetical)' },
  { field: 'comment', label: 'Comment' },
  { field: 'condition', label: 'Condition' },
  { field: 'product.enName', label: 'English name' },
  { field: 'product.expansion', label: 'Expansion' },
  { field: 'game', label: 'Game' },
  { field: 'language', label: 'Language' },
  { field: 'product.locName', label: 'Localized name' },
  { field: 'location', label: 'Location' },
  { field: 'orderBin', label: 'Order Bin' },
  { field: 'price', label: 'Price' },
  { field: 'product.rarity', label: 'Rarity', asc: 'common to rare', desc: 'rare to common' },
  { field: 'releaseDate', label: 'Release Date' },
  { field: 'releaseExpCode', label: 'Release date + Expansion code' },
  { field: 'set', label: 'Set' },
];

/** `[{ value, label }]` for one dropdown: `game.asc` → "Game (asc)". */
export const SORT_OPTIONS = SORT_FIELDS.flatMap((entry) => (entry.bare
  ? [{ value: entry.field, label: entry.label }]
  : ['asc', 'desc'].map((dir) => ({ value: `${entry.field}.${dir}`, label: `${entry.label} (${entry[dir] || dir})` }))));

const KNOWN = new Set(SORT_OPTIONS.map((option) => option.value));

/** `{ field, desc }` of one value; `none` → field "none". */
export function splitSortValue(value) {
  const text = String(value || 'none');
  const match = /^(.+)\.(asc|desc)$/.exec(text);
  return match ? { field: match[1], desc: match[2] === 'desc' } : { field: text, desc: false };
}

/**
 * Validates the 4 levels like the server: known values, no real field after a
 * `none`, no field twice (direction ignored). `{ ok, fields, error, level }`;
 * `fields` is padded to 4 with `none`.
 */
export function validateSortFields(input = []) {
  const list = Array.isArray(input) ? input.map((value) => String(value || 'none')) : [];
  if (list.length > SORT_LEVELS) return { ok: false, error: 'Up to 4 sorting levels.', code: 'invalid_sorting_fields' };
  const fields = [...list, ...Array(SORT_LEVELS - list.length).fill('none')];
  const seen = new Set();
  let ended = false;
  for (let level = 0; level < fields.length; level += 1) {
    const value = fields[level];
    if (!KNOWN.has(value)) return { ok: false, error: `Unknown sorting field: ${value}`, code: 'invalid_sorting_field', level };
    if (value === 'none') {
      ended = true;
      continue;
    }
    if (ended) return { ok: false, error: 'Set the sorting levels in order.', code: 'invalid_sorting_fields', level };
    const { field } = splitSortValue(value);
    if (seen.has(field)) return { ok: false, error: DUPLICATE_SORT_MESSAGE, code: 'duplicate_sorting_field', level };
    seen.add(field);
  }
  return { ok: true, fields };
}

/**
 * One dropdown changed. Returns `{ fields }` (levels after a `none` are
 * cleared) or `{ error }` when the field is already used on another level.
 */
export function chooseSortField(fields, level, value) {
  const current = validateSortFields(fields).fields || [...DEFAULT_SORT_FIELDS];
  const next = [...current];
  next[level] = value;
  if (value === 'none') {
    for (let after = level + 1; after < SORT_LEVELS; after += 1) next[after] = 'none';
  }
  const { field } = splitSortValue(value);
  if (value !== 'none' && current.some((other, at) => at !== level && other !== 'none' && splitSortValue(other).field === field)) {
    return { error: DUPLICATE_SORT_MESSAGE };
  }
  return { fields: next };
}

/** Level n+1 is usable only once level n is set. */
export function sortLevelEnabled(fields, level) {
  return level === 0 || (fields?.[level - 1] && fields[level - 1] !== 'none');
}

export function sameSortFields(a = [], b = []) {
  const left = validateSortFields(a).fields || [];
  const right = validateSortFields(b).fields || [];
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/* ---------- comparator (port of zero.rs) ---------- */

const text = (value) => (value == null ? '' : String(value).trim());
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function codePoints(value) {
  return Array.from(value.toLowerCase(), (char) => char.codePointAt(0));
}

const isDigit = (point) => point >= 48 && point <= 57;

function digitsCmp(a, b) {
  const left = a.replace(/^0+/, '');
  const right = b.replace(/^0+/, '');
  return cmp(left.length, right.length) || cmp(left, right);
}

/** Case-insensitive natural compare, digit runs by value (`box2` < `box10`). */
export function naturalCmp(a, b) {
  const x = codePoints(text(a));
  const y = codePoints(text(b));
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (isDigit(x[i]) && isDigit(y[j])) {
      const startA = i;
      while (i < x.length && isDigit(x[i])) i += 1;
      const startB = j;
      while (j < y.length && isDigit(y[j])) j += 1;
      const order = digitsCmp(String.fromCodePoint(...x.slice(startA, i)), String.fromCodePoint(...y.slice(startB, j)));
      if (order) return order;
      continue;
    }
    if (x[i] !== y[j]) return cmp(x[i], y[j]);
    i += 1;
    j += 1;
  }
  return cmp(x.length - i, y.length - j);
}

/** Numeric when both are all digits, else natural. */
export function idCmp(a, b) {
  const left = text(a);
  const right = text(b);
  const digits = (value) => /^\d+$/.test(value);
  return digits(left) && digits(right) ? digitsCmp(left, right) : naturalCmp(left, right);
}

/** Present values first, ascending. */
function optionFirst(a, b) {
  if (a != null && b != null) return cmp(a, b);
  if (a != null) return -1;
  if (b != null) return 1;
  return 0;
}

function jsParseInt(part) {
  const value = parseInt(part, 10);
  return Number.isNaN(value) ? null : value;
}

/** `parseListingLocation`: box before the first `·`/`•`, then stack, position. */
export function parseSlot(location) {
  const value = text(location);
  const sep = value.search(/[·•]/);
  if (sep < 0) return { box: value, stack: null, position: null };
  const numbers = value.slice(sep + 1).split(/[·•]/).map(jsParseInt).filter((n) => n != null && n > 0);
  return { box: value.slice(0, sep).trim(), stack: numbers[0] ?? null, position: numbers[1] ?? null };
}

/** Power Tools display name minus a `: n (m available)` tail; "" / "unknown…" are no location. */
export function ptDisplayLocation(name) {
  const value = text(name).slice(0, 120)
    .replace(/\s*(?::\s*\d+\s*)?\(\s*\d+\s+available\s*\)\s*$/i, '')
    .trim()
    .replace(/:+$/, '')
    .trim();
  return !value || value.toLowerCase().startsWith('unknown') ? '' : value;
}

/** Power Tools import grammar (`trailing_stack`): "BOX 001 - 131" → box "BOX 001" stack 131. */
export function ptSlot(name) {
  const value = text(name);
  if (/[·•]/.test(value)) return parseSlot(value);
  const clamp = (digits) => Math.max(1, Math.min(9999, Number(digits) || 1));
  const dash = /^(.+?)\s+-\s+(\d+)$/.exec(value);
  if (dash) return { box: dash[1].trim().slice(0, 64), stack: clamp(dash[2]), position: null };
  const space = /^(.+?)[\s_]+(\d+)$/.exec(value);
  if (space && /[A-Za-z]/.test(space[1])) return { box: space[1].trim().slice(0, 64), stack: clamp(space[2]), position: null };
  return { box: value, stack: null, position: null };
}

/** `[location, source]`: the Pokoin location, else the Power Tools one. */
export function effectiveLocation(line) {
  const pokoin = text(line?.location);
  if (pokoin) return [pokoin, 'pokoin'];
  const pt = ptDisplayLocation(line?.ptLocation);
  if (pt) return [pt, 'powertools'];
  return ['', ''];
}

const rankSlot = (location, source) => (source === 'powertools' ? ptSlot(location) : parseSlot(location));

const GAME_RANK = { magic: 0, pokemon: 1, yugioh: 2, riftbound: 3 };

/** magic, pokemon, yugioh, riftbound, every other game, unknown last. */
export function gameRank(game) {
  if (game in GAME_RANK) return GAME_RANK[game];
  return game ? 4 : 5;
}

function listedMs(line) {
  const ms = Date.parse(line?.listedAt || '');
  return Number.isFinite(ms) ? ms : null;
}

const gameOf = (line) => text(line?.game).toLowerCase();

function gameCmp(a, b) {
  const left = gameOf(a);
  const right = gameOf(b);
  return cmp(gameRank(left), gameRank(right)) || cmp(left, right);
}

/** Present values first; present values by `compare`, reversed when `desc` (blanks last either way). */
function presentFirst(a, b, desc, compare = cmp) {
  if (a != null && b != null) return (desc ? -1 : 1) * compare(a, b);
  if (a != null) return -1;
  if (b != null) return 1;
  return 0;
}

const nonEmpty = (value) => text(value) || null;

/**
 * Located first (both directions), then box, stack (stacked before bare),
 * position, listed date, listing id. `desc` reverses box, stack and position values only.
 */
function locationCmp(a, b, desc = false) {
  const [locA, srcA] = effectiveLocation(a);
  const [locB, srcB] = effectiveLocation(b);
  const located = cmp(locA === '' ? 1 : 0, locB === '' ? 1 : 0);
  if (located) return located;
  const slotA = rankSlot(locA, srcA);
  const slotB = rankSlot(locB, srcB);
  const idA = text(a?.listingId);
  const idB = text(b?.listingId);
  return (desc ? -1 : 1) * naturalCmp(slotA.box, slotB.box)
    || presentFirst(slotA.stack, slotB.stack, desc)
    || presentFirst(slotA.position, slotB.position, desc)
    || optionFirst(listedMs(a), listedMs(b))
    || cmp(idA === '' ? 1 : 0, idB === '' ? 1 : 0)
    || idCmp(idA, idB);
}

/** PR A's full picking order; the final tiebreak of every sort. */
export function comparePickingLines(a, b) {
  return gameCmp(a, b)
    || locationCmp(a, b)
    || naturalCmp(a?.expansion, b?.expansion)
    || naturalCmp(a?.collectorNumber, b?.collectorNumber)
    || naturalCmp(a?.name, b?.name)
    || idCmp(a?.itemId, b?.itemId)
    || cmp(text(a?.lineKey), text(b?.lineKey));
}

const CONDITION_RANK = {
  nm: 0, mint: 0, 'near mint': 0,
  sp: 1, ex: 1, 'slightly played': 1, lp: 1,
  mp: 2, gd: 2, 'moderately played': 2,
  pl: 3, 'lp-pl': 3, played: 3, hp: 3,
  poor: 4, po: 4,
};

export function conditionRank(condition) {
  const key = text(condition).toLowerCase();
  return key in CONDITION_RANK ? CONDITION_RANK[key] : null;
}

const RARITY_RANK = {
  common: 0,
  uncommon: 1,
  rare: 2,
  'holo rare': 3,
  'rare holo': 3,
  mythic: 3,
  'mythic rare': 3,
  'reverse holo': 4,
  'reverse holo rare': 4,
  'double rare': 5,
  'ultra rare': 6,
  'illustration rare': 7,
  'special illustration rare': 8,
  'hyper rare': 9,
  'secret rare': 9,
  promo: 10,
};

/** Common → rare; unknown rarities are null (sorted last). */
export function rarityRank(rarity) {
  const key = text(rarity).toLowerCase();
  return key in RARITY_RANK ? RARITY_RANK[key] : null;
}

function centsOf(line) {
  const value = line?.unitCents;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** Natural compare of one text field, blanks last in both directions. */
const textLevel = (key) => (a, b, desc) => presentFirst(nonEmpty(a?.[key]), nonEmpty(b?.[key]), desc, naturalCmp);
const englishName = (line) => nonEmpty(line?.nameEn) || nonEmpty(line?.name);

const FIELD_CMP = {
  game: (a, b, desc) => (desc ? -1 : 1) * gameCmp(a, b),
  location: (a, b, desc) => locationCmp(a, b, desc),
  cn: textLevel('collectorNumber'),
  condition: (a, b, desc) => presentFirst(conditionRank(a?.condition), conditionRank(b?.condition), desc),
  language: textLevel('language'),
  price: (a, b, desc) => presentFirst(centsOf(a), centsOf(b), desc),
  orderBin: (a, b, desc) => presentFirst(nonEmpty(a?.powerTools?.bin), nonEmpty(b?.powerTools?.bin), desc, naturalCmp),
  'product.rarity': (a, b, desc) => presentFirst(rarityRank(a?.rarity), rarityRank(b?.rarity), desc),
  set: textLevel('expansion'),
  'product.expansion': textLevel('expansion'),
  'product.enName': (a, b, desc) => presentFirst(englishName(a), englishName(b), desc, naturalCmp),
  'product.locName': textLevel('name'),
  // Lines carry these only when a source fills them; blanks go last.
  comment: textLevel('comment'),
  color: textLevel('color'),
  releaseDate: textLevel('releaseDate'),
  releaseExpCode: textLevel('releaseExpCode'),
  extras: textLevel('extras'),
};

/** The chosen levels, then the full default order as the final tiebreak. */
export function compareWithFields(a, b, fields = DEFAULT_SORT_FIELDS) {
  for (const value of fields || []) {
    if (!value || value === 'none') continue;
    const { field, desc } = splitSortValue(value);
    const order = FIELD_CMP[field]?.(a, b, desc) || 0;
    if (order) return order;
  }
  return comparePickingLines(a, b);
}

/** A sorted copy; invalid fields fall back to the default order. */
export function sortZeroLines(lines = [], fields = DEFAULT_SORT_FIELDS) {
  const checked = validateSortFields(fields);
  const use = checked.ok ? checked.fields : DEFAULT_SORT_FIELDS;
  return [...lines].sort((a, b) => compareWithFields(a, b, use));
}

/** CardTrader item ids in this order, each once: the `sequence` of a Power Tools sort. */
export function sortSequence(lines = []) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const id = text(line?.itemId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
