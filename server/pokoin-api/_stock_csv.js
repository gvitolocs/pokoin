'use strict';

/**
 * Stock CSV import/export mappers (PowerTools, Cardmarket, CardTrader).
 * Pure helpers — no DB / Firebase. Spec: docs/STOCK_CSV.md (pokoin-web).
 */

const POWERTOOLS_HEADERS = Object.freeze([
  'cardmarketId', 'quantity', 'name', 'set', 'setCode', 'cn', 'condition', 'language',
  'isFirstEd', 'isReverseHolo', 'isSigned', 'finishType', 'price', 'comment', 'location',
  'nameDE', 'nameES', 'nameFR', 'nameIT', 'rarity', 'listedAt', 'countryEdition',
]);

/** Cardmarket-compatible stock columns (seller CSV). */
const CARDMARKET_HEADERS = Object.freeze([
  'idProduct', 'quantity', 'name', 'expansion', 'number', 'language', 'condition',
  'isFoil', 'isReverseHolo', 'isSigned', 'isFirstEd', 'isAltered', 'price', 'comment', 'location',
]);

/** CardTrader-oriented stock columns (blueprint + optional product id). */
const CARDTRADER_HEADERS = Object.freeze([
  'blueprint_id', 'product_id', 'quantity', 'price_cents', 'currency', 'name', 'expansion',
  'number', 'condition', 'language', 'foil', 'reverse', 'first_edition', 'signed', 'altered',
  'comment', 'location',
]);

const FORMATS = Object.freeze(['powertools', 'cardmarket', 'cardtrader']);

/** PT / CM condition scale → Pokoin listing conditions (scan desk set). */
const CONDITION_FROM_CM = Object.freeze({
  mt: 'NM', mint: 'NM', nm: 'NM', 'near mint': 'NM',
  ex: 'SP', 'excellent': 'SP', sp: 'SP', 'slightly played': 'SP',
  gd: 'MP', good: 'MP', mp: 'MP', 'moderately played': 'MP',
  lp: 'MP', 'lightly played': 'MP',
  pl: 'PL', 'played': 'PL', hp: 'PL', 'heavily played': 'PL',
  po: 'Poor', poor: 'Poor',
});

const CONDITION_TO_CM = Object.freeze({
  NM: 'NM', SP: 'EX', MP: 'GD', PL: 'PL', Poor: 'PO',
  LP: 'LP', HP: 'PL', EX: 'EX', GD: 'GD', PO: 'PO',
});

/** CT English condition labels ↔ Pokoin. */
const CONDITION_FROM_CT = Object.freeze({
  mint: 'NM', 'near mint': 'NM', nm: 'NM',
  'slightly played': 'SP', sp: 'SP',
  'moderately played': 'MP', mp: 'MP',
  'lightly played': 'MP', lp: 'MP',
  played: 'PL', 'heavily played': 'PL', hp: 'PL', pl: 'PL',
  poor: 'Poor', po: 'Poor',
});

const CONDITION_TO_CT = Object.freeze({
  NM: 'Near Mint', SP: 'Slightly Played', MP: 'Moderately Played',
  PL: 'Heavily Played', Poor: 'Poor', LP: 'Lightly Played', HP: 'Heavily Played',
});

const LANG_FROM_NAME = Object.freeze({
  english: 'EN', en: 'EN', italian: 'IT', it: 'IT', german: 'DE', de: 'DE',
  french: 'FR', fr: 'FR', spanish: 'ES', es: 'ES', portuguese: 'PT', pt: 'PT',
  japanese: 'JP', jp: 'JP', ja: 'JP', korean: 'KO', ko: 'KO', kr: 'KO',
  chinese: 'ZH', zh: 'ZH', 'chinese (trad.)': 'ZHT', 'chinese traditional': 'ZHT', zht: 'ZHT',
  dutch: 'NL', nl: 'NL', polish: 'PL', pl: 'PL', russian: 'RU', ru: 'RU',
  indonesian: 'ID', id: 'ID', thai: 'TH', th: 'TH', vietnamese: 'VI', vi: 'VI',
});

