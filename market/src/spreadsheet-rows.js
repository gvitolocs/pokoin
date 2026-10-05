/**
 * Fast local read of a seller spreadsheet. Shows the cards immediately,
 * including a Power Tools location, without waiting on catalog matching.
 */

export const SPREADSHEET_PAGE = 100;

export const FORMAT_LABEL = Object.freeze({
  powertools: 'Power Tools',
  cardmarket: 'Cardmarket',
  cardtrader: 'CardTrader',
  tcgplayer: 'TCGPlayer',
  custom: 'Your spreadsheet',
});

const COLUMN_ALIASES = Object.freeze({
  name: ['name', 'card', 'cardname', 'productname', 'title', 'product', 'cardtitle'],
  setName: ['set', 'expansion', 'setname', 'edition', 'series'],
  number: ['cn', 'number', 'collector', 'collectornumber', 'cardnumber', 'no', 'num'],
  quantity: ['quantity', 'qty', 'count', 'totalquantity'],
  condition: ['condition', 'cond'],
  language: ['language', 'lang'],
  price: ['price', 'pricecents', 'cost', 'tcgmarketplaceprice', 'tcgmarketprice'],
  location: ['location', 'loc', 'box', 'bin', 'storage'],
});

function headerKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '');
}

export function detectSpreadsheetFormat(headers) {
  const set = new Set((headers || []).map(headerKey));
  if (set.has('cardmarketid') && (set.has('finishtype') || set.has('setcode'))) return 'powertools';
  if (set.has('blueprintid') || set.has('pricecents')) return 'cardtrader';
  if (set.has('idproduct') || (set.has('expansion') && set.has('isfoil'))) return 'cardmarket';
  if (
    set.has('tcgplayerid')
    || (set.has('productname') && set.has('setname') && (set.has('tcgmarketplaceprice') || set.has('totalquantity') || set.has('tcgmarketprice')))
  ) return 'tcgplayer';
  if (set.has('cardmarketid')) return 'powertools';
  return '';
}

function guessColumns(headers) {
  const keys = (headers || []).map(headerKey);
  const found = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const at = keys.findIndex((key) => aliases.includes(key));
    if (at >= 0) found[field] = at;
  }
  if (found.name == null) return null;
  if (found.setName == null && found.number == null) return null;
  return found;
}

function hasCardTraderLink(headers, records) {
  const keys = (headers || []).map(headerKey);
  if (keys.some((key) => key.includes('blueprint') || key.includes('cardtrader') || key === 'productid')) return true;
  for (const cols of (records || []).slice(0, 40)) {
    for (const cell of cols) {
      if (/cardtrader\.com/i.test(String(cell || ''))) return true;
    }
  }
  return false;
}

function parseCommaCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
          continue;
        }
        quotes = false;
        continue;
      }
      cell += ch;
      continue;
    }
    if (ch === '"') {
      quotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    if (row.some((value) => value !== '')) rows.push(row);
  }
  if (!rows.length) return { headers: [], records: [] };
  return { headers: rows[0].map((header) => header.trim()), records: rows.slice(1) };
}

function indexHeaders(headers) {
  const index = new Map();
  headers.forEach((header, at) => {
    const key = headerKey(header);
    if (!index.has(key)) index.set(key, at);
  });
  return index;
}

function pick(cols, index, ...keys) {
  for (const key of keys) {
    const at = index.get(key);
    if (at == null) continue;
    const value = cols[at];
    if (value != null && value !== '') return value;
  }
  return '';
}

function cardFrom(format, cols, index) {
  if (format === 'powertools') {
    return {
      name: pick(cols, index, 'name'),
      setName: pick(cols, index, 'set'),
      number: pick(cols, index, 'cn'),
      quantity: pick(cols, index, 'quantity') || '1',
      condition: pick(cols, index, 'condition'),
      language: pick(cols, index, 'language'),
      price: pick(cols, index, 'price'),
      location: pick(cols, index, 'location'),
    };
  }
  if (format === 'cardmarket') {
    return {
      name: pick(cols, index, 'name'),
      setName: pick(cols, index, 'expansion'),
      number: pick(cols, index, 'number'),
      quantity: pick(cols, index, 'quantity') || '1',
      condition: pick(cols, index, 'condition'),
      language: pick(cols, index, 'language'),
      price: pick(cols, index, 'price'),
      location: pick(cols, index, 'location'),
    };
  }
  if (format === 'cardtrader') {
    const cents = pick(cols, index, 'pricecents');
    return {
      name: pick(cols, index, 'name'),
      setName: pick(cols, index, 'expansion'),
      number: pick(cols, index, 'number'),
      quantity: pick(cols, index, 'quantity') || '1',
      condition: pick(cols, index, 'condition'),
      language: pick(cols, index, 'language'),
      price: cents ? (Number(cents) / 100).toFixed(2) : pick(cols, index, 'price'),
      location: pick(cols, index, 'location'),
    };
  }
  return {
    name: pick(cols, index, 'productname', 'title', 'name'),
    setName: pick(cols, index, 'setname', 'set'),
    number: pick(cols, index, 'number'),
    quantity: pick(cols, index, 'totalquantity', 'quantity') || '1',
    condition: pick(cols, index, 'condition'),
    language: pick(cols, index, 'language') || 'English',
    price: pick(cols, index, 'tcgmarketplaceprice', 'tcgmarketprice', 'price'),
    location: pick(cols, index, 'location'),
  };
}

function cardFromGuess(cols, guess) {
  const at = (field) => (guess[field] == null ? '' : (cols[guess[field]] || ''));
  return {
    name: at('name'),
    setName: at('setName'),
    number: at('number'),
    quantity: at('quantity') || '1',
    condition: at('condition'),
    language: at('language'),
    price: at('price'),
    location: at('location'),
  };
}

/** Parse a comma-CSV (already normalized) into cards for the table under the drop zone. */
export function previewSpreadsheet(csvText) {
  const { headers, records } = parseCommaCsv(csvText);
  let format = detectSpreadsheetFormat(headers);
  const guess = format ? null : guessColumns(headers);
  if (!format && guess) format = 'custom';
  if (!format) return { format: '', rows: [], hasLocation: false, cardtraderLinks: false };
  const index = indexHeaders(headers);
  const rows = [];
  for (const cols of records) {
    const card = format === 'custom' ? cardFromGuess(cols, guess) : cardFrom(format, cols, index);
    if (!card.name && !card.number) continue;
    rows.push(card);
  }
  let hasLocation = false;
  for (const row of rows) {
    if (row.location) {
      hasLocation = true;
      break;
    }
  }
  const cardtraderLinks = format === 'cardtrader' || hasCardTraderLink(headers, records);
  return { format, rows, hasLocation, cardtraderLinks };
}

export function importPayload(sheet) {
  if (!sheet || sheet.format === 'custom') {
    const lines = ['name,set,cn,quantity,condition,language,price,location'];
    for (const row of sheet?.rows || []) {
      lines.push([
        row.name, row.setName, row.number, row.quantity, row.condition, row.language, row.price, row.location,
      ].map((value) => {
        const text = value == null ? '' : String(value);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      }).join(','));
    }
    return { csv: `${lines.join('\n')}\n`, format: 'powertools' };
  }
  return { csv: sheet.csv, format: sheet.format };
}
