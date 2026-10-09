// Card desk rules shared by the React desk (pages/Card.jsx) and the Solid
// port (solid/src/pages/Card.jsx): shop sorting, Best Deal matching, the
// listing form's defaults, share helpers. No framework imports.

import { cardFromCatalogRow } from './api.js';
import { continueBoxCursor } from './inventory-listings.js';
import { listingFoilOptions } from './listing-faces.js';
import { conditionShort } from './listing-meta.js';
import {
  defaultCardLanguage,
  getSearchLang,
  languagesForNationality,
  rewriteCatalogLang,
  searchLangFromPath,
} from './locale.js';

export const CONDITIONS = [
  { value: '', label: 'Any condition' },
  { value: 'NM', label: 'Near Mint' },
  { value: 'SP', label: 'Slightly Played' },
  { value: 'MP', label: 'Moderately Played' },
  { value: 'PL', label: 'Played' },
  { value: 'Poor', label: 'Poor' },
];

export const LIST_LANGS = [
  'EN', 'IT', 'FR', 'DE', 'ES', 'JP', 'PT', 'NL', 'PL', 'RU', 'KO', 'ZH', 'ZHT', 'ID', 'TH', 'VI',
];

/** Listing form condition grades — display is the /conditions/*.svg chip, not emoji. */
export const MOOD_CONDS = [
  { value: 'NM', label: 'Near Mint' },
  { value: 'SP', label: 'Slightly Played' },
  { value: 'MP', label: 'Moderately Played' },
  { value: 'PL', label: 'Played' },
  { value: 'Poor', label: 'Poor' },
];

/** Best Deal condition row, Poor through Near Mint. */
export const DEAL_CONDS = [
  { value: 'Poor', label: 'Poor' },
  { value: 'PL', label: 'Played' },
  { value: 'MP', label: 'Moderately Played' },
  { value: 'SP', label: 'Slightly Played' },
  { value: 'NM', label: 'Near Mint' },
];

export function catalogPrintings(rows) {
  return (rows || []).map(cardFromCatalogRow).filter((row) => row.id);
}

export function sortOffers(rows, key) {
  const list = [...(rows || [])];
  if (key === 'price-desc') {
    list.sort((a, b) => Number(b.pricePkn || 0) - Number(a.pricePkn || 0));
  } else if (key === 'qty') {
    list.sort((a, b) => Number(b.quantityAvailable || 0) - Number(a.quantityAvailable || 0));
  } else if (key === 'seller') {
    list.sort((a, b) => String(a.sellerName || '').localeCompare(String(b.sellerName || '')));
  } else {
    list.sort((a, b) => Number(a.pricePkn || 0) - Number(b.pricePkn || 0));
  }
  return list;
}

export function offerLang(offer) {
  if (!offer) {
    return '';
  }
  return String(offer.language || '').toUpperCase();
}

export function pricedOffers(rows) {
  return [...(rows || [])]
    .filter((offer) => Number(offer.pricePkn) > 0)
    .sort((a, b) => Number(a.pricePkn || 0) - Number(b.pricePkn || 0));
}

export function formatChange72h(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) {
    return { text: '72h —', empty: true };
  }
  const value = Number(pct) * 100;
  const sign = value > 0 ? '+' : '';
  return {
    text: `72h ${sign}${value.toFixed(1)}%`,
    empty: false,
    up: value >= 0,
  };
}

export function matchDeal(rows, language, condition) {
  return pricedOffers(rows).find((offer) => {
    if (language && offerLang(offer) !== language) {
      return false;
    }
    // Same grades as the condition chips: LP / Lightly Played is SP.
    if (condition && moodCondition(offer) !== condition) {
      return false;
    }
    return true;
  }) || null;
}

/** Next inventory slot for a box, or the bare box when it has no stack yet. */
export function nextBoxLocation(rows, box) {
  const name = String(box || '').trim();
  if (!name) return '';
  const cursor = continueBoxCursor(rows, name, 80);
  if (!cursor) return name;
  if (cursor.stackSize <= 1) return `${name}·${cursor.stack}`;
  return `${name}·${cursor.stack}·${cursor.startPosition}`;
}

