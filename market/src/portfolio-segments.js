/**
 * Segment rows for the Dashboard "Your collection" tile.
 *
 * `GET /api/marketplace-portfolio-history` answers one point per UTC day with
 * the seller's value split into segments (per game, per era or set of that
 * game, Sealed and Graded). This module turns that raw answer into the table
 * the desk paints: levels, rows, sparkline geometry and the versus chart of one
 * segment against the whole collection. Segment keys are opaque — everything is
 * keyed off `group` and `game`, never off the key's shape.
 */

import { addUtcDays, utcDayKey } from './portfolio-history.js';
import { GAMES } from './game.js';

export const ALL_LEVEL = 'all';

/**
 * The level of the seller's own named lists. It is not a split of the
 * collection but a view beside it, so it never appears as a `group` in the
 * history answer — only in the collections answer nested on the model.
 */
export const COLLECTIONS_LEVEL = 'collections';

const GROUPS = new Set(['game', 'type', 'era', 'set', 'collection']);
/** Only these groups make a level of their own beside `all`. */
const LEVEL_GROUPS = new Set(['era', 'set', 'type']);

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function positiveOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Keep the inner box inside the frame even for a silly pad. */
function padFor(pad, width, height) {
  const n = Number(pad);
  const safe = Number.isFinite(n) && n > 0 ? n : 0;
  return Math.min(safe, Math.min(width, height) / 2);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function gameName(id) {
  const row = GAMES[String(id || '')];
  return row?.name || String(id || '');
}

/** `years` as the muted line under a label: a range, one year or free text. */
function yearsText(years) {
  if (typeof years === 'string') return years.trim();
  const n = numberOrNull(years);
  if (n != null && years != null && years !== '') return String(Math.round(n));
  if (!Array.isArray(years)) return '';
  const list = years.map((year) => numberOrNull(year)).filter((year) => year != null);
  if (!list.length) return '';
  const lo = Math.min(...list);
  const hi = Math.max(...list);
  return lo === hi ? String(Math.round(lo)) : `${Math.round(lo)}–${Math.round(hi)}`;
}

function normalizeSegmentDef(row) {
  const key = text(row?.key);
  const group = text(row?.group);
  if (!key || !GROUPS.has(group)) return null;
  const game = text(row?.game) || (group === 'type' ? ALL_LEVEL : '');
  return {
    key,
    group,
    game,
    label: text(row?.label),
    years: row?.years,
  };
}

/** `[valuePkn, cardsPriced, cardsHeld]` — anything else is not a segment. */
function normalizeSegmentEntry(entry) {
  if (!Array.isArray(entry) || entry.length !== 3) return null;
  const [valuePkn, priced, held] = entry.map(numberOrNull);
  if ([valuePkn, priced, held].some((n) => n == null || n < 0)) return null;
  return { valuePkn, priced, held };
}

function normalizeSegmentDay(row) {
  const date = utcDayKey(row?.date ?? row?.day ?? '');
  if (!date) return null;
  const cardsValuePkn = numberOrNull(row?.cardsValuePkn);
  const segments = {};
  const source = row?.segments && typeof row.segments === 'object' ? row.segments : null;
  for (const [rawKey, entry] of Object.entries(source || {})) {
    const key = text(rawKey);
    const value = normalizeSegmentEntry(entry);
    if (key && value) segments[key] = value;
  }
  return { date, cardsValuePkn: cardsValuePkn == null || cardsValuePkn < 0 ? null : cardsValuePkn, segments };
}

/**
 * The answer's `segmentDefs` as defs: junk and repeats dropped, first wins.
 * Shared with the collections module, which turns saved lists into defs.
 */
export function normalizeSegmentDefs(rows) {
  const seen = new Set();
  const defs = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const def = normalizeSegmentDef(row);
    if (!def || seen.has(def.key)) continue;
    seen.add(def.key);
    defs.push(def);
  }
  return defs;
}

