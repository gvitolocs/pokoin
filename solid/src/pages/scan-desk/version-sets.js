import { fetchVersionSet } from '@market/api.js';
import { sortArtworkVersions } from '@market/scan-artwork-versions.js';

/** CLIP version-set cache keyed by any member card id. */
export const versionSetCache = new Map();

export function loadVersionSet(cardId) {
  const id = String(cardId || '').trim();
  if (!id) return Promise.resolve(null);
  if (versionSetCache.has(id)) return Promise.resolve(versionSetCache.get(id));
  const pending = fetchVersionSet(id)
    .then((data) => {
      const printings = sortArtworkVersions(data?.printings || []);
      const payload = { printings, version: data?.version || '' };
      versionSetCache.set(id, payload);
      for (const row of printings) {
        const memberId = String(row.id || row.card_id || '');
        if (memberId) versionSetCache.set(memberId, payload);
      }
      return payload;
    })
    .catch(() => {
      versionSetCache.delete(id);
      return null;
    });
  versionSetCache.set(id, pending);
  return pending;
}

export const FIELD_LABEL = { reverse: 'Reverse', firstEdition: '1st Ed.', signed: 'Signed', altered: 'Altered' };

const BOX_POSITIONS_KEY = 'scan:box-positions';

/** Where the seller stopped in each box, so the next session's Start
 * position defaults there. localStorage: the scan desk is one browser. */
export function loadStoppedPositions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(BOX_POSITIONS_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

export function rememberStoppedPositions(next) {
  try {
    localStorage.setItem(BOX_POSITIONS_KEY, JSON.stringify(next));
  } catch (_) { /* private mode etc. — the suggestion is best effort */ }
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function p95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

/** Performance marks for docs/SCAN_PERFORMANCE.md (window.__pokoinScanPerf). */
export function perfSink() {
  if (typeof window === 'undefined') return [];
  window.__pokoinScanPerf = window.__pokoinScanPerf || [];
  return window.__pokoinScanPerf;
}

/** PerfPanel rows: [key, n, p50, p95] per timing. */
export function perfRows(samples) {
  const pick = (key) => samples.map((s) => s[key]).filter((v) => Number.isFinite(v));
  return ['captureToRequestMs', 'identifyMs', 'resultToDesktopMs', 'frameToRenderMs', 'captureToRenderMs'].map((key) => {
    const values = pick(key);
    return [key, values.length, median(values), p95(values)];
  });
}