const LANG_TO_NAME = Object.freeze({
  EN: 'English', IT: 'Italian', DE: 'German', FR: 'French', ES: 'Spanish',
  PT: 'Portuguese', JP: 'Japanese', KO: 'Korean', ZH: 'Chinese', ZHT: 'Chinese (Trad.)',
  NL: 'Dutch', PL: 'Polish', RU: 'Russian', ID: 'Indonesian', TH: 'Thai', VI: 'Vietnamese',
});

/** 1 EUR = 200 PKN (same ratio as CardTrader inventory sync tests). */
const EUR_TO_PKN = 200;

function cleanText(value, max = 240) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function truthyFlag(value) {
  const t = String(value ?? '').trim().toLowerCase();
  return t === 'true' || t === '1' || t === 'yes' || t === 'y' || t === 'x';
}

function mapConditionFromCm(raw) {
  const key = cleanText(raw, 40).toLowerCase();
  return CONDITION_FROM_CM[key] || 'NM';
}

function mapConditionToCm(pokoin) {
  return CONDITION_TO_CM[cleanText(pokoin, 20)] || 'NM';
}

function mapConditionFromCt(raw) {
  const key = cleanText(raw, 40).toLowerCase();
  return CONDITION_FROM_CT[key] || mapConditionFromCm(raw);
}

function mapConditionToCt(pokoin) {
  return CONDITION_TO_CT[cleanText(pokoin, 20)] || 'Near Mint';
}

function mapLanguageFromName(raw) {
  const key = cleanText(raw, 40).toLowerCase();
  if (/^[A-Z]{2,3}$/i.test(key) && LANG_TO_NAME[key.toUpperCase()]) return key.toUpperCase();
  return LANG_FROM_NAME[key] || 'EN';
}

function mapLanguageToName(code) {
  return LANG_TO_NAME[cleanText(code, 10).toUpperCase()] || 'English';
}

/**
 * finishType / foil flags → { foilState, reverse, variantState }.
 */
function mapFinishFromPowerTools({ finishType, isReverseHolo } = {}) {
  const finish = cleanText(finishType, 40);
  const reverseFlag = truthyFlag(isReverseHolo) || /reverse/i.test(finish);
  const lower = finish.toLowerCase();
  let foilState = 'standard';
  let variantState = '';
  if (/master\s*ball/i.test(finish)) {
    foilState = reverseFlag ? 'reverse' : 'holo';
    variantState = 'masterball';
  } else if (/pok[eé]\s*ball/i.test(finish)) {
    foilState = reverseFlag ? 'reverse' : 'holo';
    variantState = 'pokeball';
  } else if (/cosmos/i.test(finish)) {
    foilState = 'holo';
    variantState = 'cosmos';
  } else if (/ice\s*crack/i.test(finish)) {
    foilState = 'holo';
    variantState = 'icecracked';
  } else if (/stamp/i.test(finish)) {
    foilState = 'stamped';
  } else if (/promo/i.test(finish)) {
    foilState = 'promo';
  } else if (reverseFlag || lower === 'reverseholo') {
    foilState = 'reverse';
  } else if (/holo/i.test(finish) && !/reverse/i.test(finish)) {
    foilState = 'holo';
  }
  return {
    foilState,
    reverse: foilState === 'reverse' || reverseFlag,
    variantState,
  };
}