/**
 * The raw answer as one model, or null when there is nothing to table:
 * a server without `segments`, one without `segmentDefs`, junk.
 */
export function normalizeSegments(data) {
  const defs = normalizeSegmentDefs(data?.segmentDefs);
  const rows = Array.isArray(data) ? data : (Array.isArray(data?.days) ? data.days : []);
  const byDate = new Map();
  for (const row of rows) {
    const day = normalizeSegmentDay(row);
    if (day) byDate.set(day.date, day);
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!defs.length) return null;
  if (!days.some((day) => Object.keys(day.segments).length)) return null;
  return { defs, days };
}

/**
 * The custom-collections sub-model nested on a segments model, or null when no
 * collections answer was supplied at all. Supplied and empty is not null: a
 * seller with nothing saved still gets the level and the "New collection"
 * button to start with.
 */
export function collectionsModel(model) {
  const sub = model?.collections;
  return sub && Array.isArray(sub.defs) && Array.isArray(sub.days) ? sub : null;
}

/** `model` with the seller's saved lists nested on it, for the Collections level. */
export function withCollections(model, collections) {
  if (!model && !collections) return null;
  return { ...(model || { defs: [], days: [] }), collections: collections || null };
}

export function segmentLevels(model) {
  const defs = model?.defs;
  const saved = collectionsModel(model);
  if (!Array.isArray(defs) || !defs.length) {
    return saved ? [{ id: COLLECTIONS_LEVEL, label: 'Collections' }] : [];
  }
  const levels = [{ id: ALL_LEVEL, label: 'All games' }];
  const seen = new Set();
  for (const def of defs) {
    if (!LEVEL_GROUPS.has(def.group)) continue;
    const id = def.game;
    if (!id || id === ALL_LEVEL || seen.has(id)) continue;
    seen.add(id);
    levels.push({ id, label: gameName(id) });
  }
  if (saved) levels.push({ id: COLLECTIONS_LEVEL, label: 'Collections' });
  return levels;
}

/** The model's newest day that is not after `dayKey`, or '' when there is none. */
function lastDayAtOrBefore(model, dayKey) {
  const days = Array.isArray(model?.days) ? model.days : [];
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const date = text(days[index]?.date);
    if (date && date <= dayKey) return date;
  }
  return '';
}

/**
 * The window the desk reads. A range that carries its own two dates — the
 * graph's custom pick — wins as it is. A preset counts `days` backwards from
 * the model's newest day once that day already sits behind today, so a stored
 * copy a week old or a server whose series lags shows the days it actually has
 * instead of an empty tail of "None held".
 */
export function segmentWindow(model, range = {}, today = utcDayKey()) {
  const customFrom = text(range?.from);
  const customTo = text(range?.to);
  if (customFrom || customTo) return { from: customFrom, to: customTo };
  const days = Number(range?.days);
  if (!Number.isFinite(days) || days <= 0) return { from: '', to: today };
  const end = lastDayAtOrBefore(model, today) || today;
  return { from: addUtcDays(end, -days), to: end };
}

/**
 * The level the table opens on. "All games" is only worth a switch when at
 * least two games actually hold cards; a one-game collection opens on that
 * game, so a Pokémon-only book starts on Pokémon instead of on a two-row
 * "All games" list of which one row is an empty pile.
 *
 * The saved lists are the seller's own level, not a slice of the book, so they
 * never enter that choice: this answers what it answered before for the same
 * segments whatever collections exist, and `collections` only when there is no
 * other level to open on.
 */
