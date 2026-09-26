/** Daily portfolio snapshot points for the Dashboard history chart. */

import { formatPknNumber } from './pkn.js';

export function asNonNeg(value) {
  const n = Math.max(0, Number(value) || 0);
  return Number.isFinite(n) ? n : 0;
}

/** Round up to a clean axis max (never zero). */
export function niceScaleMax(value) {
  const n = asNonNeg(value);
  if (n <= 0) return 20;
  const exp = Math.floor(Math.log10(n));
  const base = 10 ** exp;
  const f = n / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * base;
}

export function yTickValues(max, count = 4) {
  const top = niceScaleMax(max);
  return Array.from({ length: count + 1 }, (_, i) => Math.round((top * i) / count));
}

export function utcDayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export function formatDayLabel(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!m) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}`;
}

/**
 * One day of portfolio value.
 * totalPkn is the wallet that day plus the market value of cards we could
 * price. A missing card price is left out — it is not zero and not an ask.
 * Idempotent: already-normalized rows keep assets.* (desk may re-normalize).
 */
export function normalizeHistoryDay(row = {}) {
  const prior = row && typeof row.assets === 'object' && row.assets ? row.assets : null;
  const currencyPkn = asNonNeg(
    row.currencyPkn ?? row.currency ?? prior?.currencyPkn,
  );
  const listedPkn = asNonNeg(
    row.listedPkn ?? row.listed ?? prior?.listedPkn,
  );
  const cardsKnown = row.cardsKnown === true || prior?.cardsKnown === true;
  const rawCards = row.cardsValuePkn != null ? row.cardsValuePkn : prior?.cardsValuePkn;
  const cardsValuePkn = cardsKnown && rawCards != null && rawCards !== ''
    ? asNonNeg(rawCards)
    : null;
  const nftValuePkn = asNonNeg(
    row.nftValuePkn ?? prior?.nftValuePkn,
  );
  const cardsOwned = asNonNeg(
    row.cardsOwned ?? row.ownedCards ?? prior?.cardsOwned,
  );
  const nftOwned = asNonNeg(row.nftOwned ?? prior?.nftOwned);
  const totalPkn = currencyPkn + (cardsValuePkn || 0);
  const date = utcDayKey(row.date || row.day || new Date());
  if (!date) return null;
  return {
    date,
    totalPkn,
    assets: {
      currencyPkn,
      listedPkn,
      cardsValuePkn,
      cardsKnown: cardsValuePkn != null,
      nftValuePkn,
      cardsOwned,
      nftOwned,
    },
  };
}

/** Build today's live point from Dashboard metrics. */
export function todayHistoryDay({
  currencyPkn = 0,
  listedPkn = 0,
  cardsValuePkn = 0,
  nftValuePkn = 0,
  cardsOwned = 0,
  nftOwned = 0,
  date = new Date(),
} = {}) {
  return normalizeHistoryDay({
    date,
    currencyPkn,
    listedPkn,
    cardsValuePkn,
    nftValuePkn,
    cardsOwned,
    nftOwned,
  });
}

const HISTORY_KEY = 'pokoin.portfolioHistory';
const HISTORY_DAYS = 400;

function historyStore() {
  try {
    const local = globalThis.localStorage;
    if (local && typeof local.getItem === 'function') return local;
  } catch {
    /* private mode */
  }
  return null;
}

function readHistoryBook() {
  const store = historyStore();
  if (!store) return {};
  try {
    const raw = JSON.parse(store.getItem(HISTORY_KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** Days already saved for this Firebase uid, oldest first. */
export function readPortfolioHistory(uid) {
  const id = String(uid || '').trim();
  if (!id) return [];
  const rows = readHistoryBook()[id];
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => normalizeHistoryDay(row)).filter(Boolean).slice(-HISTORY_DAYS);
}

/**
 * Remember one snapshot per UTC day. A later visit the same day replaces
 * that point; it does not invent earlier days.
 */
export function writePortfolioHistory(uid, day) {
  const id = String(uid || '').trim();
  const point = normalizeHistoryDay(day);
  const prior = readPortfolioHistory(id);
  if (!id || !point) return prior;
  const next = prior.filter((row) => row.date !== point.date);
  next.push(point);
  next.sort((a, b) => a.date.localeCompare(b.date));
  const kept = next.slice(-HISTORY_DAYS);
  const store = historyStore();
  if (store) {
    const book = readHistoryBook();
    book[id] = kept;
    try {
      store.setItem(HISTORY_KEY, JSON.stringify(book));
    } catch {
      /* quota */
    }
  }
  return kept;
}

/** Stored days, with today's live totals winning that date. */
export function withLiveHistoryDay(series, today) {
  const days = (Array.isArray(series) ? series : [])
    .map((row) => normalizeHistoryDay(row))
    .filter(Boolean);
  const live = today ? normalizeHistoryDay(today) : null;
  if (!live) return days;
  const next = days.filter((row) => row.date !== live.date);
  next.push(live);
  next.sort((a, b) => a.date.localeCompare(b.date));
  return next;
}

export function historySeriesMax(days = []) {
  let max = 0;
  for (const day of days || []) {
    max = Math.max(max, asNonNeg(day?.totalPkn));
  }
  return max;
}

/** Realized history ends here when the window includes today. The rest is a projection. */
export const HISTORY_REALIZED_SPLIT = 2 / 3;

export function historyWindowSplit(points, today = new Date()) {
  const last = points?.[points.length - 1]?.date || '';
  return last && last === utcDayKey(today) ? HISTORY_REALIZED_SPLIT : 1;
}

/** Map a day onto the plot. Today's window uses only the first two thirds. */
export function historyPlotX(date, { from, to, width, split = 1 } = {}) {
  const start = Date.parse(`${from || ''}T00:00:00Z`);
  const end = Date.parse(`${to || ''}T00:00:00Z`);
  const span = end - start;
  if (!Number.isFinite(span) || span <= 0) return split < 1 ? width * split : width / 2;
  const at = Date.parse(`${date}T00:00:00Z`);
  const t = (at - start) / span;
  return Math.min(1, Math.max(0, t)) * width * split;
}

/** Pointer ratio across the plot. Past the split, the day is today and the rest is a projection. */
export function historyPointerDay(days, ratio, { split = 1 } = {}) {
  const t = Math.min(1, Math.max(0, Number(ratio) || 0));
  const projection = split < 1 && t > split;
  const day = nearestHistoryDay(days, projection || split >= 1 ? (projection ? 1 : t) : t / split);
  return { day, projection, xPct: t * 100 };
}

export function nearestHistoryDay(days, ratio) {
  const list = Array.isArray(days) ? days.filter(Boolean) : [];
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const t = Math.min(1, Math.max(0, Number(ratio) || 0));
  const start = Date.parse(`${list[0].date}T00:00:00Z`);
  const end = Date.parse(`${list[list.length - 1].date}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    const index = Math.round(t * (list.length - 1));
    return list[index] || list[list.length - 1];
  }
  const targetKey = new Date(start + t * (end - start)).toISOString().slice(0, 10);
  let held = list[0];
  for (const day of list) {
    if (day.date <= targetKey) held = day;
    else break;
  }
  return held;
}