function mapFinishToPowerTools({ foilState, reverse, variantState } = {}) {
  const variant = cleanText(variantState, 40).toLowerCase();
  const foil = cleanText(foilState, 40).toLowerCase();
  const isReverse = reverse === true || foil === 'reverse';
  if (variant === 'masterball') {
    return { finishType: isReverse ? 'ReverseMasterballHolo' : 'MasterballHolo', isReverseHolo: isReverse };
  }
  if (variant === 'pokeball') {
    return { finishType: isReverse ? 'ReversePokeballHolo' : 'PokeballHolo', isReverseHolo: isReverse };
  }
  if (variant === 'cosmos') return { finishType: 'CosmosHolo', isReverseHolo: false };
  if (variant === 'icecracked') return { finishType: 'IceCrackedHolo', isReverseHolo: false };
  if (foil === 'stamped') return { finishType: 'StampedHolo', isReverseHolo: false };
  if (foil === 'promo') return { finishType: 'Promo', isReverseHolo: false };
  if (isReverse || foil === 'reverse') return { finishType: 'ReverseHolo', isReverseHolo: true };
  if (foil === 'holo') return { finishType: 'Holo', isReverseHolo: false };
  return { finishType: 'Regular', isReverseHolo: false };
}

/**
 * Parse a location string into { box, stack, position }.
 * Accepts: `box·2·5`, `box·3`, `box-2-5`, trailing ` #3`, or bare box.
 */
function parseLocation(raw) {
  const text = cleanText(raw, 120);
  if (!text) return { box: '', stack: 1, position: 1 };
  const mid = text.match(/^(.+?)[·•](\d+)(?:[·•](\d+))?$/);
  if (mid) {
    return {
      box: cleanText(mid[1], 64),
      stack: clampInt(mid[2], 1, 9999, 1),
      position: clampInt(mid[3] || 1, 1, 9999, 1),
    };
  }
  const dash = text.match(/^(.+?)[\s_-]+(\d+)[\s_-]+(\d+)$/);
  if (dash && !/^\d+$/.test(dash[1])) {
    // Ambiguous with box names like "FUOCOBOMBA 006 - 16" — treat as bare box.
    return { box: text, stack: 1, position: 1 };
  }
  const hash = text.match(/^(.+?)\s*#\s*(\d+)$/);
  if (hash) {
    return { box: cleanText(hash[1], 64), stack: clampInt(hash[2], 1, 9999, 1), position: 1 };
  }
  return { box: text, stack: 1, position: 1 };
}

/** Encode listing location for Pokoin (matches scan slotText). */
function formatListingLocation({ box, stack, position, stackSize = 1 } = {}) {
  const loc = cleanText(box, 64);
  if (!loc) return '';
  const size = Math.max(1, Math.trunc(Number(stackSize)) || 1);
  const s = Math.max(1, Math.trunc(Number(stack)) || 1);
  const p = Math.max(1, Math.trunc(Number(position)) || 1);
  if (size === 1) return `${loc}·${s}`;
  return `${loc}·${s}·${p}`;
}

/**
 * Assign stack/position within each box for a list of rows (file order).
 * Mutates nothing — returns new array of { ...row, box, stack, position, location }.
 */
function assignStackPositions(rows, stackSize = 1) {
  const size = Math.max(1, Math.trunc(Number(stackSize)) || 1);
  const counters = new Map(); // box -> last abs index
  return (rows || []).map((row) => {
    const parsed = parseLocation(row.location || row.box || '');
    // If the string already had ·stack·pos, keep it unless stackSize forces remap.
    const hadStructured = /[·•]\d+/.test(String(row.location || ''));
    let stack = parsed.stack;
    let position = parsed.position;
    const box = parsed.box || cleanText(row.location, 64) || 'box';
    if (!hadStructured || size === 1) {
      const nextAbs = (counters.get(box) || 0) + 1;
      counters.set(box, nextAbs);
      if (size === 1) {
        stack = nextAbs;
        position = 1;
      } else {
        stack = Math.floor((nextAbs - 1) / size) + 1;
        position = ((nextAbs - 1) % size) + 1;
      }
    } else {
      const abs = (stack - 1) * size + Math.min(size, position);
      counters.set(box, Math.max(counters.get(box) || 0, abs));
    }
    return {
      ...row,
      box,
      stack,
      position,
      stackSize: size,
      location: formatListingLocation({ box, stack, position, stackSize: size }),
    };
  });
}

function priceToPkn(raw, { priceMode = 'eur_to_pkn', currency = 'EUR' } = {}) {
  const n = Number(String(raw ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (priceMode === 'as_pkn') return n;
  if (priceMode === 'cents_eur_to_pkn') return (n / 100) * EUR_TO_PKN;
  const cur = cleanText(currency, 8).toUpperCase() || 'EUR';
  if (cur === 'PKN') return n;
  // EUR (and unknown) → PKN
  return n * EUR_TO_PKN;
}

function pknToEur(pkn) {
  const n = Number(pkn);
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.round((n / EUR_TO_PKN) * 100) / 100);
}

function pknToCents(pkn) {
  const eur = Number(pknToEur(pkn));
  if (!Number.isFinite(eur) || eur <= 0) return '';
  return String(Math.round(eur * 100));
}

/** Minimal CSV parse (RFC4180-ish): commas, quotes, CRLF. */
function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let i = 0;
  let inQuotes = false;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    if (row.some((c) => c !== '')) rows.push(row);
  }
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => cleanText(h, 80));
  const records = rows.slice(1).map((cols) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx] == null ? '' : String(cols[idx]);
    });
    return obj;
  });
  return { headers, records };
}

