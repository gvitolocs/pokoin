/** Resolve the visitor's nation for Flex From/To defaults.
 * Profile ship-from wins, then Cloudflare IP (`/cdn-cgi/trace`), then browser
 * locale. Always clamped to `allowed` ISO codes (live rate table).
 */

import { countryFromLocale } from './pkn.js';

export function pickAllowedCountry(code, allowed) {
  const raw = String(code || '').trim().toUpperCase();
  if (!raw || !allowed?.has?.(raw)) return '';
  return raw;
}

/** Parse Cloudflare `loc=XX` from /cdn-cgi/trace body. */
export function countryFromCfTrace(text) {
  const match = String(text || '').match(/^\s*loc=([A-Za-z]{2})\s*$/m);
  return match ? match[1].toUpperCase() : '';
}

/**
 * @param {{
 *   allowedFrom: string[],
 *   allowedTo: string[],
 *   signedIn?: boolean,
 *   loadProfileCountry?: () => Promise<string>,
 *   fetchTrace?: () => Promise<string>,
 *   localeCountry?: string,
 * }} opts
 * @returns {Promise<{ from: string, to: string, source: 'profile'|'ip'|'locale'|'fallback' }>}
 */
export async function resolveFlexDefaultCountries({
  allowedFrom = [],
  allowedTo = [],
  signedIn = false,
  loadProfileCountry = null,
  fetchTrace = null,
  localeCountry = countryFromLocale(),
} = {}) {
  const fromSet = new Set((allowedFrom || []).map((c) => String(c).toUpperCase()));
  const toSet = new Set((allowedTo || []).map((c) => String(c).toUpperCase()));
  const both = (code) => {
    const from = pickAllowedCountry(code, fromSet);
    const to = pickAllowedCountry(code, toSet);
    return from && to ? { from, to } : null;
  };

  if (signedIn && typeof loadProfileCountry === 'function') {
    try {
      const profile = both(await loadProfileCountry());
      if (profile) return { ...profile, source: 'profile' };
    } catch {
      /* fall through */
    }
  }

  try {
    const load = fetchTrace || (() => fetch('/cdn-cgi/trace').then((r) => r.text()));
    const ip = both(countryFromCfTrace(await load()));
    if (ip) return { ...ip, source: 'ip' };
  } catch {
    /* fall through */
  }

  const locale = both(localeCountry);
  if (locale) return { ...locale, source: 'locale' };

  const fallbackFrom = [...fromSet][0] || 'DK';
  const fallbackTo = toSet.has(fallbackFrom) ? fallbackFrom : ([...toSet][0] || fallbackFrom);
  return { from: fallbackFrom, to: fallbackTo, source: 'fallback' };
}
