// PKD1: the mobile typeahead dictionary (reference encoder + decoder).
//
// Same rows as market/src/data/suggest-{names,sets,artists}.js, laid out as one
// UTF-8 string pool plus small fixed-width columns, so a reader can wrap the
// file in typed-array views without building one object per entry.
//
// Layout (all integers little-endian; every section starts on a 4-byte boundary):
//   0   'PKD1'                       magic
//   4   u16 formatVersion (1)
//   6   u16 sectionCount
//   8   u8[16] contentHash          first 16 bytes of SHA-256 over the canonical tuple JSON
//   24  u32 names, u32 sets, u32 artists
//   36  sectionCount × { u8[4] tag, u32 offset, u32 length }
// Sections:
//   STRS  UTF-8 pool, in this order: name displays, set displays, set slugs,
//         artist displays, artist slugs, then the shipped compacts
//         (names, sets, artists). Readers rebuild offsets with one prefix sum.
//   NDLN SDLN SSLN ADLN ASLN   u8 byte length of each string (all rows < 256 bytes)
//   NPRI SPRI APRI             u16 prior per row
//   SNAT                       u8 index into NATP per set
//   NATP                       u8 count, then (u8 length, UTF-8) per nationality
//   NCXI SCXI ACXI             u16 row index of every row whose display is not pure ASCII
//   NCXL SCXL ACXL             u8 byte length of that row's compact (compactQuery output)
//   NCOL SCOL ACOL             u16 collation rank of each display under the web's
//                              Intl.Collator() (equal displays share a rank); Dart has no
//                              ICU collator, and rankNames breaks score ties with it
// A pure-ASCII display's compact is lowercase(display) with every byte outside
// [a-z0-9] removed — exactly compactQuery's ASCII branch — so it is not shipped.
import { createHash } from 'node:crypto';

export const MAGIC = 'PKD1';
export const FORMAT_VERSION = 1;
const ASCII_ONLY = /^[\x00-\x7f]*$/;

const SECTION_ORDER = [
  'STRS',
  'NDLN', 'NPRI', 'NCXI', 'NCXL',
  'SDLN', 'SSLN', 'SPRI', 'SNAT', 'SCXI', 'SCXL',
  'ADLN', 'ASLN', 'APRI', 'ACXI', 'ACXL',
  'NCOL', 'SCOL', 'ACOL',
  'NATP',
];

const align4 = (n) => (n + 3) & ~3;

export function canonicalTuples({ names, sets, artists }) {
  return {
    names: names.map((r) => [r.display, r.prior]),
    sets: sets.map((r) => [r.display, r.slug, r.prior, r.nationality || '']),
    artists: artists.map((r) => [r.display, r.slug, r.prior]),
  };
}

export function contentHash(data) {
  return createHash('sha256').update(JSON.stringify(canonicalTuples(data))).digest().subarray(0, 16);
}

export function encodePkd1(data, compactQuery, { shipAllCompacts = false } = {}) {
  const enc = new TextEncoder();
  const chunks = [];
  let poolLength = 0;
  const push = (text) => {
    const bytes = enc.encode(text);
    if (bytes.length > 255) throw new Error(`string over 255 bytes: ${text}`);
    chunks.push(bytes);
    poolLength += bytes.length;
    return bytes.length;
  };
  const lengths = (strings) => Uint8Array.from(strings.map(push));
  const u16 = (values) => Uint16Array.from(values.map((v) => {
    if (!(Number.isInteger(v) && v >= 0 && v <= 0xffff)) throw new Error(`not u16: ${v}`);
    return v;
  }));
  const { names, sets, artists } = data;
  const natPalette = [...new Set(sets.map((r) => r.nationality || ''))].sort();
  const s = {};
  s.NDLN = lengths(names.map((r) => r.display));
  s.SDLN = lengths(sets.map((r) => r.display));
  s.SSLN = lengths(sets.map((r) => r.slug));
  s.ADLN = lengths(artists.map((r) => r.display));
  s.ASLN = lengths(artists.map((r) => r.slug));
  const exceptions = (rows) => rows.flatMap((r, i) => (!shipAllCompacts && ASCII_ONLY.test(r.display) ? [] : [i]));
  const nx = exceptions(names);
  const sx = exceptions(sets);
  const ax = exceptions(artists);
  s.NCXI = u16(nx);
  s.NCXL = lengths(nx.map((i) => compactQuery(names[i].display)));
  s.SCXI = u16(sx);
  s.SCXL = lengths(sx.map((i) => compactQuery(sets[i].display)));
  s.ACXI = u16(ax);
  s.ACXL = lengths(ax.map((i) => compactQuery(artists[i].display)));
  s.NPRI = u16(names.map((r) => r.prior));
  s.SPRI = u16(sets.map((r) => r.prior));
  s.APRI = u16(artists.map((r) => r.prior));
  const collator = new Intl.Collator();
  const ranks = (rows) => {
    const order = rows.map((r, i) => i).sort((a, b) => collator.compare(rows[a].display, rows[b].display));
    const out = new Uint16Array(rows.length);
    let r = 0;
    order.forEach((row, k) => {
      if (k > 0 && collator.compare(rows[order[k - 1]].display, rows[row].display) !== 0) r = k;
      out[row] = r;
    });
    return out;
  };
  s.NCOL = ranks(names);
  s.SCOL = ranks(sets);
  s.ACOL = ranks(artists);
  s.SNAT = Uint8Array.from(sets.map((r) => natPalette.indexOf(r.nationality || '')));
  const nat = [natPalette.length];
  for (const value of natPalette) {
    const b = enc.encode(value);
    nat.push(b.length, ...b);
  }
  s.NATP = Uint8Array.from(nat);
  s.STRS = new Uint8Array(poolLength);
  let at = 0;
  for (const bytes of chunks) {
    s.STRS.set(bytes, at);
    at += bytes.length;
  }
  const hash = contentHash(data);
  let offset = align4(36 + SECTION_ORDER.length * 12);
  const table = SECTION_ORDER.map((tag) => {
    const bytes = new Uint8Array(s[tag].buffer, s[tag].byteOffset, s[tag].byteLength);
    const row = { tag, offset, bytes };
    offset = align4(offset + bytes.length);
    return row;
  });
  const out = new Uint8Array(offset);
  const view = new DataView(out.buffer);
  out.set(enc.encode(MAGIC), 0);
  view.setUint16(4, FORMAT_VERSION, true);
  view.setUint16(6, SECTION_ORDER.length, true);
  out.set(hash, 8);
  view.setUint32(24, names.length, true);
  view.setUint32(28, sets.length, true);
  view.setUint32(32, artists.length, true);
  table.forEach((row, i) => {
    const e = 36 + i * 12;
    out.set(enc.encode(row.tag), e);
    view.setUint32(e + 4, row.offset, true);
    view.setUint32(e + 8, row.bytes.length, true);
    out.set(row.bytes, row.offset);
  });
  return { bytes: out, contentHash: Buffer.from(hash).toString('hex') };
}

