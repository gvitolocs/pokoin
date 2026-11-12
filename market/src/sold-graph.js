import { langMeta } from './locale.js';

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
