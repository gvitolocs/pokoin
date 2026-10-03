'use strict';

const { countryFromRequestHeaders } = require('./_client_country');

/**
 * Country for local marketplace links. This is the edge IP country, not the
 * buyer's shipping address: a Dane shopping from Italy should see ebay.it.
 * Unknown, Tor (T1), and the EU continent code stay empty so the client
 * opens the international site instead of guessing.
 */
module.exports = function clientCountry(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const country = countryFromRequestHeaders(req.headers);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vary', 'CF-IPCountry');
  return res.status(200).json({ country });
};