export function defaultSegmentLevel(model) {
  const levels = segmentLevels(model);
  const book = levels.filter((level) => level.id !== COLLECTIONS_LEVEL);
  const lastDay = (Array.isArray(model?.days) ? model.days : []).at(-1) || null;
  const heldGames = new Set();
  for (const def of model?.defs || []) {
    if (def.group !== 'game') continue;
    if ((lastDay?.segments?.[def.key]?.held || 0) > 0) heldGames.add(def.game);
  }
  if (!book.length) return levels.length ? COLLECTIONS_LEVEL : ALL_LEVEL;
  if (heldGames.size >= 2) return ALL_LEVEL;
  const firstGame = book.find((level) => level.id !== ALL_LEVEL);
  return firstGame ? firstGame.id : ALL_LEVEL;
}

/** Days inside `[from, to]`; an empty bound is open. */
function windowedDays(model, window) {
  const days = Array.isArray(model?.days) ? model.days : [];
  const from = text(window?.from);
  const to = text(window?.to);
  if (!from && !to) return days;
  return days.filter((day) => (!from || day.date >= from) && (!to || day.date <= to));
}

function segmentValueAt(day, key) {
  const entry = day?.segments?.[key];
  return entry ? entry.valuePkn : 0;
}

function segmentCountAt(day, key, field) {
  const entry = day?.segments?.[key];
  return entry ? entry[field] : 0;
}

/** First positive value in the window to the last day, one decimal. */
function windowChangePct(series) {
  const positive = series.filter((point) => point.valuePkn > 0);
  if (positive.length < 2) return null;
  const first = positive[0].valuePkn;
  const last = series[series.length - 1].valuePkn;
  const pct = ((last - first) / first) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.round(pct * 10) / 10;
}

function segmentRow(def, days) {
  const series = days.map((day) => ({ date: day.date, valuePkn: segmentValueAt(day, def.key) }));
  const lastDay = days[days.length - 1] || null;
  const held = lastDay ? segmentCountAt(lastDay, def.key, 'held') : 0;
  const priced = lastDay ? segmentCountAt(lastDay, def.key, 'priced') : 0;
  const valuePkn = lastDay ? segmentCountAt(lastDay, def.key, 'valuePkn') : 0;
  const state = held <= 0
    ? 'empty'
    : (series.every((point) => point.valuePkn <= 0) ? 'unpriced' : 'ok');
  return {
    key: def.key,
    label: def.label || (def.group === 'game' ? gameName(def.game) : '') || 'Segment',
    sub: yearsText(def.years),
    held,
    priced,
    valuePkn,
    changePct: windowChangePct(series),
    series,
    state,
  };
}

/** The table for one level: group title plus its rows, empty groups skipped. */
export function segmentGroups(model, levelId, window = {}) {
  const defs = Array.isArray(model?.defs) ? model.defs : [];
  const level = text(levelId) || ALL_LEVEL;
  if (level === COLLECTIONS_LEVEL) {
    // The rows come from the collections answer, days and all: the history
    // model never carries a `collection:*` key.
    const saved = collectionsModel(model) || { defs: [], days: [] };
    const rows = (saved.defs || [])
      .filter((def) => def.group === 'collection')
      .map((def) => segmentRow(def, windowedDays(saved, window)));
    return rows.length ? [{ title: 'Collections', rows }] : [];
  }
  const days = windowedDays(model, window);
  const wanted = level === ALL_LEVEL
    ? [['Games', (def) => def.group === 'game'], ['Across all games', (def) => def.group === 'type' && def.game === ALL_LEVEL]]
    : [
      ['Eras', (def) => def.group === 'era' && def.game === level],
      ['Sets', (def) => def.group === 'set' && def.game === level],
      ['Types', (def) => def.group === 'type' && def.game === level],
    ];
  const groups = [];
  for (const [title, match] of wanted) {
    const rows = defs.filter(match).map((def) => segmentRow(def, days));
    if (rows.length) groups.push({ title, rows });
  }
  return groups;
}

/**
 * The whole collection over the window — the compare line of every chart. A
 * day whose value is unknown stays unknown rather than becoming a 0 that the
 * chart reads as a total loss: the dashed line bridges that gap.
 */
