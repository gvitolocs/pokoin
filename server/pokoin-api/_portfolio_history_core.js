'use strict';

/**
 * Collection value history. Pure, so the API can price and store days
 * without a browser, and tests can run without a database.
 *
 * Cards are marked to market on CardTrader sold prices only. Each held
 * printing slice (blueprint + condition + language + reverse / 1st edition /
 * graded) is worth its last sold daily median on or before that day, carried
 * forward until the slice sells again — the way portfolio trackers fill a
 * quote across days without a trade (Wealthfolio fill_missing_quotes). A
 * slice that never sold adds 0 PKN and stays out of the priced count. Asks,
 * dump minimums and other conditions' or languages' sales are never used.
 */

const PRICE_BASIS = 'ct-last-sold';
const SERIES_REVISION = 4;
const HISTORY_DAYS = 400;
// A stored series is reused for this long. Past days are frozen anyway, so a
// recompute only re-prices today.
const FRESH_MS = 15 * 60 * 1000;

/** Every sold print of the held blueprints; the slice match happens in JS. */
const SOLD_BY_BLUEPRINT_SQL = `
  select blueprint_id::text as blueprint_id,
         observed_day::text as day,
         condition,
         language,
         reverse,
         first_edition,
         graded,
         median_pkn::float8 as median_pkn
  from public.cardtrader_sold_daily
  where blueprint_id = any($1::bigint[])
    and observed_day <= (timezone('utc', now()))::date
    and median_pkn > 0
    and sold_qty > 0
`;

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

/** A plain 'YYYY-MM-DD' stays that day; timestamps become their UTC day. */
function dayOf(value) {
  const match = typeof value === 'string' ? /^(\d{4}-\d{2}-\d{2})/.exec(value.trim()) : null;
  if (match) return match[1];
  const at = coerceDate(value);
  return at ? utcDayKey(at) : '';
}

