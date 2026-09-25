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

export function nearestHistoryDay(days, ratio) {
  const list = Array.isArray(days) ? days.filter(Boolean) : [];
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const t = Math.min(1, Math.max(0, Number(ratio) || 0));
  const index = Math.round(t * (list.length - 1));
  return list[index] || list[list.length - 1];
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

export function formatHistoryTip(day) {
  if (!day) return null;
  const assets = day.assets || {};
  const rows = [
    { label: 'Currency', value: `${formatPknNumber(assets.currencyPkn)} PKN` },
  ];
  if (assets.cardsValuePkn != null) {
    rows.push({ label: 'Cards', value: `${formatPknNumber(assets.cardsValuePkn)} PKN` });
  }
  return {
    dateLabel: formatDayLabel(day.date),
    totalLabel: `${formatPknNumber(day.totalPkn)} PKN`,
    rows,
  };
}
