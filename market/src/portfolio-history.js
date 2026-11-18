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

/** The same days as one stepped stroke: the true day the value changed. */
export function stepHistoryPath(coords) {
  const stepped = stepHistoryPoints(coords);
  if (!stepped.length) return '';
  return [`M ${historyPoint(stepped[0])}`, ...stepped.slice(1).map((point) => `L ${historyPoint(point)}`)].join(' ');
}

/**
 * The points a curve can be built from: finite x and y, and x still moving
 * the way the series started. A day that repeats or steps back has no width
 * and is dropped, so no segment ever divides by zero.
 */
function usableHistoryCoords(coords) {
  const finite = [];
  for (const point of coords || []) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (Number.isFinite(x) && Number.isFinite(y)) finite.push({ x, y });
  }
  let direction = 0;
  for (let i = 1; i < finite.length && direction === 0; i += 1) {
    direction = Math.sign(finite[i].x - finite[i - 1].x);
  }
  if (!direction) return finite.slice(0, 1);
  const out = [];
  for (const point of finite) {
    const previous = out[out.length - 1];
    if (previous && Math.sign(point.x - previous.x) !== direction) continue;
    out.push(point);
  }
  return out;
}

function historySlope(from, to) {
  return (to.y - from.y) / (to.x - from.x);
}

function slopeSign(slope) {
  return slope > 0 ? 1 : (slope < 0 ? -1 : 0);
}

/**
 * Tangent at a point between two runs, held inside the monotone-X rules: it
 * vanishes at a turning point and never exceeds the shallower neighbouring
 * slope, which is what keeps every curve between the values it joins.
 */
function historyTangent(left, right) {
  if (slopeSign(left.slope) !== slopeSign(right.slope)) return 0;
  const chord = (left.slope * right.width + right.slope * left.width) / (left.width + right.width);
  return slopeSign(left.slope)
    * Math.min(Math.abs(left.slope), Math.abs(right.slope), Math.abs(chord) / 2);
}

/**
 * Cubic Bezier segments of a monotone-X (Fritsch-Carlson) interpolation
 * through `coords`, as {x0, y0, cx1, cy1, cx2, cy2, x1, y1}. The curve passes
 * through every point, and both control points of a segment sit inside that
 * segment's x and y box, so a smooth run never rises above or dips below the
 * two real values it joins. A flat run stays flat, fewer than two usable
 * points give no segments, and the result is unchanged by reading `coords`
 * backwards, so a reversed edge is the same curve.
 */
export function smoothHistorySegments(coords) {
  const points = usableHistoryCoords(coords);
  if (points.length < 2) return [];
  const runs = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    runs.push({ width: points[i + 1].x - points[i].x, slope: historySlope(points[i], points[i + 1]) });
  }
  const tangents = [
    runs[0].slope,
    ...runs.slice(1).map((right, i) => historyTangent(runs[i], right)),
    runs[runs.length - 1].slope,
  ];
  return runs.map((run, i) => ({
    x0: points[i].x,
    y0: points[i].y,
    cx1: points[i].x + run.width / 3,
    cy1: points[i].y + (tangents[i] * run.width) / 3,
    cx2: points[i + 1].x - run.width / 3,
    cy2: points[i + 1].y - (tangents[i + 1] * run.width) / 3,
    x1: points[i + 1].x,
    y1: points[i + 1].y,
  }));
}

function historyNumber(value) {
  return value.toFixed(2);
}

function historyPoint(point) {
  return `${historyNumber(point.x)} ${historyNumber(point.y)}`;
}

/** The curve commands of segments; the pen must already sit on the first one. */
function historyCurve(segments) {
  return segments.map((s) => [
    `C ${historyPoint({ x: s.cx1, y: s.cy1 })}`,
    historyPoint({ x: s.cx2, y: s.cy2 }),
    historyPoint({ x: s.x1, y: s.y1 }),
  ].join(', ')).join(' ');
}

/** Move to the first point, then one smooth curve through all of them. */
export function smoothHistoryPath(coords) {
  const points = usableHistoryCoords(coords);
  if (!points.length) return '';
  return [`M ${historyPoint(points[0])}`, historyCurve(smoothHistorySegments(points))].filter(Boolean).join(' ');
}

/**
 * The curve's own point at an x. Both control points of a segment sit a third
 * and two thirds of the way across it, which makes x linear in the segment
 * parameter, so solving t from x is exact and never needs a length measure.
 * Outside the drawn range it lands on the end it passed.
 */
