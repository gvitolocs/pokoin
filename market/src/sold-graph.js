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

/** 0–50 by tens, 0–500, 0–2500, 0–5000, 0–50k, then 0–125k by 25k (2.5–5–10). */
export function soldGraphScale(maxValue) {
  const max = Math.max(0, Number(maxValue) || 0);
  let step = 10;
  while (step * 5 < max) {
    if (step < 10000) {
      if (step === 100) {
        step = 500;
      } else if (step === 500) {
        step = 1000;
      } else {
        step *= 10;
      }
    } else {
      const mag = 10 ** Math.floor(Math.log10(step));
      const lead = step / mag;
      if (lead < 2.5) {
        step = 2.5 * mag;
      } else if (lead < 5) {
        step = 5 * mag;
      } else {
        step = 10 * mag;
      }
    }
  }
  const top = step * 5;
  return {
    min: 0,
    max: top,
    step,
    ticks: [0, 1, 2, 3, 4, 5].map((n) => n * step),
  };
}

export function soldGraphY(value, top, padT, plotH) {
  const v = Math.max(0, Number(value) || 0);
  const ceiling = Math.max(Number(top) || 0, 1);
  return padT + (1 - Math.min(v, ceiling) / ceiling) * plotH;
}

export function formatSoldAxisTick(value) {
  const n = Number(value) || 0;
  if (n >= 10000 && n % 1000 === 0) {
    return `${n / 1000}k`;
  }
  if (n >= 1000) {
    return String(n);
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