function escapeCsvCell(value) {
  const text = value == null ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(headers, rows) {
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows || []) {
    lines.push(headers.map((h) => escapeCsvCell(row[h])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function detectFormat(headers = []) {
  const set = new Set((headers || []).map((h) => h.trim()));
  if (set.has('cardmarketId') && set.has('finishType')) return 'powertools';
  if (set.has('blueprint_id') || set.has('price_cents')) return 'cardtrader';
  if (set.has('idProduct') || (set.has('expansion') && set.has('isFoil'))) return 'cardmarket';
  if (set.has('cardmarketId')) return 'powertools';
  return null;
}

function normalizeImportRow(format, raw, options = {}) {
  const priceMode = options.priceMode || 'eur_to_pkn';
  if (format === 'powertools') {
    const finish = mapFinishFromPowerTools(raw);
    const pricePkn = priceToPkn(raw.price, { priceMode });
    return {
      format,
      externalId: cleanText(raw.cardmarketId, 40),
      cardmarketId: cleanText(raw.cardmarketId, 40),
      quantity: clampInt(raw.quantity, 1, 99, 1),
      name: cleanText(raw.name, 240),
      setName: cleanText(raw.set, 240),
      setCode: cleanText(raw.setCode, 40),
      collectorNumber: cleanText(raw.cn, 40),
      condition: mapConditionFromCm(raw.condition),
      language: mapLanguageFromName(raw.language),
      firstEdition: truthyFlag(raw.isFirstEd),
      signed: truthyFlag(raw.isSigned),
      altered: false,
      ...finish,
      pricePkn,
      sellerComment: cleanText(raw.comment, 500),
      location: cleanText(raw.location, 120),
      rarity: cleanText(raw.rarity, 80),
    };
  }
  if (format === 'cardmarket') {
    const reverse = truthyFlag(raw.isReverseHolo);
    const foil = truthyFlag(raw.isFoil);
    return {
      format,
      externalId: cleanText(raw.idProduct, 40),
      cardmarketId: cleanText(raw.idProduct, 40),
      quantity: clampInt(raw.quantity, 1, 99, 1),
      name: cleanText(raw.name, 240),
      setName: cleanText(raw.expansion, 240),
      setCode: '',
      collectorNumber: cleanText(raw.number, 40),
      condition: mapConditionFromCm(raw.condition),
      language: mapLanguageFromName(raw.language),
      firstEdition: truthyFlag(raw.isFirstEd),
      signed: truthyFlag(raw.isSigned),
      altered: truthyFlag(raw.isAltered),
      foilState: reverse ? 'reverse' : foil ? 'holo' : 'standard',
      reverse,
      variantState: '',
      pricePkn: priceToPkn(raw.price, { priceMode }),
      sellerComment: cleanText(raw.comment, 500),
      location: cleanText(raw.location, 120),
      rarity: '',
    };
  }
  if (format === 'cardtrader') {
    const reverse = truthyFlag(raw.reverse) || cleanText(raw.foil, 40).toLowerCase() === 'reverse';
    const pricePkn = raw.price_cents !== undefined && raw.price_cents !== ''
      ? priceToPkn(raw.price_cents, { priceMode: 'cents_eur_to_pkn' })
      : priceToPkn(raw.price, { priceMode, currency: raw.currency });
    return {
      format,
      externalId: cleanText(raw.product_id || raw.blueprint_id, 40),
      blueprintId: cleanText(raw.blueprint_id, 40),
      productId: cleanText(raw.product_id, 40),
      quantity: clampInt(raw.quantity, 1, 99, 1),
      name: cleanText(raw.name, 240),
      setName: cleanText(raw.expansion, 240),
      setCode: '',
      collectorNumber: cleanText(raw.number, 40),
      condition: mapConditionFromCt(raw.condition),
      language: mapLanguageFromName(raw.language),
      firstEdition: truthyFlag(raw.first_edition),
      signed: truthyFlag(raw.signed),
      altered: truthyFlag(raw.altered),
      foilState: reverse ? 'reverse' : cleanText(raw.foil, 40).toLowerCase() === 'holo' ? 'holo' : 'standard',
      reverse,
      variantState: '',
      pricePkn,
      sellerComment: cleanText(raw.comment, 500),
      location: cleanText(raw.location, 120),
      rarity: '',
    };
  }
  throw Object.assign(new Error(`Unknown format: ${format}`), { statusCode: 400 });
}

function listingToExportRow(format, listing = {}) {
  const location = cleanText(listing.location, 120);
  const qty = clampInt(listing.quantityAvailable ?? listing.quantity, 1, 99, 1);
  if (format === 'powertools') {
    const finish = mapFinishToPowerTools(listing);
    return {
      cardmarketId: cleanText(listing.cardmarketId || '', 40),
      quantity: String(qty),
      name: cleanText(listing.cardName || listing.name, 240),
      set: cleanText(listing.setName, 240),
      setCode: cleanText(listing.setCode, 40),
      cn: cleanText(listing.collectorNumber, 40).replace(/\/.*$/, '').replace(/^.*\|\s*/, ''),
      condition: mapConditionToCm(listing.condition),
      language: mapLanguageToName(listing.language),
      isFirstEd: listing.firstEdition ? 'true' : '',
      isReverseHolo: finish.isReverseHolo ? 'true' : '',
      isSigned: listing.signed ? 'true' : '',
      finishType: finish.finishType,
      price: pknToEur(listing.pricePkn),
      comment: cleanText(listing.sellerComment, 500),
      location,
      nameDE: '',
      nameES: '',
      nameFR: '',
      nameIT: '',
      rarity: '',
      listedAt: '',
      countryEdition: '',
    };
  }
  if (format === 'cardmarket') {
    return {
      idProduct: cleanText(listing.cardmarketId || '', 40),
      quantity: String(qty),
      name: cleanText(listing.cardName || listing.name, 240),
      expansion: cleanText(listing.setName, 240),
      number: cleanText(listing.collectorNumber, 40),
      language: mapLanguageToName(listing.language),
      condition: mapConditionToCm(listing.condition),
      isFoil: listing.foilState && listing.foilState !== 'standard' ? 'true' : '',
      isReverseHolo: listing.reverse || listing.foilState === 'reverse' ? 'true' : '',
      isSigned: listing.signed ? 'true' : '',
      isFirstEd: listing.firstEdition ? 'true' : '',
      isAltered: listing.altered ? 'true' : '',
      price: pknToEur(listing.pricePkn),
      comment: cleanText(listing.sellerComment, 500),
      location,
    };
  }
  if (format === 'cardtrader') {
    return {
      blueprint_id: cleanText(listing.blueprintId || listing.cardId, 40),
      product_id: cleanText(listing.ctProductId || listing.productId, 40),
      quantity: String(qty),
      price_cents: pknToCents(listing.pricePkn),
      currency: 'EUR',
      name: cleanText(listing.cardName || listing.name, 240),
      expansion: cleanText(listing.setName, 240),
      number: cleanText(listing.collectorNumber, 40),
      condition: mapConditionToCt(listing.condition),
      language: cleanText(listing.language, 10).toLowerCase() || 'en',
      foil: listing.foilState === 'holo' ? 'holo' : listing.foilState === 'reverse' || listing.reverse ? 'reverse' : '',
      reverse: listing.reverse || listing.foilState === 'reverse' ? 'true' : '',
      first_edition: listing.firstEdition ? 'true' : '',
      signed: listing.signed ? 'true' : '',
      altered: listing.altered ? 'true' : '',
      comment: cleanText(listing.sellerComment, 500),
      location,
    };
  }
  throw Object.assign(new Error(`Unknown format: ${format}`), { statusCode: 400 });
}

function headersFor(format) {
  if (format === 'powertools') return [...POWERTOOLS_HEADERS];
  if (format === 'cardmarket') return [...CARDMARKET_HEADERS];
  if (format === 'cardtrader') return [...CARDTRADER_HEADERS];
  throw Object.assign(new Error(`Unknown format: ${format}`), { statusCode: 400 });
}

function exportListingsCsv(format, listings) {
  const headers = headersFor(format);
  const rows = (listings || []).map((l) => listingToExportRow(format, l));
  return toCsv(headers, rows);
}

function importCsvText(text, options = {}) {
  const { headers, records } = parseCsv(text);
  const format = options.format || detectFormat(headers);
  if (!format || !FORMATS.includes(format)) {
    throw Object.assign(new Error('Unrecognized CSV format. Use powertools, cardmarket, or cardtrader.'), {
      statusCode: 400,
    });
  }
  const normalized = records.map((raw, index) => {
    try {
      const row = normalizeImportRow(format, raw, options);
      return { ok: true, index: index + 2, row, raw };
    } catch (error) {
      return { ok: false, index: index + 2, error: error.message || 'Invalid row', raw };
    }
  });
  const withSlots = assignStackPositions(
    normalized.filter((r) => r.ok).map((r) => r.row),
    options.stackSize ?? 1,
  );
  let slotIdx = 0;
  const results = normalized.map((entry) => {
    if (!entry.ok) return entry;
    const row = withSlots[slotIdx++];
    return { ...entry, row };
  });
  return { format, headers, results };
}

function sourceForFormat(format) {
  if (format === 'powertools') return 'powertools_csv_import';
  if (format === 'cardmarket') return 'cardmarket_csv_import';
  if (format === 'cardtrader') return 'cardtrader_csv_import';
  return 'stock_csv_import';
}

function sourceListingIdFor(format, row) {
  const id = cleanText(row.externalId || row.cardmarketId || row.productId || row.blueprintId, 80);
  if (!id) return '';
  const prefix = format === 'powertools' ? 'pt' : format === 'cardmarket' ? 'cm' : 'ct';
  return `${prefix}:${id}:${row.condition}:${row.language}:${row.foilState}:${row.location}`.slice(0, 160);
}

module.exports = {
  POWERTOOLS_HEADERS,
  CARDMARKET_HEADERS,
  CARDTRADER_HEADERS,
  FORMATS,
  EUR_TO_PKN,
  cleanText,
  clampInt,
  truthyFlag,
  mapConditionFromCm,
  mapConditionToCm,
  mapConditionFromCt,
  mapConditionToCt,
  mapLanguageFromName,
  mapLanguageToName,
  mapFinishFromPowerTools,
  mapFinishToPowerTools,
  parseLocation,
  formatListingLocation,
  assignStackPositions,
  priceToPkn,
  pknToEur,
  pknToCents,
  parseCsv,
  toCsv,
  detectFormat,
  normalizeImportRow,
  listingToExportRow,
  headersFor,
  exportListingsCsv,
  importCsvText,
  sourceForFormat,
  sourceListingIdFor,
};
