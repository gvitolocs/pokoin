'use strict';

/**
 * Client country from edge/proxy headers (Cloudflare, Vercel, CloudFront, Fastly).
 * Used to seed shipFromCountry when the seller has never set one.
 */

const { normalizeCountry } = require('./_checkout_core');

/** EU ship-from allowlist (same set as market/src/ship-countries.js). */
const SHIP_FROM_CODES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

const HEADER_KEYS = [
  'cf-ipcountry',
  'x-vercel-ip-country',
  'cloudfront-viewer-country',
  'x-country-code',
  'x-geo-country',
];

function headerValue(headers, key) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return String(headers.get(key) || headers.get(key.toLowerCase()) || '').trim();
  }
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (String(name).toLowerCase() === lower) {
      return String(Array.isArray(value) ? value[0] : value || '').trim();
    }
  }
  return '';
}

/** Raw ISO-2 from request headers, or '' when unknown / EU / XX. */
function countryFromRequestHeaders(headers) {
  for (const key of HEADER_KEYS) {
    const code = normalizeCountry(headerValue(headers, key));
    if (!code || code === 'XX' || code === 'T1') continue;
    return code;
  }
  return '';
}

/** Ship-from seed: IP country only when it is an allowed sell-from country. */
function shipFromCountryFromRequest(headers) {
  const code = countryFromRequestHeaders(headers);
  return SHIP_FROM_CODES.has(code) ? code : '';
}

function isAllowedShipFromCountry(value) {
  const code = normalizeCountry(value);
  return Boolean(code && SHIP_FROM_CODES.has(code));
}

module.exports = {
  SHIP_FROM_CODES,
  countryFromRequestHeaders,
  shipFromCountryFromRequest,
  isAllowedShipFromCountry,
};
