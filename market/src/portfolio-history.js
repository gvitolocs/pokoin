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
 * totalPkn is currency + listed asking + CardTrader 1-DR mark + NFT mark.
 * Card value is the 1-DR total already on the dashboard — not an invented price.
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
  const cardsValuePkn = asNonNeg(
    row.cardsValuePkn ?? prior?.cardsValuePkn,
  );
  const nftValuePkn = asNonNeg(
    row.nftValuePkn ?? prior?.nftValuePkn,
  );
  const cardsOwned = asNonNeg(
    row.cardsOwned ?? row.ownedCards ?? prior?.cardsOwned,
  );
  const nftOwned = asNonNeg(row.nftOwned ?? prior?.nftOwned);
  const totalPkn = currencyPkn + listedPkn + cardsValuePkn + nftValuePkn;
  const date = utcDayKey(row.date || row.day || new Date());
  if (!date) return null;
  return {
    date,
    totalPkn,
    assets: {
      currencyPkn,
      listedPkn,
      cardsValuePkn,
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
  // Cards owned is the CardTrader 1-DR mark. Counts stay on the tiles above.
  return {
    dateLabel: formatDayLabel(day.date),
    totalLabel: `${formatPknNumber(day.totalPkn)} PKN`,
    rows: [
      { label: 'Currency', value: `${formatPknNumber(assets.currencyPkn)} PKN` },
      { label: 'Listed', value: `${formatPknNumber(assets.listedPkn)} PKN` },
      { label: 'Cards owned', value: `${formatPknNumber(assets.cardsValuePkn ?? 0)} PKN` },
      { label: 'Digital / NFT', value: `${formatPknNumber(assets.nftValuePkn ?? 0)} PKN` },
    ],
  };
}
