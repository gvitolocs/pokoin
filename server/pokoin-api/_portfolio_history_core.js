'use strict';

/** Stored collection-history days. Pure so the API can save them without the browser. */

function utcDayKey(date = new Date()) {
  const parsed = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function addUtcDays(dayKey, delta) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + Number(delta || 0));
  return date.toISOString().slice(0, 10);
}

function coerceDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value === 'object' && typeof value.seconds === 'number') {
    return new Date(value.seconds * 1000);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function movementFromLedger(row = {}) {
  const amount = Number(row.amountPkn);
  if (!Number.isFinite(amount) || amount === 0) return null;
  const type = String(row.type || '');
  const outbound = amount < 0 || type.includes('sent') || type.includes('withdraw');
  const signed = outbound && amount > 0 ? -Math.abs(amount) : amount;
  const at = coerceDate(row.createdAt || row.at || row.date);
  const date = at ? utcDayKey(at) : '';
  if (!date) return null;
  return { date, amountPkn: signed };
}

const PRICE_BASIS = 'ct-dump-min';
const SERIES_REVISION = 2;

function compactDay(row = {}) {
  const date = utcDayKey(row.date);
  if (!date) return null;
  const currencyPkn = Math.max(0, Number(row.currencyPkn) || 0);
  const known = row.cardsKnown === true;
  const raw = row.cardsValuePkn;
  const cardsValuePkn = known && raw != null && raw !== ''
    ? Math.max(0, Number(raw) || 0)
    : null;
  const point = {
    date,
    currencyPkn,
    cardsValuePkn,
    cardsKnown: known,
    totalPkn: currencyPkn + (cardsValuePkn || 0),
  };
  if (known && row.priceBasis === PRICE_BASIS) point.priceBasis = PRICE_BASIS;
  return point;
}

function buildSeries({
  movements = [],
  balance = 0,
  marketCardsPkn = null,
  marketChecked = false,
  today = new Date(),
} = {}) {
  const todayKey = utcDayKey(today);
  if (!todayKey) return [];
  const events = (movements || [])
    .map((row) => (row?.date && row?.amountPkn != null && !row.type ? row : movementFromLedger(row)))
    .filter((row) => row?.date && row.date <= todayKey && row.amountPkn)
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
  if (zeroDate && zeroDate < first) points.push({ date: zeroDate, currencyPkn: 0 });
  for (const date of [...byDay.keys()].sort()) {
    points.push({ date, currencyPkn: byDay.get(date) });
  }
  let todayPoint = points.find((row) => row.date === todayKey);
  if (!todayPoint) {
    todayPoint = { date: todayKey, currencyPkn: live };
    points.push(todayPoint);
  } else {
    todayPoint.currencyPkn = live;
  }
  if (marketChecked) {
    todayPoint.cardsValuePkn = market > 0 ? market : null;
    todayPoint.cardsKnown = true;
  }
  return points.map(compactDay).filter(Boolean);
}

function storedIsFresh(doc, todayKey) {
  if (!doc || doc.priceBasis !== PRICE_BASIS || doc.seriesRevision !== SERIES_REVISION) return false;
  return utcDayKey(doc.updatedAt) === todayKey;
}

/** A dump day that prices only a sliver of the pile is not a market print. */
function fullBookDumps(dumps) {
  const rows = (dumps || [])
    .map((row) => ({
      date: utcDayKey(row.date || row.day),
      cardsValuePkn: Math.round((Number(row.cardsValuePkn ?? row.market_pkn) || 0) * 100) / 100,
      priced: Math.max(0, Number(row.priced) || 0),
    }))
    .filter((row) => row.date && row.cardsValuePkn > 0);
  const peak = rows.reduce((max, row) => Math.max(max, row.priced), 0);
  if (!peak) return rows;
  return rows.filter((row) => row.priced >= peak * 0.5);
}

/**
 * Wallet days stay on the ledger. Card value is the daily CardTrader dump
 * minimum from the day the seller connected, carried forward until the next
 * dump. A later first dump is anchored on the sync day so the pile is not
 * dated as if it arrived the day the chart was computed.
 */
function applyDumpValues(walletDays, dumps, { ownershipDate, today } = {}) {
  const todayKey = utcDayKey(today);
  if (!todayKey) return [];
  const own = utcDayKey(ownershipDate) || '';
  const priced = fullBookDumps(dumps)
    .filter((row) => row.date <= todayKey)
    .sort((a, b) => a.date.localeCompare(b.date));
  const currencyAt = new Map();
  for (const day of walletDays || []) {
    const date = utcDayKey(day?.date);
    if (date && date <= todayKey) currencyAt.set(date, Math.max(0, Number(day.currencyPkn) || 0));
  }
  function inForce(date) {
    let value = null;
    for (const row of priced) {
      if (row.date <= date) value = row.cardsValuePkn;
      else break;
    }
    return value;
  }
  // A later first dump is anchored on the sync day. A dump already printed
  // before that day stays the price in force — it is not replaced by the next one.
  const anchor = own && inForce(own) == null
    ? (priced.find((row) => row.date > own)?.cardsValuePkn ?? null)
    : null;
  const dates = new Set([...currencyAt.keys(), todayKey]);
  if (own) dates.add(own);
  for (const row of priced) {
    if (!own || row.date >= own) dates.add(row.date);
  }
  let currency = 0;
  let cards = null;
  let cardsStarted = false;
  const points = [];
  for (const date of [...dates].filter(Boolean).sort()) {
    if (currencyAt.has(date)) currency = currencyAt.get(date);
    if (!own || date >= own) {
      const printed = inForce(date);
      const next = printed == null && date === own ? anchor : printed;
      if (next != null) {
        cards = next;
        cardsStarted = true;
      }
    }
    const inCollection = own ? date >= own : cardsStarted;
    const known = inCollection && cardsStarted && cards != null;
    points.push(compactDay({
      date,
      currencyPkn: currency,
      cardsValuePkn: known ? cards : null,
      cardsKnown: known,
      priceBasis: known ? PRICE_BASIS : '',
    }));
  }
  return points.filter(Boolean);
}

function upsertDay(days, point) {
  const next = (days || []).map(compactDay).filter((day) => day && day.date !== point.date);
  next.push(compactDay(point));
  next.sort((a, b) => a.date.localeCompare(b.date));
  return next.filter(Boolean).slice(-400);
}

module.exports = {
  PRICE_BASIS,
  SERIES_REVISION,
  utcDayKey,
  movementFromLedger,
  buildSeries,
  storedIsFresh,
  upsertDay,
  compactDay,
  applyDumpValues,
};
