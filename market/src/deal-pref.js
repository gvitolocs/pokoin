import { readAuthSession } from './auth-session.js';

const DEVICE_KEY = 'pokoin.dealLanguage';

/** Account country → a listing language. Denmark has no Danish card language. */
const COUNTRY_LISTING_LANG = {
  IT: 'IT',
  FR: 'FR',
  DE: 'DE',
  ES: 'ES',
  PT: 'PT',
  NL: 'NL',
  PL: 'PL',
  JP: 'JP',
  KR: 'KO',
  CN: 'ZH',
  TW: 'ZHT',
  HK: 'ZHT',
  ID: 'ID',
  TH: 'TH',
  VN: 'VI',
  RU: 'RU',
  GB: 'EN',
  UK: 'EN',
  US: 'EN',
  AU: 'EN',
  CA: 'EN',
  IE: 'EN',
};

function accountUid(uid) {
  if (uid !== undefined) return String(uid || '').trim();
  return String(readAuthSession()?.uid || '').trim();
}

function readStored(storage, key) {
  try {
    return String(storage?.getItem?.(key) || '').trim().toUpperCase();
  } catch (_) {
    return '';
  }
}

function writeStored(storage, key, value) {
  try {
    storage?.setItem?.(key, value);
  } catch (_) {
    /* private mode */
  }
}

export function listingLanguageForCountry(country) {
  return COUNTRY_LISTING_LANG[String(country || '').trim().toUpperCase()] || '';
}

/** Last language this account chose, else the last one on this browser, else EN. */
export function readDealLanguage(uid, storage = globalThis.localStorage) {
  const id = accountUid(uid);
  if (id) {
    const own = readStored(storage, `${DEVICE_KEY}:${id}`);
    if (own) return own;
  }
  return readStored(storage, DEVICE_KEY) || 'EN';
}

export function writeDealLanguage(lang, uid, storage = globalThis.localStorage) {
  const code = String(lang || '').trim().toUpperCase();
  if (!code) return;
  writeStored(storage, DEVICE_KEY, code);
  const id = accountUid(uid);
  if (id) writeStored(storage, `${DEVICE_KEY}:${id}`, code);
}

/**
 * Language chip for this card. The saved choice (or EN) stays put.
 * It moves only when that language has no listing and the account country
 * has one — Italy → IT. An empty list means the desk is still loading.
 */
export function resolveDealLanguage({ selected = 'EN', listed = [], country = '' } = {}) {
  const lang = String(selected || 'EN').trim().toUpperCase() || 'EN';
  const have = new Set((listed || []).map((code) => String(code || '').toUpperCase()).filter(Boolean));
  if (!have.size || have.has(lang)) return lang;
  const fromCountry = listingLanguageForCountry(country);
  if (fromCountry && have.has(fromCountry)) return fromCountry;
  return lang;
}
