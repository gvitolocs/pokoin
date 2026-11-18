/**
 * Top movers for the Dashboard.
 *
 * The API ranks the seller's own printing slices by how far their last sold
 * median moved inside the chart's window
 * (pokoin-rust/crates/accounts/src/domain/portfolio_history.rs::top_movers) and
 * sends one price point per day, thinned to at most 30. This module formats a
 * tile and draws its sparkline; nothing here re-prices a card.
 */

import { formatPknNumber } from './pkn.js';
import { HISTORY_PRESETS, stepHistoryPoints } from './portfolio-history.js';
import { formatAssetsValue } from './seller-currency.js';

/** Tiles per side of the switch. */
export const MOVER_LIMIT = 6;

/** The currency a tile prints when the seller has not stated one. */
const MOVER_PKN = 'PKN';

/** Sparkline box in viewBox units; the CSS sizes it fluidly. */
export const MOVER_SPARK = { width: 120, height: 34, pad: 3 };

/**
 * The movers window for a chart preset: the same day count the graph uses, so
 * a tile under a 3M chart moves over exactly 3M. MAX asks for all history.
 */
export function moverDaysForPreset(presetId) {
  if (String(presetId || '').toUpperCase() === 'MAX') return 'max';
  const preset = HISTORY_PRESETS.find((row) => row.id === presetId);
  return preset?.days || 30;
}

function numberOrZero(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

/** One mover as the tile needs it; tolerates a missing sparkline. */
export function normalizeMover(row) {
  if (!row || typeof row !== 'object') return null;
  const blueprintId = String(row.blueprintId ?? '').trim();
  const series = (Array.isArray(row.series) ? row.series : [])
    .map((point) => ({
      day: String(point?.day || ''),
      pkn: numberOrZero(point?.pkn),
    }))
    .filter((point) => point.day && point.pkn > 0);
  return {
    key: [blueprintId, row.condition || '', row.language || '', row.reverse ? 'R' : '-',
      row.firstEdition ? '1' : '-', row.graded ? 'G' : '-'].join('|'),
    blueprintId,
    cardId: String(row.cardId ?? '').trim(),
    name: String(row.name || '').trim(),
    setName: String(row.setName || '').trim(),
    collectorNumber: String(row.collectorNumber ?? row.cardNumber ?? '').trim(),
    imageUrl: String(row.imageUrl || '').trim(),
    condition: String(row.condition || '').trim(),
    language: String(row.language || '').trim(),
    reverse: Boolean(row.reverse),
    firstEdition: Boolean(row.firstEdition),
    graded: Boolean(row.graded),
    quantity: Math.max(0, Math.trunc(numberOrZero(row.quantity))),
    startPkn: numberOrZero(row.startPkn),
    endPkn: numberOrZero(row.endPkn),
    changePkn: numberOrZero(row.changePkn),
    changePct: numberOrZero(row.changePct),
    series,
  };
}

/** `{ ok, days, gainers, losers }` into tile models. */
export function normalizeMovers(payload) {
  const pick = (rows) => (Array.isArray(rows) ? rows : []).map(normalizeMover).filter(Boolean);
  return {
    days: payload?.days ?? null,
    gainers: pick(payload?.gainers),
    losers: pick(payload?.losers),
  };
}

/** "Obsidian Flames · 124/182", whichever part is known. */
export function moverTileLine(mover) {
  if (!mover) return '';
  return [mover.setName, mover.collectorNumber].filter(Boolean).join(' · ');
}

/** Condition, language, then the finish flags. */
export function moverChips(mover) {
  if (!mover) return [];
  return [
    mover.condition,
    mover.language,
    mover.reverse ? 'Reverse' : '',
    mover.firstEdition ? '1st Ed.' : '',
    mover.graded ? 'Graded' : '',
  ].filter(Boolean);
}

/**
 * One PKN amount as a tile prints it. A seller whose display currency is PKN
 * (or not yet known) keeps the digits-only PKN text; anyone else gets the same
 * local-currency label and rounding the Inventory page uses (docs/MARKET.md
 * "Buyer display currency", docs/SCAN_LISTING_WORKFLOW.md "Price").
 */
function moverAmount(pkn, currency) {
  const value = numberOrZero(pkn);
  const code = String(currency || MOVER_PKN).trim().toUpperCase() || MOVER_PKN;
  if (code === MOVER_PKN) return `${formatPknNumber(value)} PKN`;
  return formatAssetsValue(value, code);
}

/** Today's value: the last sold median of that slice, per copy. */
export function formatMoverValue(mover, currency = '') {
  const value = numberOrZero(mover?.endPkn);
  return value > 0 ? moverAmount(value, currency) : '';
}

export function moverTone(mover) {
  const change = numberOrZero(mover?.changePct) || numberOrZero(mover?.changePkn);
  if (change > 0) return 'is-up';
  return change < 0 ? 'is-down' : 'is-flat';
}

/** "+320 PKN (+28.4%)" — the money move first, the percent beside it. */
export function formatMoverChange(mover, currency = '') {
  if (!mover) return '';
  const pkn = numberOrZero(mover.changePkn);
  const pct = numberOrZero(mover.changePct);
  const sign = pkn > 0 || pct > 0 ? '+' : (pkn < 0 || pct < 0 ? '-' : '');
  const money = `${sign}${moverAmount(Math.abs(pkn), currency)}`;
  const percent = formatPknNumber(Math.round(Math.abs(pct) * 10) / 10, { maximumFractionDigits: 1 });
  return `${money} (${sign}${percent}%)`;
}

/** Screen-reader / title text for the whole tile. */
export function moverTitle(mover, currency = '') {
  if (!mover) return '';
  const parts = [
    mover.name || 'Card',
    moverTileLine(mover),
    ...moverChips(mover),
    mover.quantity > 1 ? `Qty ${mover.quantity}` : '',
    formatMoverValue(mover, currency),
    formatMoverChange(mover, currency),
  ].filter(Boolean);
  return parts.join(' · ');
}

/**
 * Sparkline geometry. The value is carried between sales, so the line steps —
 * the same reading as the portfolio chart above it. Flat series sit mid-box.
 */
export function moverSpark(mover, size = MOVER_SPARK) {
  const series = mover?.series || [];
  const width = numberOrZero(size.width) || MOVER_SPARK.width;
  const height = numberOrZero(size.height) || MOVER_SPARK.height;
  const pad = Math.min(numberOrZero(size.pad) || MOVER_SPARK.pad, height / 2);
  if (series.length < 2) return { line: '', area: '', points: [] };
  const values = series.map((point) => point.pkn);
  const high = Math.max(...values);
  const low = Math.min(...values);
  const plotWidth = width - pad * 2;
  const plotHeight = height - pad * 2;
  const step = series.length > 1 ? plotWidth / (series.length - 1) : 0;
  const yOf = (value) => (high === low
    ? height / 2
    : height - pad - ((value - low) / (high - low)) * plotHeight);
  const coords = series.map((point, index) => ({ x: pad + index * step, y: yOf(point.pkn) }));
  const stepped = stepHistoryPoints(coords);
  const attr = (list) => list.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const baseline = height - pad;
  return {
    line: attr(stepped),
    area: attr([{ x: coords[0].x, y: baseline }, ...stepped, { x: coords[coords.length - 1].x, y: baseline }]),
    points: coords,
    width,
    height,
    high,
    low,
  };
}
