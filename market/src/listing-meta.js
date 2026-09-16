import { flagSrc, getSearchLang, isSearchLang } from './locale.js';

const CONDITION_TONE = {
  NM: 'nm',
  M: 'nm',
  MINT: 'nm',
  NEARMINT: 'nm',
  'NEAR MINT': 'nm',
  EX: 'ex',
  EXCELLENT: 'ex',
  SP: 'sp',
  LP: 'sp',
  SLIGHTLYPLAYED: 'sp',
  'SLIGHTLY PLAYED': 'sp',
  LIGHTLYPLAYED: 'sp',
  'LIGHTLY PLAYED': 'sp',
  MP: 'mp',
  MODERATELYPLAYED: 'mp',
  'MODERATELY PLAYED': 'mp',
  PL: 'pl',
  PLAYED: 'pl',
  HP: 'hp',
  HEAVILYPLAYED: 'hp',
  'HEAVILY PLAYED': 'hp',
  POOR: 'poor',
  D: 'poor',
  DMG: 'poor',
  DAMAGED: 'poor',
};

const COUNTRY_LABEL = {
  IT: 'Italy',
  EU: 'Europe',
  US: 'United States',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  GB: 'United Kingdom',
  UK: 'United Kingdom',
  NL: 'Netherlands',
  PL: 'Poland',
  PT: 'Portugal',
  BE: 'Belgium',
  AT: 'Austria',
  CH: 'Switzerland',
  DK: 'Denmark',
  SE: 'Sweden',
  JP: 'Japan',
  KR: 'South Korea',
  CN: 'China',
  TW: 'Taiwan',
  ID: 'Indonesia',
  TH: 'Thailand',
  VN: 'Vietnam',
  AU: 'Australia',
  CA: 'Canada',
};

const COUNTRY_FLAG = {
  GB: 'en',
  UK: 'en',
  KR: 'ko',
  CN: 'zh',
  TW: 'zht',
  VN: 'vi',
};

export function listingSellerName(offer) {
  return String(offer?.sellerName || offer?.sellerDisplayName || '').trim();
}

export function isReserveSeller(offer) {
  const name = listingSellerName(offer).toLowerCase();
  const label = String(offer?.sellerReputationLabel || '').toLowerCase();
  return label === 'pknreserve' || name === 'pknreserve' || name === 'pokoin reserve';
}

export function sellerHandle(offer) {
  if (isReserveSeller(offer)) {
    return '';
  }
  const claimed = String(offer?.sellerUsername || '').trim().replace(/^@/, '');
  if (claimed && claimed.toLowerCase() !== 'pokoin' && claimed.toLowerCase() !== 'pknreserve') {
    return claimed;
  }
  const name = listingSellerName(offer);
  if (!name || name.toLowerCase() === 'pokoin') {
    return '';
  }
  return name.replace(/^@/, '').trim();
}

export function sellerHref(offer, lang = getSearchLang()) {
  const handle = sellerHandle(offer);
  if (!handle) return '';
  const code = isSearchLang(lang) ? String(lang).toLowerCase() : 'en';
  return `/marketplace/${code}/users/${encodeURIComponent(handle)}`;
}

export function conditionKey(condition) {
  return String(condition || '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toUpperCase();
}

export function conditionTone(condition) {
  const key = conditionKey(condition);
  if (!key) return '';
  if (CONDITION_TONE[key]) return CONDITION_TONE[key];
  const compact = key.replace(/\s+/g, '');
  return CONDITION_TONE[compact] || CONDITION_TONE[key.split(' ')[0]] || '';
}

export function conditionShort(condition) {
  const tone = conditionTone(condition);
  if (tone === 'nm') return 'NM';
  if (tone === 'ex') return 'EX';
  if (tone === 'sp') return 'SP';
  if (tone === 'mp') return 'MP';
  if (tone === 'pl') return 'PL';
  if (tone === 'hp') return 'HP';
  if (tone === 'poor') return 'Poor';
  const text = String(condition || '').trim();
  return text || 'NM';
}

export function listingLanguageCode(language) {
  const raw = String(language || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'ja' || raw === 'jpn') return 'jp';
  if (raw === 'zhs' || raw === 'cn') return 'zh';
  if (raw === 'zht' || raw === 'tw') return 'zht';
  if (isSearchLang(raw)) return raw;
  const two = raw.slice(0, 2);
  if (two === 'zh' && raw.includes('t')) return 'zht';
  return isSearchLang(two) ? two : '';
}

export function listingLanguageFlag(language) {
  const code = listingLanguageCode(language);
  if (!code) return null;
  return {
    code,
    src: flagSrc(code),
    label: code.toUpperCase(),
  };
}

export function sellerCountryCode(country) {
  const raw = String(country || '').trim().toUpperCase();
  if (!raw || raw === 'EU') return raw === 'EU' ? 'eu' : '';
  if (COUNTRY_FLAG[raw]) return COUNTRY_FLAG[raw];
  const lower = raw.toLowerCase();
  if (lower === 'europe' || lower === 'european union') return 'eu';
  if (isSearchLang(lower) || lower === 'eu' || lower === 'us') return lower;
  if (raw.length === 2) return lower;
  return '';
}

export function sellerCountryLabel(country) {
  const raw = String(country || '').trim().toUpperCase();
  if (!raw) return '';
  return COUNTRY_LABEL[raw] || raw;
}

export function sellerCountryFlag(country) {
  const code = sellerCountryCode(country);
  if (!code) return null;
  return {
    code,
    src: flagSrc(code),
    label: sellerCountryLabel(country) || code.toUpperCase(),
  };
}

export function listingExtraTags(offer) {
  const tags = [];
  if (offer?.reverse) tags.push('Reverse');
  if (offer?.firstEdition) tags.push('1st Ed.');
  if (offer?.sealed) tags.push('Sealed');
  if (offer?.graded) {
    tags.push([offer.gradingCompany, offer.grade].filter(Boolean).join(' ') || 'Graded');
  }
  if (offer?.signed) tags.push('Signed');
  if (offer?.reserveAvailable) tags.push('Reserve');
  if (offer?.nftAvailable) tags.push('NFT');
  return tags;
}