export function addUtcDays(dayKey, delta) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + Number(delta || 0));
  return date.toISOString().slice(0, 10);
}

/** A ledger row becomes a signed wallet movement. Spends stored as positive amounts flip. */
export function movementFromLedger(row = {}) {
  const amount = Number(row.amountPkn);
  if (!Number.isFinite(amount) || amount === 0) return null;
  const type = String(row.type || '');
  const outbound = amount < 0 || type.includes('sent') || type.includes('withdraw');
  const signed = outbound && amount > 0 ? -Math.abs(amount) : amount;
  const date = utcDayKey(row.createdAt || row.at || row.date);
  if (!date) return null;
  return { date, amountPkn: signed };
}

/**
 * Homepage cheapest × quantity. A card with no market price is skipped,
 * so it never contributes a number.
 */
export function marketValueFromHoldings(items, prices) {
  let total = 0;
  let copies = 0;
  for (const item of items || []) {
    const id = String(item?.cardId || item?.card_id || '').trim();
    const qty = Math.max(0, Math.trunc(Number(item?.quantity) || 0));
    const price = Number(prices?.[id]);
    if (!/^\d+$/.test(id) || qty < 1 || !(price > 0)) continue;
    total += qty * price;
    copies += qty;
  }
  if (!copies) return null;
  return { cardsValuePkn: Math.round(total * 100) / 100, copies };
}

/**
 * Wallet on the days it changed, a zero the day before the first movement,
 * and today's homepage market only on today. Asks and unpriced cards stay out.
 */
