/**
 * Turn a seller spreadsheet into comma-CSV text the stock importer accepts.
 * .csv / .txt stay text (semicolon and tab exports are rewritten).
 * .xlsx / .xlsm / .ods / SpreadsheetML .xml become CSV from the first sheet.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_COLS = 80;

export const SPREADSHEET_ACCEPT = '.txt,.csv,.xls,.xlsx,.xlsm,.ods,.xml';
export const SPREADSHEET_TYPES_LABEL = '.txt .csv .xls .xlsx .xlsm .ods .xml';

function extOf(name) {
  const base = String(name || '').trim().toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1) : '';
}

function decodeXml(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeCsvCell(value) {
  const text = value == null ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function rowsToCsv(rows) {
  const body = (rows || [])
    .filter((row) => (row || []).some((cell) => String(cell || '').trim() !== ''))
    .slice(0, MAX_ROWS)
    .map((row) => row.slice(0, MAX_COLS).map(escapeCsvCell).join(','));
  if (!body.length) return '';
  return `${body.join('\n')}\n`;
}

function countDelim(line, delim) {
  let n = 0;
  let quotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quotes && line[i + 1] === '"') {
        i += 1;
        continue;
      }
      quotes = !quotes;
      continue;
    }
    if (!quotes && ch === delim) n += 1;
  }
  return n;
}

function parseDelim(text, delim) {
  const rows = [];
  let row = [];
  let cell = '';
  let quotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
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
    if (ch === delim) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    if (row.some((c) => c !== '')) rows.push(row);
  }
  return rows;
}

/** European Excel (;) and TSV become the comma CSV the importer parses. */
export function normalizeDelimited(text) {
  const src = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!src) return '';
  const first = src.split(/\r?\n/, 1)[0];
  const commas = countDelim(first, ',');
  const semis = countDelim(first, ';');
  const tabs = countDelim(first, '\t');
  const delim = semis > commas && semis >= tabs ? ';' : (tabs > commas ? '\t' : ',');
  if (delim === ',') return `${src}\n`;
  return rowsToCsv(parseDelim(src, delim));
}

function findEocd(bytes) {
  const min = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      return i;
    }
  }
  return -1;
}

async function inflateRaw(data) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot read compressed spreadsheets. Export CSV and upload that.');
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes);
  if (eocd < 0) throw new Error('That file is not a spreadsheet workbook.');
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const files = new Map();
  for (let n = 0; n < count; n += 1) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compSize = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localOff = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    cursor += 46 + nameLen + extraLen + commentLen;
    if (!name || name.endsWith('/')) continue;
    if (localOff + 30 > bytes.length || view.getUint32(localOff, true) !== 0x04034b50) continue;
    const localName = view.getUint16(localOff + 26, true);
    const localExtra = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + localName + localExtra;
    const slice = bytes.subarray(start, start + compSize);
    let out = slice;
    if (method === 8) out = await inflateRaw(slice);
    else if (method !== 0) throw new Error('This workbook uses a compression Pokoin cannot read. Export CSV.');
    files.set(name.replace(/\\/g, '/'), out);
  }
  if (!files.size) throw new Error('That workbook has no sheets.');
  return files;
}

function textOf(bytes) {
  return new TextDecoder().decode(bytes);
}

function sharedStrings(xml) {
  const out = [];
  for (const part of String(xml || '').split(/<si\b[^>]*>/i).slice(1)) {
    const body = part.split(/<\/si>/i)[0];
    const texts = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((m) => decodeXml(m[1]));
    out.push(texts.join(''));
  }
  return out;
}

