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
 * One day of portfolio value + composition.
 * totalPkn is currency + listed only — we do not invent card valuations.
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
  const cardsOwned = asNonNeg(
    row.cardsOwned ?? row.ownedCards ?? prior?.cardsOwned,
  );
  const nftOwned = asNonNeg(row.nftOwned ?? prior?.nftOwned);
  const totalPkn = asNonNeg(
    row.totalPkn != null ? row.totalPkn : currencyPkn + listedPkn,
  );
  const date = utcDayKey(row.date || row.day || new Date());
  if (!date) return null;
  return {
    date,
    totalPkn,
    assets: {
      currencyPkn,
      listedPkn,
      cardsOwned,
      nftOwned,
    },
  };
}

/** Build today's live point from Dashboard metrics. */
export function todayHistoryDay({
  currencyPkn = 0,
  listedPkn = 0,
  cardsOwned = 0,
  nftOwned = 0,
  date = new Date(),
} = {}) {
  return normalizeHistoryDay({
    date,
    currencyPkn,
    listedPkn,
    cardsOwned,
    nftOwned,
  });
}

export function historySeriesMax(days = []) {
  let max = 0;
  for (const day of days || []) {
    max = Math.max(max, asNonNeg(day?.totalPkn));
  }
  return max;
}

export function nearestHistoryDay(days, ratio) {
  const list = Array.isArray(days) ? days.filter(Boolean) : [];
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const t = Math.min(1, Math.max(0, Number(ratio) || 0));
  const index = Math.round(t * (list.length - 1));
  return list[index] || list[list.length - 1];
}

export function formatHistoryTip(day) {
  if (!day) return null;
  const assets = day.assets || {};
  return {
    dateLabel: formatDayLabel(day.date),
    totalLabel: `${formatPknNumber(day.totalPkn)} PKN`,
    rows: [
      { label: 'Currency', value: `${formatPknNumber(assets.currencyPkn)} PKN` },
      { label: 'Listed', value: `${formatPknNumber(assets.listedPkn)} PKN` },
      { label: 'Cards owned', value: String(asNonNeg(assets.cardsOwned)) },
      { label: 'Digital / NFT', value: String(asNonNeg(assets.nftOwned)) },
    ],
  };
}