function nonNeg(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function round2(value) {
  return Math.round(value * 100) / 100;
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

/**
 * Wallet PKN on the days it moved, a zero the day before the first movement,
 * and the live balance on today.
 */
function walletSeries({ movements = [], balance = 0, today = new Date() } = {}) {
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
  const live = nonNeg(balance);
  if (!events.length && live === 0) return [];
  const days = [...byDay.keys()].sort();
  const points = [];
  const zeroDate = addUtcDays(days[0] || todayKey, -1);
  if (days.length && zeroDate) points.push({ date: zeroDate, currencyPkn: 0 });
  for (const date of days) points.push({ date, currencyPkn: byDay.get(date) });
  const todayPoint = points.find((row) => row.date === todayKey);
  if (todayPoint) todayPoint.currencyPkn = live;
  else points.push({ date: todayKey, currencyPkn: live });
  return points;
}

// CardTrader condition names and both Pokoin spellings (1-DR stock says LP / HP
// / PO, the sold table says SP / PL / Poor) meet on one key.
const CONDITION_KEY = {
  nm: 'NM',
  mint: 'NM',
  'near mint': 'NM',
  sp: 'SP',
  lp: 'SP',
  ex: 'SP',
  excellent: 'SP',
  'slightly played': 'SP',
  'lightly played': 'SP',
  mp: 'MP',
  gd: 'MP',
  good: 'MP',
  'moderately played': 'MP',
  'played good': 'MP',
  pl: 'PL',
  hp: 'PL',
  played: 'PL',
  'heavily played': 'PL',
  'poor played': 'PL',
  po: 'PO',
  poor: 'PO',
  damaged: 'PO',
  dmg: 'PO',
};

const LANGUAGE_KEY = {
  ja: 'JP',
  kr: 'KO',
  'zh-cn': 'ZH',
  'zh-hans': 'ZH',
  zh_hans: 'ZH',
  'zh-tw': 'ZHT',
  'zh-hant': 'ZHT',
  zh_hant: 'ZHT',
};

function conditionKey(value) {
  const raw = String(value || '').trim().toLowerCase();
  return CONDITION_KEY[raw] || raw.toUpperCase();
}

function languageKey(value) {
  const raw = String(value || '').trim().toLowerCase();
  return LANGUAGE_KEY[raw] || raw.toUpperCase();
}

/** The same card, condition, language and finish sell as one price. */
function soldSliceKey(row = {}) {
  const blueprint = String(row.blueprint_id ?? row.blueprintId ?? '').trim();
  if (!/^\d+$/.test(blueprint)) return '';
  return [
    blueprint,
    conditionKey(row.condition),
    languageKey(row.language),
    row.reverse === true ? 'R' : '-',
    (row.first_edition ?? row.firstEdition) === true ? '1' : '-',
    row.graded === true ? 'G' : '-',
  ].join('|');
}

/** Sold daily medians per slice, oldest first. */
function soldPriceBook(rows) {
  const book = new Map();
  for (const row of rows || []) {
    const key = soldSliceKey(row);
    const day = dayOf(row.day ?? row.observed_day);
    const pkn = Number(row.median_pkn ?? row.medianPkn);
    if (!key || !day || !(pkn > 0)) continue;
    if (!book.has(key)) book.set(key, []);
    book.get(key).push({ day, pkn });
  }
  for (const entries of book.values()) entries.sort((a, b) => a.day.localeCompare(b.day));
  return book;
}

/** Last sold median on or before day, or null when the slice had not sold yet. */
function priceAsOf(entries, day) {
  if (!entries?.length || !day) return null;
  let lo = 0;
  let hi = entries.length - 1;
  let hit = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].day <= day) {
      hit = entries[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return hit;
}

/** Last sold price for one stock row: { pkn, day } or null. */
function lastSoldFor(row, book, day) {
  const hit = priceAsOf(book?.get(soldSliceKey(row)), day);
  return hit ? { pkn: round2(hit.pkn), day: hit.day } : null;
}

/** 1-DR stock rows as holdings that count from the day each was first synced. */
function holdingSlices(rows) {
  return (rows || [])
    .map((row, index) => {
      const qty = Math.max(0, Math.trunc(Number(row.quantity) || 0));
      if (!qty) return null;
      return {
        key: soldSliceKey(row) || `unpriced|${index}`,
        qty,
        since: dayOf(row.since ?? row.created_at ?? row.createdAt),
      };
    })
    .filter(Boolean);
}

/** Cards held on day, priced at each slice's last sale. Null when nothing was held. */
function valueHoldingsOn(holdings, book, day) {
  let held = 0;
  let priced = 0;
  let value = 0;
  for (const holding of holdings || []) {
    if (holding.since && holding.since > day) continue;
    held += holding.qty;
    const hit = priceAsOf(book?.get(holding.key), day);
    if (!hit) continue;
    priced += holding.qty;
    value += holding.qty * hit.pkn;
  }
  if (!held) return null;
  return { cardsValuePkn: round2(value), cardsPriced: priced, cardsHeld: held };
}

/**
 * Price move of the same basket from prevDay to day: only slices held and
 * priced on both days, like an index whose new members do not count as a
 * return. A card getting its first sale is not the market moving.
 */
function basketMove(holdings, book, day, prevDay) {
  let before = 0;
  let after = 0;
  for (const holding of holdings || []) {
    if (holding.since && holding.since > prevDay) continue;
    const entries = book?.get(holding.key);
    const was = priceAsOf(entries, prevDay);
    if (!was) continue;
    before += holding.qty * was.pkn;
    after += holding.qty * priceAsOf(entries, day).pkn;
  }
  return before > 0 ? Math.round((after / before - 1) * 1e6) / 1e6 : null;
}

function compactDay(row = {}) {
  const date = dayOf(row.date);
  if (!date) return null;
  const currencyPkn = round2(nonNeg(row.currencyPkn));
  const held = Math.max(0, Math.trunc(Number(row.cardsHeld) || 0));
  const hasCards = row.cardsValuePkn != null && row.cardsValuePkn !== '' && (held > 0 || row.cardsKnown === true);
  const cardsValuePkn = hasCards ? round2(nonNeg(row.cardsValuePkn)) : null;
  return {
    date,
    currencyPkn,
    cardsValuePkn,
    cardsKnown: cardsValuePkn != null,
    cardsPriced: hasCards ? Math.min(held, Math.max(0, Math.trunc(Number(row.cardsPriced) || 0))) : 0,
    cardsHeld: hasCards ? held : 0,
    cardsMove: hasCards && row.cardsMove != null && Number.isFinite(Number(row.cardsMove))
      ? Number(row.cardsMove)
      : null,
    totalPkn: round2(currencyPkn + (cardsValuePkn || 0)),
  };
}

/**
 * Card values of days that had already ended when the series was stored. The
 * 1-DR table only knows today's stock, so re-pricing those days would erase
 * cards that have since sold. Another basis or revision is discarded.
 */
function frozenCardDays(doc, todayKey) {
  const frozen = new Map();
  if (!doc || doc.priceBasis !== PRICE_BASIS || doc.seriesRevision !== SERIES_REVISION) return frozen;
  for (const row of Array.isArray(doc.days) ? doc.days : []) {
    const day = compactDay(row);
    if (!day || !(day.date < todayKey)) continue;
    frozen.set(day.date, day.cardsValuePkn == null
      ? null
      : {
        cardsValuePkn: day.cardsValuePkn,
        cardsPriced: day.cardsPriced,
        cardsHeld: day.cardsHeld,
        cardsMove: day.cardsMove,
      });
  }
  return frozen;
}

/**
 * One point per UTC day, from the first wallet movement or held card up to
 * today (at most HISTORY_DAYS). Wallet PKN carries between ledger days; cards
 * come from a frozen stored day or from the price book.
 */
function buildDailySeries({
  wallet = [],
  holdings = [],
  book = new Map(),
  frozen = new Map(),
  today = new Date(),
} = {}) {
  const todayKey = utcDayKey(today);
  if (!todayKey) return [];
  const walletDays = (wallet || [])
    .map((row) => ({ date: dayOf(row?.date), currencyPkn: nonNeg(row?.currencyPkn) }))
    .filter((row) => row.date && row.date <= todayKey)
    .sort((a, b) => a.date.localeCompare(b.date));
  const starts = [
    walletDays[0]?.date,
    ...(holdings || []).map((holding) => holding.since || todayKey),
    ...frozen.keys(),
  ].filter((date) => date && date <= todayKey).sort();
  if (!starts.length) return [];
  const floor = addUtcDays(todayKey, -(HISTORY_DAYS - 1));
  const start = starts[0] < floor ? floor : starts[0];
  const points = [];
  let currency = 0;
  let next = 0;
  for (let date = start; date && date <= todayKey; date = addUtcDays(date, 1)) {
    while (next < walletDays.length && walletDays[next].date <= date) {
      currency = walletDays[next].currencyPkn;
      next += 1;
    }
    let cards = frozen.has(date) ? frozen.get(date) : valueHoldingsOn(holdings, book, date);
    if (cards && !frozen.has(date) && date > start) {
      cards = { ...cards, cardsMove: basketMove(holdings, book, date, addUtcDays(date, -1)) };
    }
    points.push(compactDay({ date, currencyPkn: currency, ...(cards || {}) }));
  }
  return points.filter(Boolean);
}

function storedIsFresh(doc, now = new Date()) {
  if (!doc || doc.priceBasis !== PRICE_BASIS || doc.seriesRevision !== SERIES_REVISION) return false;
  const at = coerceDate(doc.updatedAt);
  const current = now instanceof Date ? now : new Date(now);
  if (!at || Number.isNaN(current.getTime())) return false;
  if (utcDayKey(at) !== utcDayKey(current)) return false;
  const age = current.getTime() - at.getTime();
  return age >= 0 && age < FRESH_MS;
}

module.exports = {
  FRESH_MS,
  HISTORY_DAYS,
  PRICE_BASIS,
  SERIES_REVISION,
  SOLD_BY_BLUEPRINT_SQL,
  addUtcDays,
  basketMove,
  buildDailySeries,
  compactDay,
  conditionKey,
  dayOf,
  frozenCardDays,
  holdingSlices,
  lastSoldFor,
  movementFromLedger,
  priceAsOf,
  soldPriceBook,
  soldSliceKey,
  storedIsFresh,
  utcDayKey,
  valueHoldingsOn,
  walletSeries,
};
