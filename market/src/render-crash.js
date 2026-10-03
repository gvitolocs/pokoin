/** Structured record for a React render failure. No tokens, addresses, or stacks in the UI. */

let suggestState = { query: '', generation: 0 };

export function noteSuggestState(patch = {}) {
  suggestState = {
    query: String(patch.query ?? suggestState.query ?? '').slice(0, 80),
    generation: Number(patch.generation ?? suggestState.generation) || 0,
  };
}

export function currentSuggestState() {
  return { ...suggestState };
}

export function resetSuggestStateForTests() {
  suggestState = { query: '', generation: 0 };
}

function scrub(value) {
  return String(value || '')
    .replace(/bearer\s+\S+/gi, 'bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .slice(0, 500);
}

export function releaseAssetId() {
  if (typeof document === 'undefined') return '';
  const src = [...document.scripts].map((node) => node.src || '').find((href) => /\/assets\/index-/.test(href)) || '';
  const match = src.match(/index-([A-Za-z0-9_-]+)\.js/);
  return match ? match[1] : '';
}

function routePath() {
  if (typeof location === 'undefined') return '';
  return String(location.pathname || '');
}

function searchQuery() {
  if (suggestState.query) return suggestState.query;
  if (typeof location === 'undefined') return '';
  try {
    return String(new URLSearchParams(location.search || '').get('q') || '').slice(0, 80);
  } catch {
    return '';
  }
}

/**
 * @param {Error|null|undefined} error
 * @param {{ componentStack?: string }|null|undefined} info
 */
export function renderCrashRecord(error, info) {
  const record = {
    name: String(error?.name || 'Error'),
    message: scrub(error?.message),
    componentStack: scrub(info?.componentStack),
    route: routePath(),
    release: releaseAssetId(),
    query: searchQuery(),
    generation: suggestState.generation,
  };
  if (typeof globalThis !== 'undefined') {
    globalThis.__pokoinRenderCrash = record;
  }
  console.error('pokoin render failed', record);
  return record;
}