export function buildCollectionHistory({
  movements = [],
  balance = 0,
  marketCardsPkn = null,
  today = new Date(),
} = {}) {
  const todayKey = utcDayKey(today);
  if (!todayKey) return [];
  const events = (movements || [])
    .map((row) => (row?.amountPkn != null && row?.date && !row.type ? row : movementFromLedger(row)))
    .filter((row) => row?.date && row.date <= todayKey && Number.isFinite(row.amountPkn) && row.amountPkn !== 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const byDay = new Map();
  let running = 0;
  for (const event of events) {
    running += event.amountPkn;
    byDay.set(event.date, Math.max(0, running));
  }
  const live = Math.max(0, Number(balance) || 0);
  const market = marketCardsPkn == null ? null : Math.max(0, Number(marketCardsPkn) || 0);
  if (!events.length && live === 0 && !(market > 0)) return [];
  const first = [...byDay.keys()].sort()[0] || todayKey;
  const points = [];
  const zeroDate = addUtcDays(first, -1);
  if (zeroDate && zeroDate < first) {
    points.push({ date: zeroDate, currencyPkn: 0 });
  }
  for (const date of [...byDay.keys()].sort()) {
    points.push({ date, currencyPkn: byDay.get(date) });
  }
  let todayPoint = points.find((row) => row.date === todayKey);
  if (!todayPoint) {
    todayPoint = { date: todayKey, currencyPkn: live };
    points.push(todayPoint);
    points.sort((a, b) => a.date.localeCompare(b.date));
  } else {
    todayPoint.currencyPkn = live;
  }
  if (market > 0) {
    todayPoint.cardsValuePkn = market;
    todayPoint.cardsKnown = true;
  }
  return points.map((row) => normalizeHistoryDay(row)).filter(Boolean);
}

export function formatHistoryTip(day, { projection = false } = {}) {
  if (!day) return null;
  const assets = day.assets || {};
  const rows = [
    { label: 'Currency', value: `${formatPknNumber(assets.currencyPkn)} PKN` },
  ];
  if (assets.cardsValuePkn != null) {
    rows.push({ label: 'Cards', value: `${formatPknNumber(assets.cardsValuePkn)} PKN` });
  }
  if (projection) rows.push({ label: 'Projection', value: 'Rest of today' });
  return {
    dateLabel: formatDayLabel(day.date),
    totalLabel: `${formatPknNumber(day.totalPkn)} PKN`,
    rows,
  };
}

/** Collectr-style windows. Longer ones appear only when history reaches that far. */
export const HISTORY_PRESETS = [
  { id: '1M', label: '1M', days: 30, phrase: 'in the last month' },
  { id: '3M', label: '3M', days: 91, phrase: 'in the last 3 months' },
  { id: '6M', label: '6M', days: 182, phrase: 'in the last 6 months' },
  { id: '1Y', label: '1Y', days: 365, phrase: 'in the last year' },
  { id: '2Y', label: '2Y', days: 730, phrase: 'in the last 2 years' },
  { id: 'MAX', label: 'MAX', days: null, phrase: 'all time' },
];

export const DEFAULT_HISTORY_PRESET = '1M';

export function historyPresetWindow(presetId, today = new Date()) {
  const todayKey = utcDayKey(today);
  const preset = HISTORY_PRESETS.find((row) => row.id === presetId) || HISTORY_PRESETS[0];
  if (preset.days == null) return { from: '', to: todayKey, preset: preset.id };
  return { from: addUtcDays(todayKey, -preset.days), to: todayKey, preset: preset.id };
}

/** 1M and MAX always. 1Y and 2Y only when the first stored day is at least that old. */
export function availableHistoryPresets(series, today = new Date()) {
  const days = withLiveHistoryDay(series, null);
  if (!days.length) return [];
  const earliest = days[0].date;
  const todayKey = utcDayKey(today);
  return HISTORY_PRESETS.filter((preset) => {
    if (preset.id === '1M' || preset.id === 'MAX') return true;
    return earliest <= addUtcDays(todayKey, -preset.days);
  });
}

/**
 * Points inside [from, to]. The value at the window edges is the last real
 * observation, so a quiet month still draws instead of going blank.
 */
export function sliceHistorySeries(series, { from = '', to = '' } = {}) {
  const days = withLiveHistoryDay(series, null);
  if (!days.length) return [];
  let start = from || days[0].date;
  let end = to || days[days.length - 1].date;
  if (start && end && start > end) {
    const swap = start;
    start = end;
    end = swap;
  }
  const inside = days.filter((day) => day.date >= start && day.date <= end);
  const prior = [...days].reverse().find((day) => day.date < start);
  const points = [];
  if (prior && start && (!inside.length || inside[0].date !== start)) {
    points.push({ ...prior, date: start, carried: true });
  }
  points.push(...inside);
  if (points.length && end && points[points.length - 1].date < end) {
    points.push({ ...points[points.length - 1], date: end, carried: true });
  }
  return points;
}

/**
 * Axis hugs the visible values. A wallet line under a priced pile does not
 * stretch the scale back to zero — that hides the dump's day-to-day move.
 * A series that actually starts near zero still includes zero.
 */
export function historyAxis(points) {
  const rows = points || [];
  const totals = rows.map((day) => asNonNeg(day?.totalPkn));
  if (!totals.length) {
    const yMax = niceScaleMax(0);
    return { yMin: 0, yMax, ticks: yTickValues(yMax, 4) };
  }
  const cardTotals = rows
    .filter((day) => day?.assets?.cardsKnown)
    .map((day) => asNonNeg(day?.totalPkn));
  const floor = Math.max(0, ...totals.filter((_, index) => !rows[index]?.assets?.cardsKnown), 0);
  const cardMin = cardTotals.length ? Math.min(...cardTotals) : 0;
  const cardMax = cardTotals.length ? Math.max(...cardTotals) : 0;
  const piled = cardTotals.length > 0
    && cardMax > cardMin
    && cardMin > Math.max(floor, 1) * 20
    && (cardMax - cardMin) < cardMin * 0.25;
  const values = piled ? cardTotals : totals;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!piled) {
    const span = Math.max(max - min, max * 0.08, 1);
    const yMax = niceScaleMax(max + span * 0.16);
    const rawMin = Math.max(0, min - span * 0.22);
    const step = yMax / 4;
    const yMin = rawMin <= 0 || min === 0 ? 0 : Math.max(0, Math.floor(rawMin / step) * step);
    const ticks = [];
    for (let i = 0; i <= 4; i += 1) {
      ticks.push(Math.round(yMin + ((yMax - yMin) * i) / 4));
    }
    return { yMin, yMax: Math.max(yMax, yMin + 1), ticks, zoomed: false };
  }
  const pad = Math.max((max - min) * 0.45, max * 0.008, 1);
  const yMin = Math.max(0, min - pad);
  const yMax = max + pad;
  const rough = Math.max((yMax - yMin) / 4, 1);
  const exp = Math.floor(Math.log10(rough));
  const base = 10 ** Math.max(exp, 0);
  const fraction = rough / base;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  const step = nice * base;
  const ticks = [];
  for (let value = Math.ceil(yMin / step) * step; value <= yMax + step * 0.01; value += step) {
    ticks.push(Math.round(value));
  }
  if (ticks.length < 2) ticks.push(Math.round(yMin), Math.round(yMax));
  return { yMin, yMax, ticks, zoomed: true };
}