export function collectionSeries(model, window = {}) {
  return windowedDays(model, window).map((day) => ({
    date: day.date,
    valuePkn: numberOrNull(day.cardsValuePkn),
  }));
}

/**
 * The same whole-collection line read on the days of `series` rather than on
 * the model's own — the compare line of a custom collection, whose answer can
 * carry days the history does not have. Matched by date, and a day the history
 * model does not carry stays unknown instead of a 0 the chart reads as a loss.
 */
export function collectionSeriesOn(model, series) {
  const byDate = new Map();
  for (const day of (Array.isArray(model?.days) ? model.days : [])) {
    const date = text(day?.date);
    if (date) byDate.set(date, numberOrNull(day.cardsValuePkn));
  }
  return (Array.isArray(series) ? series : []).map((point) => {
    const date = text(point?.date);
    return { date, valuePkn: byDate.has(date) ? byDate.get(date) : null };
  });
}

function valueAt(item) {
  if (item !== null && typeof item === 'object') return numberOrNull(item.valuePkn);
  return numberOrNull(item);
}

/** Percent against the first positive value; null until that day. */
export function indexedSeries(series) {
  const values = (Array.isArray(series) ? series : []).map(valueAt);
  const start = values.findIndex((value) => value != null && value > 0);
  if (start < 0) return values.map(() => null);
  const base = values[start];
  return values.map((value, index) => {
    if (index < start || value == null) return null;
    const pct = ((value - base) / base) * 100;
    return Number.isFinite(pct) ? pct : null;
  });
}

function toXY(point) {
  if (Array.isArray(point)) return [numberOrNull(point[0]), numberOrNull(point[1])];
  if (point !== null && typeof point === 'object') return [numberOrNull(point.x), numberOrNull(point.y)];
  return [null, null];
}

/**
 * `[x, y]` pairs across the box, scaled to the series' own min and max: a flat
 * series sits on the middle line, a single value sits in the middle.
 */
export function sparkPoints(values, width, height, pad = 2) {
  const box = { width: positiveOr(width, 110), height: positiveOr(height, 26) };
  const inner = padFor(pad, box.width, box.height);
  const list = (Array.isArray(values) ? values : []).map((value) => valueAt(value) ?? 0);
  if (!list.length) return [];
  const max = Math.max(...list);
  const min = Math.min(...list);
  const usableW = Math.max(0, box.width - inner * 2);
  const usableH = Math.max(0, box.height - inner * 2);
  const middle = box.height / 2;
  return list.map((value, index) => {
    const x = list.length === 1 ? box.width / 2 : inner + (index / (list.length - 1)) * usableW;
    const y = max === min ? middle : inner + ((max - value) / (max - min)) * usableH;
    return [round3(x), round3(y)];
  });
}

/**
 * Where a sparkline's end dot sits: the last of the `sparkPoints` pairs as the
 * `{x, y}` a `<circle>` binds, or null when nothing was plotted. `sparkPoints`
 * answers `[x, y]` pairs, so binding its last entry's fields would put the dot
 * at (0, 0).
 */
export function sparkEndPoint(points) {
  const [x, y] = toXY(Array.isArray(points) ? points[points.length - 1] : null);
  return x == null || y == null ? null : { x, y };
}

/**
 * An SVG path through `[x, y]` pairs as a monotone cubic: every control point
 * sits inside its own segment's box, so the curve never rises above the
 * highest or dips below the lowest value it joins.
 */
