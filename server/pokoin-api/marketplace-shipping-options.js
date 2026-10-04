'use strict';

/**
 * GET /api/marketplace-shipping-options
 * Live Packlink carrier list for a seller→buyer lane, merged with the seeded
 * letter rates (tracked / untracked) so the cart can show every bookable option.
 *
 * Query: fromCountry, toCountry, cards, fromZip?, toZip?
 */

const ratesCatalog = require('./shipping-rates.json');
const {
  fetchPacklinkServices,
  packlinkApiKey,
  packageTierForCount,
} = require('./_packlink');

function iso(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== 'EU' ? code : '';
}

function seedLetterOptions({ fromCountry, toCountry, cardCount }) {
  const from = iso(fromCountry);
  const to = iso(toCountry);
  const n = Math.max(0, Math.trunc(Number(cardCount) || 0));
  const tier = packageTierForCount(n);
  if (!from || !to || n < 1) return [];

  const matches = (ratesCatalog.rates || []).filter((rate) => (
    rate.active !== false
    && String(rate.fromCountry).toUpperCase() === from
    && String(rate.toCountry).toUpperCase() === to
    && String(rate.packageTier).toUpperCase() === tier
  ));

  const options = [];
  for (const wantTracked of [false, true]) {
    const row = matches.find((rate) => (rate.tracked !== false) === wantTracked)
      || (wantTracked ? matches.find((rate) => rate.tracked !== false) : null);
    if (!row) continue;
    const id = row.tracked !== false ? 'tracked' : 'untracked';
    if (options.some((option) => option.id === id)) continue;
    options.push({
      id,
      label: row.tracked !== false ? 'Tracked letter' : 'Untracked letter',
      serviceName: row.serviceName || 'Letter',
      carrier: row.carrier || '',
      amountCents: Number(row.priceEURCents) || 0,
      currency: 'EUR',
      tracked: row.tracked !== false,
      packageTier: tier,
      source: 'seed',
    });
  }
  return options;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      return res.status(204).end();
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, OPTIONS');
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    const url = new URL(req.url, 'https://api.pokoin.com');
    const fromCountry = iso(url.searchParams.get('fromCountry') || url.searchParams.get('from'));
    const toCountry = iso(url.searchParams.get('toCountry') || url.searchParams.get('to'));
    const cards = Math.max(0, Math.trunc(Number(url.searchParams.get('cards') || url.searchParams.get('cardCount')) || 0));
    const fromZip = String(url.searchParams.get('fromZip') || '').trim();
    const toZip = String(url.searchParams.get('toZip') || '').trim();

    if (!fromCountry || !toCountry || cards < 1) {
      return res.status(400).json({ error: 'fromCountry, toCountry and cards are required.' });
    }

    const letters = seedLetterOptions({ fromCountry, toCountry, cardCount: cards });
    let packlink = [];
    let packlinkError = '';
    if (packlinkApiKey()) {
      try {
        packlink = await fetchPacklinkServices({
          fromCountry,
          toCountry,
          fromZip,
          toZip,
          cardCount: cards,
        });
      } catch (error) {
        packlinkError = error.message || 'Packlink unavailable';
        console.error('marketplace-shipping-options packlink', packlinkError);
      }
    }

    const options = [...letters, ...packlink];
    res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=600');
    return res.status(200).json({
      fromCountry,
      toCountry,
      cards,
      packageTier: packageTierForCount(cards),
      options,
      sources: {
        seed: letters.length > 0,
        packlink: packlink.length > 0,
        packlinkConfigured: Boolean(packlinkApiKey()),
        packlinkError: packlinkError || null,
      },
    });
  } catch (error) {
    console.error('marketplace-shipping-options failed', error?.message || error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Shipping options failed.' });
  }
};

module.exports._test = {
  seedLetterOptions,
  iso,
};