export function historyWindowChange(points, presetId = 'custom') {
  if (!points?.length) return null;
  const first = asNonNeg(points[0].totalPkn);
  const last = asNonNeg(points[points.length - 1].totalPkn);
  const delta = Math.round((last - first) * 100) / 100;
  // A window that starts before any card was priced is not a return on the wallet.
  const gainedCards = points[0]?.assets?.cardsKnown !== true
    && points.some((day) => day?.assets?.cardsKnown === true);
  const pct = first > 0 && !gainedCards ? ((last - first) / first) * 100 : null;
  const preset = HISTORY_PRESETS.find((row) => row.id === presetId);
  return {
    last,
    delta,
    pct: pct == null || !Number.isFinite(pct) ? null : pct,
    phrase: preset?.phrase || 'in this period',
  };
}

export function formatHistoryDelta(change) {
  if (!change) return '';
  const body = `${formatPknNumber(Math.abs(change.delta))} PKN`;
  const signed = change.delta > 0 ? `+${body}` : (change.delta < 0 ? `-${body}` : body);
  if (change.pct == null) return `${signed} ${change.phrase}`;
  const pctAbs = Math.abs(Math.round(change.pct * 10) / 10);
  const pctText = formatPknNumber(pctAbs, { maximumFractionDigits: 1 });
  const pctSigned = change.pct > 0 ? `+${pctText}%` : (change.pct < 0 ? `-${pctText}%` : `${pctText}%`);
  return `${signed} (${pctSigned}) ${change.phrase}`;
}

/** Hold the last value, then jump vertically on the day it changes. */
export function stepHistoryPoints(coords) {
  if (!coords?.length) return [];
  const out = [{ x: coords[0].x, y: coords[0].y }];
  for (let i = 1; i < coords.length; i += 1) {
    out.push({ x: coords[i].x, y: coords[i - 1].y });
    out.push({ x: coords[i].x, y: coords[i].y });
  }
  return out;
}

export function formatHistoryAxisLabel(dayKey, withYear = false) {
  const label = formatDayLabel(dayKey);
  if (!withYear || !label) return label;
  return `${label} ${String(dayKey || '').slice(0, 4)}`;
}
