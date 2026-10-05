'use strict';

function flagOn(value) {
  return value === '1' || value === 'true';
}

function flagOff(value) {
  return value === '0' || value === 'false';
}

function parseList(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback.slice();
  return raw.split(',').map((part) => part.trim().toUpperCase()).filter(Boolean);
}

/** Dry-run stays on until GOOGLE_MERCHANT_DRY_RUN=0, even when the integration is enabled. */
function merchantConfig(env = process.env) {
  const enabled = flagOn(env.GOOGLE_MERCHANT_ENABLED);
  const dryRun = !flagOff(env.GOOGLE_MERCHANT_DRY_RUN);
  return {
    enabled,
    dryRun,
    countries: parseList(env.GOOGLE_MERCHANT_COUNTRIES, ['DK', 'IT']),
    currencies: parseList(env.GOOGLE_MERCHANT_CURRENCIES, ['EUR', 'DKK']),
    accountId: String(env.GOOGLE_MERCHANT_ACCOUNT_ID || '').trim(),
    dataSourceId: String(env.GOOGLE_MERCHANT_DATA_SOURCE_ID || '').trim(),
    feedLabelEur: String(env.GOOGLE_MERCHANT_FEED_LABEL_EUR || 'EU').trim() || 'EU',
    feedLabelDkk: String(env.GOOGLE_MERCHANT_FEED_LABEL_DKK || 'DK').trim() || 'DK',
    siteOrigin: String(env.GOOGLE_MERCHANT_SITE_ORIGIN || 'https://pokoin.com').replace(/\/$/, ''),
    credentialsPath: String(env.GOOGLE_APPLICATION_CREDENTIALS || '').trim(),
    credentialsJson: String(env.GOOGLE_MERCHANT_CREDENTIALS_JSON || '').trim(),
  };
}

module.exports = { merchantConfig, parseList };
