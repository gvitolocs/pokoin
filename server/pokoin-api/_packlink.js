'use strict';

/**
 * Packlink PRO rate quotes (read-only). Auth: PACKLINK_API_KEY in Authorization.
 * https://api.packlink.com/v1/services
 */

const PACKLINK_BASE = String(process.env.PACKLINK_API_BASE || 'https://api.packlink.com').replace(/\/+$/, '');

/** Preview zips when the buyer has not saved a postal code yet. */
const DEFAULT_ZIP = {
  AT: '1010', BE: '1000', BG: '1000', HR: '10000', CY: '1010', CZ: '11000',
  DK: '2100', EE: '10111', FI: '00100', FR: '75001', DE: '10115', GR: '10431',
  HU: '1051', IE: 'D02', IT: '20121', LV: 'LV-1010', LT: '01100', LU: '1009',
  MT: 'VLT', NL: '1012', PL: '00-001', PT: '1000-001', RO: '010011', SK: '81101',
  SI: '1000', ES: '28001', SE: '11122', GB: 'SW1A', CH: '8001', NO: '0150',
  US: '10001', CA: 'M5V', JP: '100-0001', AU: '2000', CN: '100000',
};

const TIER_PROFILE = {
  SMALL: { weight: 0.053, length: 18, width: 12, height: 1 },
  MEDIUM: { weight: 0.085, length: 20, width: 14, height: 1.5 },
  LARGE: { weight: 0.165, length: 22, width: 16, height: 2.5 },
  EXTRA_LARGE: { weight: 20, length: 60, width: 40, height: 40 },
};

function packlinkApiKey() {
  const fromEnv = String(process.env.PACKLINK_API_KEY || process.env.packlink || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const fs = require('fs');
    const path = require('path');
    return String(fs.readFileSync(path.join(__dirname, '.packlink-key'), 'utf8') || '').trim();
  } catch (_) {
    return '';
  }
}

function defaultZip(country) {
  const code = String(country || '').trim().toUpperCase();
  return DEFAULT_ZIP[code] || '1000';
}

function packageTierForCount(count) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  if (n <= 4) return 'SMALL';
  if (n <= 20) return 'MEDIUM';
  if (n <= 200) return 'LARGE';
  return 'EXTRA_LARGE';
}

function priceToEurCents(price) {
  if (price == null) return null;
  if (typeof price === 'number' && Number.isFinite(price)) {
    return Math.max(1, Math.round(price * 100));
  }
  if (typeof price === 'object') {
    const total = Number(price.total_price ?? price.base_price);
    const currency = String(price.currency || 'EUR').toUpperCase();
    if (!Number.isFinite(total)) return null;
    if (currency === 'EUR') return Math.max(1, Math.round(total * 100));
    return null;
  }
  return null;
}

function normalizeService(row) {
  if (!row || typeof row !== 'object') return null;
  const id = String(row.id ?? row.service_id ?? '').trim();
  if (!id) return null;
  const cents = priceToEurCents(row.price ?? row.base_price ?? row.total_price);
  if (cents == null) return null;
  const name = String(row.name || row.service_name || 'Shipping').trim();
  const carrier = String(row.carrier_name || row.carrier || row.brand_name || '').trim();
  const transit = row.transit_hours != null
    ? Number(row.transit_hours)
    : (row.transit_time != null ? Number(row.transit_time) : null);
  return {
    id: `packlink:${id}`,
    packlinkId: id,
    label: carrier ? `${carrier} · ${name}` : name,
    serviceName: name,
    carrier,
    amountCents: cents,
    currency: 'EUR',
    tracked: true,
    transitHours: Number.isFinite(transit) ? transit : null,
    source: 'packlink',
  };
}

async function fetchPacklinkServices({
  fromCountry,
  toCountry,
  fromZip = '',
  toZip = '',
  cardCount = 1,
  signal,
} = {}) {
  const key = packlinkApiKey();
  if (!key) return [];

  const from = String(fromCountry || '').trim().toUpperCase();
  const to = String(toCountry || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(from) || !/^[A-Z]{2}$/.test(to)) return [];

  const tier = packageTierForCount(cardCount);
  const profile = TIER_PROFILE[tier] || TIER_PROFILE.MEDIUM;
  const params = new URLSearchParams();
  params.set('from[country]', from);
  params.set('from[zip]', String(fromZip || defaultZip(from)));
  params.set('to[country]', to);
  params.set('to[zip]', String(toZip || defaultZip(to)));
  params.set('packages[0][width]', String(profile.width));
  params.set('packages[0][height]', String(profile.height));
  params.set('packages[0][length]', String(profile.length));
  params.set('packages[0][weight]', String(profile.weight));

  const url = `${PACKLINK_BASE}/v1/services?${params}`;
  const response = await fetch(url, {
    headers: {
      Authorization: key,
      Accept: 'application/json',
    },
    signal,
  });
  if (!response.ok) {
    const err = new Error(`Packlink ${response.status}`);
    err.statusCode = response.status === 401 ? 502 : 502;
    throw err;
  }
  const data = await response.json();
  const rows = Array.isArray(data) ? data : [];
  return rows
    .map(normalizeService)
    .filter(Boolean)
    .sort((a, b) => a.amountCents - b.amountCents);
}

module.exports = {
  packlinkApiKey,
  defaultZip,
  packageTierForCount,
  normalizeService,
  fetchPacklinkServices,
  priceToEurCents,
  TIER_PROFILE,
  DEFAULT_ZIP,
};