/**
 * Typed-array decode. String bytes stay in the file buffer (views, no copy);
 * offsets come from one prefix sum; compacts are one new byte pool (ASCII
 * rows folded here, non-ASCII rows copied from the shipped exceptions).
 */
export function decodePkd1(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tagAt = (at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (tagAt(0) !== MAGIC) throw new Error('not a PKD1 file');
  if (view.getUint16(4, true) !== FORMAT_VERSION) throw new Error('unsupported PKD1 format');
  const sectionCount = view.getUint16(6, true);
  let hash = '';
  for (let i = 8; i < 24; i += 1) hash += bytes[i].toString(16).padStart(2, '0');
  const counts = { names: view.getUint32(24, true), sets: view.getUint32(28, true), artists: view.getUint32(32, true) };
  const sec = {};
  for (let i = 0; i < sectionCount; i += 1) {
    const e = 36 + i * 12;
    sec[tagAt(e)] = { offset: view.getUint32(e + 4, true), length: view.getUint32(e + 8, true) };
  }
  const u8 = (tag) => new Uint8Array(bytes.buffer, bytes.byteOffset + sec[tag].offset, sec[tag].length);
  const u16 = (tag) => new Uint16Array(bytes.buffer, bytes.byteOffset + sec[tag].offset, sec[tag].length / 2);
  const strs = u8('STRS');
  let cursor = 0;
  const starts = (lens) => {
    const out = new Uint32Array(lens.length + 1);
    for (let i = 0; i < lens.length; i += 1) {
      out[i] = cursor;
      cursor += lens[i];
    }
    out[lens.length] = cursor;
    return out;
  };
  const names = { display: starts(u8('NDLN')), prior: u16('NPRI'), collation: u16('NCOL') };
  const sets = { display: starts(u8('SDLN')), slug: starts(u8('SSLN')), prior: u16('SPRI'), nat: u8('SNAT'), collation: u16('SCOL') };
  const artists = { display: starts(u8('ADLN')), slug: starts(u8('ASLN')), prior: u16('APRI'), collation: u16('ACOL') };
  const shipped = (idxTag, lenTag) => ({ index: u16(idxTag), at: starts(u8(lenTag)) });
  const nx = shipped('NCXI', 'NCXL');
  const sx = shipped('SCXI', 'SCXL');
  const ax = shipped('ACXI', 'ACXL');
  // Compact pool: one pass per table.
  const compactPool = new Uint8Array(strs.length);
  let w = 0;
  const compacts = (display, n, ex) => {
    const out = new Uint32Array(n + 1);
    let k = 0;
    for (let i = 0; i < n; i += 1) {
      out[i] = w;
      if (k < ex.index.length && ex.index[k] === i) {
        compactPool.set(strs.subarray(ex.at[k], ex.at[k + 1]), w);
        w += ex.at[k + 1] - ex.at[k];
        k += 1;
        continue;
      }
      for (let p = display[i]; p < display[i + 1]; p += 1) {
        let c = strs[p];
        if (c >= 65 && c <= 90) c += 32;
        if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) compactPool[w++] = c;
      }
    }
    out[n] = w;
    return out;
  };
  names.compact = compacts(names.display, counts.names, nx);
  sets.compact = compacts(sets.display, counts.sets, sx);
  artists.compact = compacts(artists.display, counts.artists, ax);
  const natp = u8('NATP');
  const natPalette = [];
  const dec = new TextDecoder();
  for (let i = 0, p = 1; i < natp[0]; i += 1) {
    natPalette.push(dec.decode(natp.subarray(p + 1, p + 1 + natp[p])));
    p += 1 + natp[p];
  }
  return {
    hash,
    counts,
    strs,
    compactPool: compactPool.subarray(0, w),
    names,
    sets,
    artists,
    natPalette,
    text: (offsets, i, pool = strs) => dec.decode(pool.subarray(offsets[i], offsets[i + 1])),
  };
}