export function defaultFoil(card, foils = listingFoilOptions()) {
  const hay = `${card?.rarity || ''} ${card?.name || ''} ${card?.variant || ''}`.toLowerCase();
  const allowed = new Set(foils.map((row) => row.value));
  if (allowed.has('reverse') && /\breverse\b/.test(hay)) return 'reverse';
  if (allowed.has('holo') && /\bholo\b/.test(hay)) return 'holo';
  if (allowed.has('foil') && /\bfoil\b/.test(hay)) return 'foil';
  return 'standard';
}

export function foilFromOffer(offer, card, foils = listingFoilOptions()) {
  const state = String(offer?.foilState || '').toLowerCase();
  if (foils.some((row) => row.value === state)) {
    return state;
  }
  if (offer?.reverse) {
    return 'reverse';
  }
  return defaultFoil(card, foils);
}

export function moodCondition(offer) {
  const short = conditionShort(offer?.condition) || 'NM';
  // conditionShort maps Poor → PO; the form still stores Pokoin value "Poor".
  if (short === 'PO') return 'Poor';
  return MOOD_CONDS.some((row) => row.value === short) ? short : 'NM';
}

export function offerLanguage(offer, card) {
  const raw = String(offer?.language || '').trim().toUpperCase();
  if (!raw) {
    return defaultCardLanguage(card?.nationality);
  }
  if (raw === 'JA' || raw === 'JPN') return 'JP';
  if (raw === 'CN' || raw === 'ZHS') return 'ZH';
  if (raw === 'TW') return 'ZHT';
  return raw;
}

export function blankListingForm(card) {
  return {
    price: '',
    currency: 'PKN',
    qty: '1',
    condition: 'NM',
    language: defaultCardLanguage(card?.nationality),
    foil: defaultFoil(card),
    chips: {
      firstEd: false,
      sealed: false,
      graded: false,
      shipping: true,
    },
    comment: '',
    company: 'PSA',
    grade: '',
    cert: '',
  };
}

export function listingFormFromOffer(offer, card) {
  return {
    price: offer?.pricePkn != null && offer?.pricePkn !== '' ? String(offer.pricePkn) : '',
    currency: 'PKN',
    qty: String(Math.max(1, Number(offer?.quantityAvailable) || 1)),
    condition: moodCondition(offer),
    language: offerLanguage(offer, card),
    foil: foilFromOffer(offer, card),
    chips: {
      firstEd: Boolean(offer?.firstEdition),
      sealed: Boolean(offer?.sealed),
      graded: Boolean(offer?.graded),
      shipping: offer?.shippingAvailable !== false,
    },
    comment: String(offer?.sellerComment || ''),
    company: String(offer?.gradingCompany || 'PSA'),
    grade: String(offer?.grade || ''),
    cert: String(offer?.certificationId || ''),
  };
}

export function listedDealLanguages(offers, card) {
  const codes = [...new Set((offers || []).map((row) => offerLanguage(row, card)).filter(Boolean))];
  const allowed = new Set(languagesForNationality(card?.nationality, codes));
  return LIST_LANGS.filter((code) => allowed.has(code));
}

export function listedDealConditions(offers) {
  const present = new Set((offers || []).map((row) => moodCondition(row)));
  return DEAL_CONDS.filter((row) => present.has(row.value));
}

export function canUseNativeShare() {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
    return false;
  }
  const ua = String(navigator.userAgent || '');
  if (/iPhone|iPad|iPod|Android/i.test(ua)) {
    return true;
  }
  return navigator.platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1;
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

export function cleanPath(path) {
  return String(path || '').split(/[?#]/)[0].replace(/\/$/, '') || '/';
}

/** Canonical path to replace the URL with, or '' when the router is already there. */
export function canonicalTarget(path, routerPath) {
  const here = cleanPath(routerPath || (typeof window === 'undefined' ? '' : window.location.pathname));
  const titleLang = searchLangFromPath(here) || getSearchLang();
  const next = cleanPath(rewriteCatalogLang(path, titleLang));
  if (!next || next === here) {
    return '';
  }
  return next;
}