export function smoothPath(points) {
  const kept = [];
  for (const point of points || []) {
    const [x, y] = toXY(point);
    if (x == null || y == null) continue;
    if (kept.length && !(x > kept[kept.length - 1].x)) continue;
    kept.push({ x, y });
  }
  if (!kept.length) return '';
  const at = (value) => round3(value).toString();
  const head = `M ${at(kept[0].x)} ${at(kept[0].y)}`;
  if (kept.length === 1) return head;
  const slopes = [];
  for (let i = 1; i < kept.length; i += 1) {
    slopes.push((kept[i].y - kept[i - 1].y) / (kept[i].x - kept[i - 1].x));
  }
  const tangents = [slopes[0]];
  for (let i = 1; i < slopes.length; i += 1) {
    const left = slopes[i - 1];
    const right = slopes[i];
    if (left * right <= 0) tangents.push(0);
    else tangents.push(Math.sign(left) * Math.min(Math.abs((left + right) / 2), 3 * Math.min(Math.abs(left), Math.abs(right))));
  }
  tangents.push(slopes[slopes.length - 1]);
  const runs = [];
  for (let i = 0; i < slopes.length; i += 1) {
    const dx = kept[i + 1].x - kept[i].x;
    runs.push([
      `C ${at(kept[i].x + dx / 3)} ${at(kept[i].y + (tangents[i] * dx) / 3)}`,
      `${at(kept[i + 1].x - dx / 3)} ${at(kept[i + 1].y - (tangents[i + 1] * dx) / 3)}`,
      `${at(kept[i + 1].x)} ${at(kept[i + 1].y)}`,
    ].join(', '));
  }
  return [head, ...runs].join(' ');
}

function percentList(series) {
  return (Array.isArray(series) ? series : []).map(valueAt);
}

function firstIndex(lists) {
  for (const list of lists) {
    const index = list.findIndex((value) => value != null && Number.isFinite(value));
    if (index >= 0) return index;
  }
  return -1;
}

/**
 * The opened chart: segment and collection as percent change on one shared
 * scale that always holds 0. A day's x is its index in the window — both lists
 * carry one entry per day of the range — so a series whose first value comes
 * later starts its line at its own date instead of at the left edge, and the
 * labels under the chart (the window's first and last day) stay true.
 * `last` is the segment's end point, for the dot.
 */
export function versusPaths(segmentPct, collectionPct, width, height, pad = 12) {
  const box = { width: positiveOr(width, 320), height: positiveOr(height, 150) };
  const inner = padFor(pad, box.width, box.height);
  const lists = [percentList(segmentPct), percentList(collectionPct)];
  const empty = { segment: '', collection: '', zeroY: box.height / 2, last: null };
  if (firstIndex(lists) < 0) return empty;
  const days = Math.max(lists[0].length, lists[1].length);
  const values = lists.flat().filter((value) => value != null && Number.isFinite(value));
  let hi = Math.max(0, ...values);
  let lo = Math.min(0, ...values);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const span = Math.max(1e-9, hi - lo);
  const usableW = Math.max(0, box.width - inner * 2);
  const usableH = Math.max(0, box.height - inner * 2);
  const xOf = (index) => (days === 1 ? box.width / 2 : inner + (index / (days - 1)) * usableW);
  const yOf = (value) => inner + ((hi - value) / span) * usableH;
  const pathFor = (list) => smoothPath(list
    .map((value, index) => (value == null || !Number.isFinite(value) ? null : [xOf(index), yOf(value)]))
    .filter(Boolean));
  const segment = pathFor(lists[0]);
  let last = null;
  for (let i = lists[0].length - 1; i >= 0; i -= 1) {
    const value = lists[0][i];
    if (value == null || !Number.isFinite(value)) continue;
    last = { x: round3(xOf(i)), y: round3(yOf(value)), pct: value };
    break;
  }
  return {
    segment,
    collection: pathFor(lists[1]),
    zeroY: round3(yOf(0)),
    last,
  };
}

/** `+8.6%`, `-3.2%`, `0.0%`, or nothing at all. */
export function formatSegmentChange(pct) {
  const value = numberOrNull(pct);
  if (value == null) return '';
  const shown = Math.round(Math.abs(value) * 10) / 10;
  if (shown === 0) return '0.0%';
  return `${value > 0 ? '+' : '-'}${shown.toFixed(1)}%`;
}