export function smoothHistoryPointAt(coords, x) {
  const points = usableHistoryCoords(coords);
  if (!points.length) return null;
  const last = points[points.length - 1];
  const at = Math.min(Math.max(Number(x) || 0, points[0].x), last.x);
  if (at <= points[0].x) return { x: at, y: points[0].y };
  const segments = smoothHistorySegments(points);
  const segment = segments.find((row) => at <= row.x1) || segments[segments.length - 1];
  const t = (at - segment.x0) / (segment.x1 - segment.x0);
  const u = 1 - t;
  return {
    x: at,
    y: (u ** 3) * segment.y0
      + 3 * (u ** 2) * t * segment.cy1
      + 3 * u * (t ** 2) * segment.cy2
      + (t ** 3) * segment.y1,
  };
}

/**
 * Closed shape between two smooth curves that share their x: out along
 * `upper`, a vertical step at the last x, back along `lower`, closed with a
 * vertical step at the first. Reading `lower` backwards draws the same curve,
 * so two shapes that share an edge meet it exactly instead of gapping.
 */
export function smoothHistoryBandPath(upper, lower) {
  const top = usableHistoryCoords(upper);
  const bottom = usableHistoryCoords(lower);
  if (top.length < 2 || bottom.length < 2) return '';
  return [
    `M ${historyPoint(top[0])}`,
    historyCurve(smoothHistorySegments(top)),
    `L ${historyPoint(bottom[bottom.length - 1])}`,
    historyCurve(smoothHistorySegments([...bottom].reverse())),
    'Z',
  ].filter(Boolean).join(' ');
}

/**
 * The entry the dashboard graph plays on first paint and on every range
 * change: the curve reveals left to right over this many milliseconds.
 */
export const HISTORY_DRAW_MS = 900;

/** The headline starts the draw at this share of its own value. */
export const HISTORY_COUNT_FROM = 0.85;

/**
 * Ease-out-quart of the draw-in reveal: 0 at the start, 1 at and past
 * `durationMs`, clamped either side so a stray frame never overdraws.
 */
export function historyDrawProgress(elapsedMs, durationMs) {
  const elapsed = Number(elapsedMs);
  const total = Number(durationMs);
  if (!(total > 0)) return 1;
  if (!(elapsed > 0)) return 0;
  if (elapsed >= total) return 1;
  const t = elapsed / total;
  return 1 - (1 - t) ** 4;
}

/** The headline number at a draw progress: 85% of `value` up to `value`. */
export function historyCountValue(value, progress) {
  const target = Number(value);
  if (!Number.isFinite(target)) return 0;
  const t = Math.min(1, Math.max(0, Number(progress) || 0));
  return round2(target * (HISTORY_COUNT_FROM + (1 - HISTORY_COUNT_FROM) * t));
}

/**
 * Where the one-line hover label anchors, in plot pixels: centred on the day
 * and `gap` above it, then pushed back inside the plot so a label at either
 * edge, or over the top of a high value, stays whole. The panel pairs the
 * result with translate(-50%, -100%), so `left`/`top` are that anchor.
 */
export function historyLabelAnchor({
  x = 0,
  y = 0,
  plotWidth = 0,
  plotHeight = 0,
  labelWidth = 0,
  labelHeight = 0,
  gap = 14,
  pad = 6,
} = {}) {
  const width = Math.max(0, Number(labelWidth) || 0);
  const height = Math.max(0, Number(labelHeight) || 0);
  const plot = Math.max(0, Number(plotWidth) || 0);
  const frame = Math.max(0, Number(plotHeight) || 0);
  const half = width / 2;
  const leftLo = pad + half;
  const leftHi = plot - pad - half;
  const left = leftHi < leftLo ? plot / 2 : Math.min(Math.max(Number(x) || 0, leftLo), leftHi);
  const topLo = pad + height;
  const topHi = frame - pad;
  const top = topLo > topHi ? topHi : Math.min(Math.max((Number(y) || 0) - gap, topLo), topHi);
  return { left, top };
}

/**
 * The liquidity sub-pane scales on its own: the window's peak fills the band,
 * so a small wallet in a large portfolio is still a readable line instead of a
 * flat piece of the baseline.
 */
export function liquidityBandRatio(value, peak) {
  const top = Number(peak);
  if (!(top > 0)) return 0;
  const amount = Number(value);
  if (!(amount > 0)) return 0;
  return Math.min(1, amount / top);
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
