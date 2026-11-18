/**
 * Collection value history for the Dashboard chart.
 *
 * The API stores one point per UTC day: wallet PKN (liquidity) plus the
 * seller's cards marked at each printing slice's last sold median, carried
 * forward on days without a sale (pokoin-rust/crates/accounts/src/domain/portfolio_history.rs).
 * This module slices that series into a window and lays the window out on a
 * day scale that ends today.
 */

import { formatPknNumber } from './pkn.js';

const DAY_MS = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function nonNeg(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

export function utcDayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export function addUtcDays(dayKey, delta) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + Number(delta || 0));
  return date.toISOString().slice(0, 10);
}

/** Whole days from one day key to another (negative when to is earlier). */
export function daySpan(from, to) {
  const start = Date.parse(`${from || ''}T00:00:00Z`);
  const end = Date.parse(`${to || ''}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.round((end - start) / DAY_MS);
}

export function formatDayLabel(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!m) return '';
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

export function formatHistoryAxisLabel(dayKey, withYear = false) {
  const label = formatDayLabel(dayKey);
  if (!withYear || !label) return label;
  return `${label} ${String(dayKey || '').slice(0, 4)}`;
}

/**
 * One day of portfolio value. Cards are null before any stock was held; a
 * held pile with no sold price yet is 0, never an ask. Idempotent, so an
 * already-normalized row keeps its assets.
 */
export function normalizeHistoryDay(row = {}) {
  const prior = row && typeof row.assets === 'object' && row.assets ? row.assets : null;
  const date = utcDayKey(row?.date || row?.day || new Date());
  if (!date) return null;
  const currencyPkn = round2(nonNeg(row.currencyPkn ?? row.currency ?? prior?.currencyPkn));
  const rawCards = row.cardsValuePkn !== undefined ? row.cardsValuePkn : prior?.cardsValuePkn;
  const known = (row.cardsKnown ?? prior?.cardsKnown) === true;
  const cardsValuePkn = known && rawCards != null && rawCards !== '' ? round2(nonNeg(rawCards)) : null;
  const cardsHeld = cardsValuePkn == null ? 0 : Math.trunc(nonNeg(row.cardsHeld ?? prior?.cardsHeld));
  const pricedRaw = Math.trunc(nonNeg(row.cardsPriced ?? prior?.cardsPriced));
  const move = Number(row.cardsMove ?? prior?.cardsMove);
  return {
    date,
    totalPkn: round2(currencyPkn + (cardsValuePkn || 0)),
    assets: {
      currencyPkn,
      cardsValuePkn,
      cardsKnown: cardsValuePkn != null,
      cardsHeld,
      cardsPriced: cardsValuePkn == null ? 0 : (cardsHeld ? Math.min(cardsHeld, pricedRaw) : pricedRaw),
      cardsMove: cardsValuePkn != null && (row.cardsMove ?? prior?.cardsMove) != null && Number.isFinite(move)
        ? move
        : null,
    },
  };
}

function normalizedSeries(series) {
  return (Array.isArray(series) ? series : [])
    .map((row) => normalizeHistoryDay(row))
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Today's live numbers win that date, so the chart ends on the wallet and the
 * 1-DR value the dashboard shows above it. cards is { valuePkn, pricedCards,
 * cards } from /api/cardtrader-assets; leave it undefined when unknown.
 */
export function withLiveToday(series, { currencyPkn, cards } = {}, today = new Date()) {
  const days = normalizedSeries(series);
  const todayKey = utcDayKey(today);
  const hasCurrency = currencyPkn != null && Number.isFinite(Number(currencyPkn));
  if (!todayKey || (!hasCurrency && cards === undefined)) return days;
  const held = cards && Number(cards.cards) > 0;
  if (!days.length && !(nonNeg(currencyPkn) > 0) && !held) return days;
  const base = days.find((day) => day.date === todayKey)
    || [...days].reverse().find((day) => day.date < todayKey)
    || normalizeHistoryDay({ date: todayKey });
  const assets = { ...base.assets };
  if (hasCurrency) assets.currencyPkn = nonNeg(currencyPkn);
  if (cards !== undefined) {
    assets.cardsKnown = Boolean(held);
    assets.cardsValuePkn = held ? nonNeg(cards.valuePkn) : null;
    assets.cardsHeld = held ? Math.trunc(nonNeg(cards.cards)) : 0;
    assets.cardsPriced = held ? Math.trunc(nonNeg(cards.pricedCards)) : 0;
  }
  if (base.date !== todayKey) assets.cardsMove = null;
  const point = normalizeHistoryDay({ date: todayKey, ...assets });
  return [...days.filter((day) => day.date !== todayKey), point]
    .sort((a, b) => a.date.localeCompare(b.date));
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

/** Actual observations from today and the preceding 29 UTC days. */
export function previewHistoryMonth(series, today = new Date()) {
  const end = utcDayKey(today);
  if (!end) return [];
  const start = addUtcDays(end, -29);
  return (Array.isArray(series) ? series : []).filter((day) => day?.date >= start && day.date <= end);
}

/** 1M and MAX always; a longer window only when the first stored day is that old. */
export function availableHistoryPresets(series, today = new Date()) {
  const days = normalizedSeries(series);
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
  const days = normalizedSeries(series);
  if (!days.length) return [];
  let start = from || days[0].date;
  let end = to || days[days.length - 1].date;
  if (start > end) [start, end] = [end, start];
  const inside = days.filter((day) => day.date >= start && day.date <= end);
  const prior = [...days].reverse().find((day) => day.date < start);
  const points = [];
  if (prior && (!inside.length || inside[0].date !== start)) {
    points.push({ ...prior, date: start, carried: true });
  }
  points.push(...inside);
  if (points.length && points[points.length - 1].date < end) {
    points.push({ ...points[points.length - 1], date: end, carried: true });
  }
  return points;
}

export function historyWindowChange(points, presetId = 'custom') {
  if (!points?.length) return null;
  const first = nonNeg(points[0].totalPkn);
  const last = nonNeg(points[points.length - 1].totalPkn);
  const delta = round2(last - first);
  // Cards that arrived inside the window are not a return on what was there.
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

/**
 * Day scale of the chart: the realized window end to end across the plot, so
 * the last day of a window that ends today sits on the right edge.
 */
export function historyTimeline(points, today = new Date()) {
  const to = points?.[points.length - 1]?.date || '';
  let from = points?.[0]?.date || '';
  if (!from || !to) return null;
  if (daySpan(from, to) < 1) from = addUtcDays(to, -1);
  return {
    from,
    to,
    span: daySpan(from, to),
    live: to === utcDayKey(today),
  };
}

/** 0..1 across the plot. */
export function timelineRatio(timeline, date) {
  if (!timeline?.span) return 0;
  return Math.min(1, Math.max(0, daySpan(timeline.from, date) / timeline.span));
}

/** Day under a 0..1 pointer ratio. */
export function timelineDay(timeline, ratio) {
  if (!timeline) return '';
  const t = Math.min(1, Math.max(0, Number(ratio) || 0));
  return addUtcDays(timeline.from, Math.round(t * timeline.span));
}

/** The value in force on a day: the last point on or before it. */
export function historyDayAt(points, dayKey) {
  let held = null;
  for (const day of points || []) {
    if (day.date <= dayKey) held = day;
    else break;
  }
  return held || points?.[0] || null;
}

const TICK_DAY_STEPS = [1, 2, 7, 14];
const TICK_MONTH_STEPS = [1, 2, 3, 6, 12];

function monthTicks(from, end, months) {
  const ticks = [];
  const [y, m] = from.split('-').map(Number);
  let year = y;
  let month = m - 1;
  for (let guard = 0; guard < 400; guard += 1) {
    if (month % months === 0) {
      const day = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      if (day > end) break;
      if (day >= from) ticks.push(day);
    }
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return ticks;
}

/**
 * Round-date ticks across the day scale: days, Mondays, then month starts.
 * Ticks crowding an edge are dropped, so the first day and the Today (or end
 * day) label keep their room.
 */
export function historyDateTicks(timeline, maxTicks = 7) {
  if (!timeline?.span) return [];
  const { from, to, span } = timeline;
  let dates = [];
  const dayStep = TICK_DAY_STEPS.find((step) => span / step <= maxTicks);
  if (dayStep) {
    const epoch = '1970-01-05'; // a Monday
    for (let day = from; day <= to; day = addUtcDays(day, 1)) {
      const offset = daySpan(epoch, day);
      if (((offset % dayStep) + dayStep) % dayStep === 0) dates.push(day);
    }
  } else {
    const months = TICK_MONTH_STEPS.find((step) => span / (step * 30.44) <= maxTicks) || 12;
    dates = monthTicks(from, to, months);
  }
  const withYear = from.slice(0, 4) !== to.slice(0, 4);
  return dates
    .map((date) => ({ date, ratio: timelineRatio(timeline, date) }))
    .filter((tick) => tick.ratio > 0.04 && tick.ratio < (timeline.live ? 0.92 : 0.96))
    .map((tick, index) => ({
      ...tick,
      label: formatHistoryAxisLabel(tick.date, withYear && tick.date.slice(5, 7) === '01'),
      // Every other tick steps aside on a phone.
      minor: index % 2 === 1,
    }));
}

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const base = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / base;
  const nice = [1, 2, 2.5, 5, 10].find((step) => fraction <= step) || 10;
  return nice * base;
}

/**
 * Y scale in the Wealthfolio manner: a window whose values span a fifth or
 * more of their top starts at zero with headroom; a steadier window hugs its
 * range so a few percent still shows. Ticks are round numbers.
 */
export function historyAxis(values) {
  const list = (values || []).map(Number).filter((value) => Number.isFinite(value) && value >= 0);
  const max = list.length ? Math.max(...list) : 0;
  const min = list.length ? Math.min(...list) : 0;
  if (!(max > 0)) return { yMin: 0, yMax: 20, ticks: [0, 5, 10, 15, 20], zeroBased: true };
  const zeroBased = (max - min) / max >= 0.2;
  let lo = 0;
  let hi = max * 1.06;
  if (!zeroBased) {
    const pad = Math.max((max - min) * 0.35, max * 0.02);
    lo = Math.max(0, min - pad);
    hi = max + pad;
  }
  let best = null;
  for (const intervals of [4, 5]) {
    const step = niceStep((hi - lo) / intervals);
    const yMin = zeroBased ? 0 : Math.floor(lo / step) * step;
    const yMax = Math.max(yMin + step, Math.ceil(hi / step) * step);
    if (!best || yMax - yMin < best.yMax - best.yMin) best = { step, yMin, yMax };
  }
  const ticks = [];
  for (let value = best.yMin; value <= best.yMax + best.step / 2; value += best.step) {
    ticks.push(Math.round(value * 100) / 100);
  }
  return { yMin: best.yMin, yMax: best.yMax, ticks, zeroBased: best.yMin === 0 };
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

export const HISTORY_LAYERS = [
  { key: 'liquidity', label: 'Liquidity' },
  { key: 'cards', label: 'Cards' },
];

function pricedNote(assets) {
  if (!assets?.cardsHeld) return '';
  return `${assets.cardsPriced.toLocaleString('en-US')} of ${assets.cardsHeld.toLocaleString('en-US')} with a sale`;
}

/** Tip for a realized day: total first, then every layer at that day. */
export function formatHistoryTip(day) {
  if (!day) return null;
  const assets = day.assets || {};
  const rows = [];
  if (assets.cardsValuePkn != null) {
    rows.push({
      key: 'cards',
      label: 'Cards',
      value: `${formatPknNumber(assets.cardsValuePkn)} PKN`,
      note: pricedNote(assets),
    });
  }
  rows.push({ key: 'liquidity', label: 'Liquidity', value: `${formatPknNumber(assets.currencyPkn)} PKN` });
  return {
    dateLabel: formatDayLabel(day.date),
    totalLabel: `${formatPknNumber(day.totalPkn)} PKN`,
    rows,
  };
}
