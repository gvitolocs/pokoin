import { offerPriceLabel } from './buy-orders.js';
import { langMeta } from './locale.js';
import { formatPkn } from './pkn.js';

/** Geometry for the card-desk sold-median chart. */

export const SOLD_GRAPH_CLICK_PX = 12;

export function isSoldGraphClick(start, point) {
  if (!start || point == null) {
    return false;
  }
  const x = Number(point.clientX ?? point.x);
  const y = Number(point.clientY ?? point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return false;
  }
  const dx = x - Number(start.x);
  const dy = y - Number(start.y);
  return (dx * dx + dy * dy) <= SOLD_GRAPH_CLICK_PX * SOLD_GRAPH_CLICK_PX;
}

export function nearestSoldIndex(xs, x) {
  let best = 0;
  let dist = Infinity;
  for (let i = 0; i < xs.length; i += 1) {
    const d = Math.abs(xs[i] - x);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  return best;
}

export const SOLD_GRAPH_PAD = { l: 44, r: 40, t: 68, b: 22 };

export const SOLD_CONDITION_LABELS = {
  NM: 'Near Mint',
  SP: 'Slightly Played',
  MP: 'Moderately Played',
  PL: 'Played',
  Poor: 'Poor',
};

export function soldConditionLabel(code) {
  if (!code) {
    return 'All';
  }
  return SOLD_CONDITION_LABELS[code] || code;
}

/**
 * Line colours for the desk graph when several series are compared. One palette
 * per language, in the order the languages were picked: the first keeps the
 * grade colours (the same greens, gold, copper and red as the single graph),
 * and every colour of the first three palettes is different from every other,
 * so a language is never read as a grade. A fourth language reuses the second
 * palette, a fifth the third, and so on.
 */
export const SOLD_SERIES_PALETTES = [
  { NM: '#147a3f', SP: '#3dcf74', MP: '#ffd33d', PL: '#b87333', Poor: '#e44545' },
  { NM: '#5fb8e8', SP: '#38d6c4', MP: '#e45fd0', PL: '#a78bfa', Poor: '#ff8fb1' },
  { NM: '#ff9f43', SP: '#f4f4f5', MP: '#2563eb', PL: '#84cc16', Poor: '#9ca3af' },
];

export function soldSeriesColor(condition, languageIndex = 0) {
  const index = Math.max(0, Math.trunc(Number(languageIndex) || 0));
  const palette = index < SOLD_SERIES_PALETTES.length
    ? SOLD_SERIES_PALETTES[index]
    : SOLD_SERIES_PALETTES[1 + ((index - 1) % (SOLD_SERIES_PALETTES.length - 1))];
  return palette[String(condition || '').trim()] || '#f3f4f7';
}

/** Line/fill tone for the desk graph. All stays white; MP keeps gold. */
export function soldGraphTone(condition) {
  const key = String(condition || '').trim();
  if (key === 'NM') {
    return 'nm';
  }
  if (key === 'SP') {
    return 'sp';
  }
  if (key === 'MP') {
    return 'mp';
  }
  if (key === 'PL') {
    return 'pl';
  }
  if (key === 'Poor') {
    return 'poor';
  }
  return 'all';
}

export function soldLanguageLabel(code) {
  if (!code) {
    return 'All';
  }
  const meta = langMeta(String(code).toLowerCase());
  if (meta && meta.code === String(code).toLowerCase()) {
    return meta.label;
  }
  return String(code);
}

export function soldFlagLabel(kind, value) {
  if (value === '' || value == null) {
    return 'All';
  }
  const on = value === true || value === '1' || value === 'true';
  if (kind === 'reverse') {
    return on ? 'Rev' : 'Std';
  }
  if (kind === 'firstEdition') {
    return on ? '1st' : 'Unl';
  }
  if (kind === 'graded') {
    return on ? 'Grd' : 'Raw';
  }
  return String(value);
}

export function soldFlagQueryValue(flag) {
  return flag ? '1' : '0';
}

/** One key → that key; several keys → keep All (`selected`) when it is still valid. */
export function soldFilterValue(options, selected, encode = (value) => value) {
  if (!Array.isArray(options) || !options.length) {
    return selected;
  }
  if (options.length === 1) {
    return encode(options[0]);
  }
  if (selected === '' || selected == null) {
    return selected;
  }
  const want = String(selected);
  const encoded = options.map((row) => String(encode(row)));
  if (encoded.includes(want) || options.includes(selected)) {
    return selected;
  }
  return '';
}

export function soldFilterShowsAll(options) {
  return Array.isArray(options) && options.length > 1;
}

export function soldGraphTipMods(x, y, width, pad) {
  const mods = [];
  if (y < pad.t + 28) {
    mods.push('is-below');
  }
  if (x >= width - pad.r - 12) {
    mods.push('is-end');
  } else if (x <= pad.l + 12) {
    mods.push('is-start');
  }
  return mods;
}

export function activeSoldIndex(hover, dayCount) {
  if (!dayCount) {
    return null;
  }
  if (hover == null || hover < 0 || hover >= dayCount) {
    return null;
  }
  return hover;
}

/**
 * Five steps from zero, sized to the data: the smallest 1–2–2.5–5 step (times a
 * power of ten, never under 10) whose fifth tick reaches the highest value. The
 * line always uses at least half the plot's height, so 7,000 PKN reads on a
 * 0–10,000 axis rather than lying flat on a 0–50k one.
 */
export function soldGraphScale(maxValue, { minStep = 10 } = {}) {
  const max = Math.max(0, Number(maxValue) || 0);
  // `minStep` is the smallest step the axis may use: 10 for PKN, and a cent
  // (0.01) when the axis is drawn in the visitor's currency, where a card that
  // sold for a quarter must not sit on a 0–50 axis.
  const floor = Number(minStep) > 0 ? Number(minStep) : 10;
  let step = floor;
  for (let mag = floor; step * 5 < max; mag *= 10) {
    for (const lead of [1, 2, 2.5, 5]) {
      step = lead * mag;
      if (step * 5 >= max) break;
    }
  }
  // Decimal steps pick up binary noise (0.1 * 3); six decimals is far below a cent.
  const clean = (value) => Number(value.toFixed(6));
  return {
    min: 0,
    max: clean(step * 5),
    step: clean(step),
    ticks: [0, 1, 2, 3, 4, 5].map((n) => clean(n * step)),
  };
}

export function soldGraphY(value, top, padT, plotH) {
  const v = Math.max(0, Number(value) || 0);
  const ceiling = Number(top) > 0 ? Number(top) : 1;
  return padT + (1 - Math.min(v, ceiling) / ceiling) * plotH;
}

export function formatSoldAxisTick(value) {
  const n = Number(value) || 0;
  if (n >= 10000 && n % 1000 === 0) {
    return `${n / 1000}k`;
  }
  // A local-currency axis has ticks under one unit: 0.05, 0.25, 1.5.
  if (!Number.isInteger(n)) {
    return String(Number(n.toFixed(3)));
  }
  return String(n);
}

export function soldDateLocale() {
  if (typeof navigator === 'undefined') {
    return undefined;
  }
  return navigator.languages?.[0] || navigator.language || undefined;
}

/** Calendar day `YYYY-MM-DD` as the viewer's short date (EU 06/09, US 09/06). */
export function formatSoldDay(isoDay, locale) {
  const match = String(isoDay || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    return '';
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

export function soldUnitCount(days) {
  return (Array.isArray(days) ? days : []).reduce((sum, row) => {
    const n = Number(row?.soldQty ?? row?.sold_qty ?? row?.sampleCount ?? row?.listings);
    return sum + (Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);
  }, 0);
}

export function formatSoldSampleCount(count) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'unit' : 'units'}`;
}

const DAY_MS = 86_400_000;

/** A `YYYY-MM-DD` calendar day as UTC midnight ms; NaN when it is not a day. */
export function soldGraphDayMs(day) {
  const match = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    return NaN;
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * The window a range button asked for, or `null` when the graph was not given
 * one: without a range every series day is drawn, as it always was.
 */
export function soldGraphRangeBounds(range) {
  const from = String(range?.from || '');
  const to = String(range?.to || '');
  if (!Number.isFinite(soldGraphDayMs(from)) || !Number.isFinite(soldGraphDayMs(to))) {
    return null;
  }
  return { key: String(range?.key || ''), from, to };
}

/** Series days inside the selected range, oldest first. */
export function soldGraphRangeDays(days, bounds) {
  const rows = (Array.isArray(days) ? days : []).filter((row) => Number.isFinite(soldGraphDayMs(row?.day)));
  if (!bounds) {
    return rows;
  }
  const lo = soldGraphDayMs(bounds.from);
  const hi = soldGraphDayMs(bounds.to);
  return rows
    .filter((row) => {
      const ms = soldGraphDayMs(row.day);
      return ms >= lo && ms <= hi;
    })
    .sort((a, b) => soldGraphDayMs(a.day) - soldGraphDayMs(b.day));
}

/**
 * The dates the x-axis spans: the selected range clipped to the first and last
 * day the visible series actually have, so a 1-month window with two weeks of
 * data does not leave half the plot empty.
 */
export function soldGraphDateWindow(days, bounds) {
  const points = (Array.isArray(days) ? days : [])
    .map((row) => soldGraphDayMs(row?.day))
    .filter((ms) => Number.isFinite(ms));
  if (!points.length) {
    return null;
  }
  let start = Math.min(...points);
  let end = Math.max(...points);
  const lo = soldGraphDayMs(bounds?.from);
  const hi = soldGraphDayMs(bounds?.to);
  if (Number.isFinite(lo)) {
    start = Math.max(start, lo);
  }
  if (Number.isFinite(hi)) {
    end = Math.min(end, hi);
  }
  return { start, end: Math.max(start, end) };
}

/**
 * A source line split into the runs the graph draws solid, plus the pairs that
 * bridge each hole. Two days more than `gapDays` apart are not a price move:
 * that stretch is quoted from the source's own last value, not measured here.
 */
export function soldGraphGapSegments(days, gapDays) {
  const rows = (Array.isArray(days) ? days : []).filter((row) => Number.isFinite(soldGraphDayMs(row?.day)));
  const max = Math.max(0, Math.trunc(Number(gapDays)) || 0);
  const segments = [];
  const bridges = [];
  let run = null;
  for (const row of rows) {
    const prev = run ? run[run.length - 1] : null;
    if (prev && (soldGraphDayMs(row.day) - soldGraphDayMs(prev.day)) / DAY_MS > max) {
      bridges.push([prev, row]);
      run = null;
    }
    if (!run) {
      run = [];
      segments.push(run);
    }
    run.push(row);
  }
  return { segments, bridges };
}

/**
 * The continuation of a source line whose price stopped while the source itself
 * kept answering: its last drawn point carried flat to `lastObservedDay`, as the
 * pair a dotted bridge is drawn from. `bounds` is the range the graph draws, so a
 * day outside it is not reached for. Nothing when the series is empty, when the
 * day is not one, when it is not after the last point, or when it is outside the
 * range.
 */
export function soldGraphTailBridge(days, lastObservedDay, bounds) {
  const tail = soldGraphDayMs(lastObservedDay);
  if (!Number.isFinite(tail)) {
    return null;
  }
  const lo = soldGraphDayMs(bounds?.from);
  const hi = soldGraphDayMs(bounds?.to);
  if ((Number.isFinite(lo) && tail < lo) || (Number.isFinite(hi) && tail > hi)) {
    return null;
  }
  const rows = (Array.isArray(days) ? days : []).filter((row) => Number.isFinite(soldGraphDayMs(row?.day)));
  if (!rows.length) {
    return null;
  }
  const last = rows.reduce((a, b) => (soldGraphDayMs(b.day) > soldGraphDayMs(a.day) ? b : a));
  return tail > soldGraphDayMs(last.day) ? [last, { ...last, day: String(lastObservedDay) }] : null;
}

/**
 * Where a day sits on a line that stopped being priced while its source kept
 * answering: `'carried'` over the hole the graph draws it across — the very pair
 * `soldGraphTailBridge` returns, under the same bounds the renderer passes, so a
 * day the picture leaves out is not one the hover explains — `'ended'` past the
 * day the source last answered, and `''` when the day is the line's own business:
 * one it priced, one before it started, or a hole inside its run.
 */
function soldGraphTailState(days, day, lastObservedDay, bounds) {
  const target = soldGraphDayMs(day);
  const priced = (Array.isArray(days) ? days : [])
    .map((row) => soldGraphDayMs(row?.day))
    .filter((ms) => Number.isFinite(ms));
  if (!priced.length || !Number.isFinite(target) || target <= Math.max(...priced)) {
    return '';
  }
  const tail = soldGraphTailBridge(days, lastObservedDay, bounds);
  const carried = tail
    && target > soldGraphDayMs(tail[0].day)
    && target <= soldGraphDayMs(tail[1].day);
  return carried ? 'carried' : 'ended';
}

/** The series day nearest `day`, when it is within `toleranceDays` of it. */
export function soldGraphNearDay(days, day, toleranceDays = 0) {
  const target = soldGraphDayMs(day);
  if (!Number.isFinite(target)) {
    return null;
  }
  const tolerance = Math.max(0, Number(toleranceDays) || 0);
  let best = null;
  let bestGap = Infinity;
  for (const row of (Array.isArray(days) ? days : [])) {
    const ms = soldGraphDayMs(row?.day);
    if (!Number.isFinite(ms)) {
      continue;
    }
    const gap = Math.abs(ms - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = row;
    }
  }
  return best && bestGap / DAY_MS <= tolerance ? best : null;
}

/** The last series day at or before `day`: a weekly trend reads backwards. */
export function soldGraphDayOnOrBefore(days, day) {
  const target = soldGraphDayMs(day);
  if (!Number.isFinite(target)) {
    return null;
  }
  let best = null;
  let bestMs = -Infinity;
  for (const row of (Array.isArray(days) ? days : [])) {
    const ms = soldGraphDayMs(row?.day);
    if (Number.isFinite(ms) && ms <= target && ms >= bestMs) {
      bestMs = ms;
      best = row;
    }
  }
  return best;
}

/**
 * Long windows read their dates with the year: the drawn range past 300 days,
 * or its first and last day in different years (a short window across New Year).
 */
export function soldGraphSpansYears(startMs, endMs) {
  const lo = Number(startMs);
  const hi = Number(endMs);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return false;
  }
  if ((hi - lo) / DAY_MS > 300) {
    return true;
  }
  return new Date(lo).getUTCFullYear() !== new Date(hi).getUTCFullYear();
}

/** `formatSoldDay`, with the locale's two-digit year appended when asked. */
export function formatSoldDayWithYear(isoDay, locale, withYear) {
  if (!withYear) {
    return formatSoldDay(isoDay, locale);
  }
  const match = String(isoDay || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    return '';
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

export const SOLD_GRAPH_TIP_ROWS = 6;

/**
 * One tooltip row's price: the visitor's currency for every positive amount.
 * `parts` is the desk's buyer answer for the same price, and that rule is about
 * what the visitor would *pay* — with a PKN balance that covers it there is no
 * local part at all, which left one bare "4 PKN" row among DKK ones. A graph row
 * is a quote, not a charge, so the amount is converted here with the desk's own
 * small-amount format (1 PKN is "0.0375 DKK", never "0.00"). The whole PKN number
 * is added in brackets only where the buyer rule shows both of its parts, and a
 * PKN visitor or an amount with no rate keeps the bare PKN. '' while the buyer's
 * currency is still unknown, like every other desk price.
 */
export function soldGraphRowPrice(pkn, parts, currency = '') {
  if (parts?.pending) return '';
  const code = String(currency || '').toUpperCase();
  const local = code && code !== 'PKN' ? offerPriceLabel(pkn, code) : '';
  const whole = formatPkn(Math.round(pkn));
  if (parts?.local && parts?.pkn && local) return `${local} (${whole})`;
  return local || whole;
}

/**
 * What the hover popup lists for one day: one row per visible series, in the
 * order they are passed. A sold series with no sale that day says so; a source
 * reads its own nearest day (Cardmarket its last one at or before) inside its
 * gap, says which day it starts from when the hover is earlier than that, and
 * otherwise has no data. A source with `carry: 'none'` is read only on a day it
 * quoted itself — a daily offer series has no price to stand for a day it did
 * not reach. A source that reports where it stopped being priced — the
 * `lastObservedDay` the graph carries its line to — answers every day past its
 * last price by itself: one the line is carried over says its price is old rather
 * than that there is no data, and quotes its `lastListing` under that, dated when
 * the hover is not on the day of the quote; a day past the carry is no data, and
 * never the stale price. The list is capped and the rest is counted.
 */
export function soldGraphHoverRows(series, day, {
  cap = SOLD_GRAPH_TIP_ROWS,
  formatValue = (value) => String(value),
  formatDay = (iso) => iso,
  endDay = '',
  bounds = null,
} = {}) {
  const rows = [];
  for (const line of (Array.isArray(series) ? series : [])) {
    if (!line || !line.label) {
      continue;
    }
    const days = Array.isArray(line.days) ? line.days : [];
    let firstDay = '';
    let firstMs = Infinity;
    for (const row of days) {
      const ms = soldGraphDayMs(row?.day);
      if (Number.isFinite(ms) && ms < firstMs) {
        firstMs = ms;
        firstDay = String(row.day);
      }
    }
    let hit = null;
    let note = '';
    let sub = '';
    // A line that says where it stopped being priced answers its own unpriced days.
    const tail = line.lastObservedDay
      ? soldGraphTailState(days, day, line.lastObservedDay, bounds)
      : '';
    if (line.kind === 'sold') {
      hit = days.find((row) => String(row?.day) === String(day)) || null;
      if (!hit) {
        note = 'no sale';
      }
    } else if (line.kind === 'now') {
      hit = day && String(day) === String(endDay) ? { value: line.value } : null;
      if (!hit) {
        note = 'no data';
      }
    } else if (tail === 'carried') {
      // The line is drawn over these days at its last price, and nothing was
      // priced on them: the listing under the row is what the source has.
      note = 'no recent sale';
      const listed = line.lastListing;
      const low = Number(listed?.lowPkn);
      const askMs = soldGraphDayMs(listed?.day);
      // One day's ask, so one day's date: the hover that is not on it says which
      // day it came from, and an earlier day has no quote of its own to show.
      if (Number.isFinite(low) && low > 0 && Number.isFinite(askMs)
        && soldGraphDayMs(day) >= askMs) {
        sub = `lowest listing ${formatValue(low)}`;
        if (String(listed.day) !== String(day)) {
          sub += ` (${formatDay(String(listed.day))})`;
        }
      }
    } else if (tail === 'ended') {
      note = 'no data';
    } else {
      hit = line.carry === 'onOrBefore'
        ? soldGraphDayOnOrBefore(days, day)
        : (line.carry === 'none'
          ? days.find((row) => String(row?.day) === String(day)) || null
          : soldGraphNearDay(days, day, line.gapDays));
      if (!hit && firstDay && soldGraphDayMs(day) < soldGraphDayMs(firstDay)) {
        note = `from ${formatDay(firstDay)}`;
      } else if (!hit) {
        note = 'no data';
      }
    }
    rows.push({
      key: line.key,
      label: line.label,
      color: line.color || '',
      dashed: Boolean(line.dashed),
      picked: Boolean(line.picked),
      value: hit ? Number(hit.value) : null,
      text: hit ? formatValue(Number(hit.value)) : note,
      sub,
    });
  }
  const shown = rows.slice(0, Math.max(1, Math.trunc(Number(cap)) || SOLD_GRAPH_TIP_ROWS));
  return { rows: shown, more: Math.max(0, rows.length - shown.length) };
}