function colIndex(ref) {
  const letters = String(ref || '').replace(/\d/g, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function rowIndex(ref) {
  const n = Number(String(ref || '').replace(/[A-Za-z]/g, ''));
  return Number.isFinite(n) ? n - 1 : -1;
}

function sheetXmlToRows(xml, strings) {
  const grid = [];
  for (const match of String(xml || '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
    const attrs = match[1];
    const ref = (attrs.match(/\br="([^"]+)"/i) || [])[1] || '';
    const kind = (attrs.match(/\bt="([^"]+)"/i) || [])[1] || '';
    const r = rowIndex(ref);
    const c = colIndex(ref);
    if (r < 0 || c < 0 || r >= MAX_ROWS || c >= MAX_COLS) continue;
    let value = '';
    const inline = match[2].match(/<t\b[^>]*>([\s\S]*?)<\/t>/i);
    const raw = match[2].match(/<v>([\s\S]*?)<\/v>/i);
    if (kind === 's') value = strings[Number(raw?.[1] || 0)] || '';
    else if (kind === 'inlineStr') value = decodeXml(inline?.[1] || '');
    else if (inline && !raw) value = decodeXml(inline[1]);
    else value = decodeXml(raw?.[1] || '');
    if (!grid[r]) grid[r] = [];
    grid[r][c] = value;
  }
  let width = 0;
  for (const row of grid) {
    if (!row) continue;
    for (let i = row.length - 1; i >= 0; i -= 1) {
      if (String(row[i] || '').trim() !== '') {
        width = Math.max(width, i + 1);
        break;
      }
    }
  }
  return grid
    .filter((row) => row && row.some((cell) => String(cell || '').trim() !== ''))
    .map((row) => Array.from({ length: width }, (_, i) => row[i] || ''));
}

function xlsxToRows(files) {
  const strings = sharedStrings(textOf(files.get('xl/sharedStrings.xml') || new Uint8Array()));
  const sheets = [...files.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort();
  if (!sheets.length) throw new Error('That workbook has no worksheet.');
  return sheetXmlToRows(textOf(files.get(sheets[0])), strings);
}

function odsToRows(xml) {
  const rows = [];
  for (const rowXml of String(xml || '').matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/gi)) {
    const row = [];
    for (const cell of rowXml[1].matchAll(/<table:table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/gi)) {
      const attrs = cell[1];
      const repeated = Math.min(MAX_COLS, Math.max(1, Number((attrs.match(/table:number-columns-repeated="(\d+)"/i) || [])[1]) || 1));
      const valueAttr = (attrs.match(/office:value="([^"]*)"/i) || [])[1];
      const texts = [...String(cell[2] || '').matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/gi)].map((m) => decodeXml(m[1].replace(/<[^>]+>/g, '')));
      const value = valueAttr != null && valueAttr !== '' && !texts.length ? decodeXml(valueAttr) : texts.join('\n');
      const empty = value.trim() === '';
      const times = empty ? 1 : repeated;
      for (let i = 0; i < times && row.length < MAX_COLS; i += 1) row.push(value);
    }
    if (row.some((cell) => String(cell || '').trim() !== '')) rows.push(row);
    if (rows.length >= MAX_ROWS) break;
  }
  return rows;
}

function spreadsheetMlToRows(xml) {
  const rows = [];
  for (const rowXml of String(xml || '').matchAll(/<(?:\w+:)?Row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Row>/gi)) {
    const row = [];
    let col = 0;
    for (const cell of rowXml[1].matchAll(/<(?:\w+:)?Cell\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Cell>/gi)) {
      const index = Number((cell[1].match(/\bss:Index="(\d+)"/i) || [])[1]);
      if (index > 0) {
        while (col < index - 1 && col < MAX_COLS) {
          row.push('');
          col += 1;
        }
      }
      const data = cell[2].match(/<(?:\w+:)?Data\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Data>/i);
      row.push(decodeXml(data?.[1] || ''));
      col += 1;
    }
    if (row.some((cell) => String(cell || '').trim() !== '')) rows.push(row);
    if (rows.length >= MAX_ROWS) break;
  }
  return rows;
}

async function bytesToCsv(name, bytes) {
  const kind = extOf(name);
  if (kind === 'xls') {
    throw new Error('Save this .xls file as .xlsx or .csv, then upload it again.');
  }
  if (kind === 'xml' || (bytes[0] === 0x3c)) {
    const xml = textOf(bytes);
    if (/<(?:\w+:)?Worksheet\b/i.test(xml) || /<(?:\w+:)?Row\b/i.test(xml)) {
      return rowsToCsv(spreadsheetMlToRows(xml));
    }
    throw new Error('That XML is not a spreadsheet. Paste the rows as CSV or upload .xlsx.');
  }
  const files = await readZip(bytes);
  if (kind === 'ods' || files.has('content.xml')) {
    const csv = rowsToCsv(odsToRows(textOf(files.get('content.xml') || new Uint8Array())));
    if (!csv.trim()) throw new Error('That spreadsheet has no rows.');
    return csv;
  }
  const csv = rowsToCsv(xlsxToRows(files));
  if (!csv.trim()) throw new Error('That spreadsheet has no rows.');
  return csv;
}

export async function fileToCsv(file) {
  if (!file) throw new Error('Choose a file.');
  const size = Number(file.size) || 0;
  if (size > MAX_BYTES) throw new Error('That file is over 8 MB. Split it or export a smaller CSV.');
  const kind = extOf(file.name);
  if (kind === 'csv' || kind === 'txt' || kind === '') {
    return normalizeDelimited(await file.text());
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return bytesToCsv(file.name, bytes);
}

export async function textToCsv(text, name = 'paste.csv') {
  const raw = String(text || '');
  if (!raw.trim()) throw new Error('Paste the spreadsheet text first.');
  if (raw.length > MAX_BYTES) throw new Error('That paste is over 8 MB. Upload a file instead.');
  if (extOf(name) === 'xml' || /^\s*</.test(raw)) return bytesToCsv(name.endsWith('.xml') ? name : 'paste.xml', new TextEncoder().encode(raw));
  return normalizeDelimited(raw);
}
