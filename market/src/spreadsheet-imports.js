/** Recent spreadsheet imports shown on the sell-via-spreadsheet desk. */

const KEY = 'pokoin.spreadsheetImports.v1';
const MAX_SAVED = 40;

export const IMPORT_COLUMNS = Object.freeze([
  ['id', 'Import ID'],
  ['game', 'Game'],
  ['mode', 'Mode'],
  ['rows', 'Number of rows'],
  ['errors', 'Errors'],
  ['warnings', 'Warnings'],
  ['created', 'Items created'],
  ['updated', 'Updated'],
  ['deleted', 'Deleted'],
  ['createdAt', 'Created at'],
  ['status', 'Status'],
]);

export function loadSpreadsheetImports(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage?.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function saveSpreadsheetImports(rows, storage = globalThis.localStorage) {
  storage?.setItem(KEY, JSON.stringify((rows || []).slice(0, MAX_SAVED)));
}

export function nextImportId(rows) {
  const max = (rows || []).reduce((n, row) => Math.max(n, Number(row?.id) || 0), 0);
  return max + 1;
}

export function formatImportWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function recordFromImport({ id, game, result, at = new Date().toISOString() }) {
  const counts = result?.counts || {};
  const failed = Number(counts.failed) || 0;
  const total = Number(counts.total) || 0;
  const created = Number(counts.created) || 0;
  let status = 'Completed';
  if (result?.dryRun) status = (Number(counts.preview) || 0) > 0 ? 'Ready' : 'Failed';
  else if (total > 0 && created === 0 && failed === total) status = 'Failed';
  return {
    id,
    game: game || 'Pokémon',
    mode: 'Add',
    rows: total,
    errors: failed,
    warnings: Number(counts.skipped) || 0,
    created: result?.dryRun ? 0 : created,
    updated: 0,
    deleted: 0,
    createdAt: at,
    status,
  };
}
