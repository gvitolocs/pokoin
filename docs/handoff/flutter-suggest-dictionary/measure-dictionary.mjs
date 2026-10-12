#!/usr/bin/env node
// Measures the typeahead dictionary the web ships today and the mobile candidates.
//   node measure-dictionary.mjs [repoRoot] [--json out.json] [--write-pkd1 out.pkd1]
// Node only (zlib for gzip/brotli). No network. Writes nothing unless asked.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { canonicalTuples, decodePkd1, encodePkd1 } from './pkd1.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
const jsonOut = flag('--json');
const pkdOut = flag('--write-pkd1');
const positional = args.filter((a, i) => !a.startsWith('--') && !['--json', '--write-pkd1'].includes(args[i - 1]));
const root = path.resolve(positional[0] || path.join(here, '../../..'));
const src = path.join(root, 'market/src');
const url = (p) => pathToFileURL(path.join(src, p)).href;

const names = (await import(url('data/suggest-names.js'))).default;
const sets = (await import(url('data/suggest-sets.js'))).default;
const artists = (await import(url('data/suggest-artists.js'))).default;
const { compactQuery } = await import(url('compact-query.js'));

const br = (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
const gz = (b) => zlib.gzipSync(b, { level: 9 }).length;
const buf = (s) => (typeof s === 'string' ? Buffer.from(s) : Buffer.from(s.buffer, s.byteOffset, s.byteLength));
const sizes = (s) => { const b = buf(s); return { raw: b.length, gzip9: gz(b), brotli11: br(b) }; };
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const pct = (values, p) => { const v = [...values].sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(p * v.length))]; };

function time(fn, reps = 60) {
  for (let i = 0; i < 5; i += 1) fn();
  const out = [];
  for (let i = 0; i < reps; i += 1) {
    const t = performance.now();
    fn();
    out.push(performance.now() - t);
  }
  return { p50: pct(out, 0.5), min: Math.min(...out), max: Math.max(...out), reps };
}

const report = { node: process.version, icu: process.versions.icu, unicode: process.versions.unicode };
report.counts = { names: names.length, sets: sets.length, artists: artists.length };
report.nonAsciiRows = {
  names: names.filter((r) => /[^\x00-\x7f]/.test(r.display)).length,
  sets: sets.filter((r) => /[^\x00-\x7f]/.test(r.display)).length,
  artists: artists.filter((r) => /[^\x00-\x7f]/.test(r.display)).length,
};
report.maxPrior = {
  names: Math.max(...names.map((r) => r.prior)),
  sets: Math.max(...sets.map((r) => r.prior)),
  artists: Math.max(...artists.map((r) => r.prior)),
};

// --- formats ------------------------------------------------------------------
const files = ['data/suggest-names.js', 'data/suggest-sets.js', 'data/suggest-artists.js'];
const onDisk = Buffer.concat(files.map((f) => fs.readFileSync(path.join(src, f))));
const objectJson = JSON.stringify({ names, sets, artists });
const tupleJson = JSON.stringify(canonicalTuples({ names, sets, artists }));
const pkd = encodePkd1({ names, sets, artists }, compactQuery);
const pkdAll = encodePkd1({ names, sets, artists }, compactQuery, { shipAllCompacts: true });
report.formats = {
  esModulesOnDisk: sizes(onDisk),
  objectJson: sizes(objectJson),
  tupleJson: sizes(tupleJson),
  pkd1: sizes(pkd.bytes),
  pkd1ShipAllCompacts: sizes(pkdAll.bytes),
};

// --- decode ---------------------------------------------------------------------
report.decodeMs = {
  objectJsonParse: time(() => JSON.parse(objectJson)),
  tupleJsonParse: time(() => JSON.parse(tupleJson)),
  tupleJsonParsePlusCompacts: time(() => {
    const d = JSON.parse(tupleJson);
    for (const r of d.names) compactQuery(`${r[0]} `); // a fresh string per call defeats the memo
  }, 20),
  pkd1Decode: time(() => decodePkd1(pkd.bytes)),
};

// --- derived indexes the reader builds at load (sorted compacts, token postings) ---
const decoded = decodePkd1(pkd.bytes);
const cmpBytes = (pool, a0, a1, b0, b1) => {
  const n = Math.min(a1 - a0, b1 - b0);
  for (let i = 0; i < n; i += 1) {
    const d = pool[a0 + i] - pool[b0 + i];
    if (d) return d;
  }
  return (a1 - a0) - (b1 - b0);
};
report.indexBuildMs = {
  sortNamesByCompact: time(() => {
    const order = Uint16Array.from({ length: decoded.counts.names }, (_, i) => i);
    const c = decoded.names.compact;
    const pool = decoded.compactPool;
    Array.prototype.sort.call(order, (a, b) => cmpBytes(pool, c[a], c[a + 1], c[b], c[b + 1]));
  }, 20),
};

// round trip, field by field
let mismatches = 0;
const t = decoded.text;
names.forEach((r, i) => {
  if (t(decoded.names.display, i) !== r.display) mismatches += 1;
  if (t(decoded.names.compact, i, decoded.compactPool) !== compactQuery(r.display)) mismatches += 1;
  if (decoded.names.prior[i] !== r.prior) mismatches += 1;
});
sets.forEach((r, i) => {
  if (t(decoded.sets.display, i) !== r.display || t(decoded.sets.slug, i) !== r.slug) mismatches += 1;
  if (t(decoded.sets.compact, i, decoded.compactPool) !== compactQuery(r.display)) mismatches += 1;
  if (decoded.natPalette[decoded.sets.nat[i]] !== (r.nationality || '')) mismatches += 1;
  if (decoded.sets.prior[i] !== r.prior) mismatches += 1;
});
artists.forEach((r, i) => {
  if (t(decoded.artists.display, i) !== r.display || t(decoded.artists.slug, i) !== r.slug) mismatches += 1;
  if (t(decoded.artists.compact, i, decoded.compactPool) !== compactQuery(r.display)) mismatches += 1;
  if (decoded.artists.prior[i] !== r.prior) mismatches += 1;
});
// collation ranks must reproduce Intl.Collator order
const col = new Intl.Collator();
for (const [rows, table] of [[names, decoded.names], [sets, decoded.sets], [artists, decoded.artists]]) {
  for (let i = 1; i < rows.length; i += 1) {
    const want = Math.sign(col.compare(rows[i - 1].display, rows[i].display));
    const got = Math.sign(table.collation[i - 1] - table.collation[i]);
    if (want !== got) mismatches += 1;
  }
}
report.pkd1RoundTripMismatches = mismatches;
report.pkd1ContentHash = pkd.contentHash;

// --- resident bytes once decoded into typed arrays --------------------------------------
const rows = names.length + sets.length + artists.length;
const offsetColumns = 4 * ((names.length + 1) * 2 + (sets.length + 1) * 3 + (artists.length + 1) * 3);
report.residentBytes = {
  fileBuffer: pkd.bytes.length,
  compactPool: decoded.compactPool.length,
  offsetsUint32: offsetColumns,
  sortedNameIndexUint16: 2 * names.length,
  totalCore: pkd.bytes.length + decoded.compactPool.length + offsetColumns + 2 * names.length,
  rows,
};

// --- the web engine as it loads today (V8 reference, not Dart) -------------------------
const engineProbe = `
  gc(); const h0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const rank = await import(${JSON.stringify(url('suggest-rank.js'))});
  const catalog = await import(${JSON.stringify(url('suggest-catalog.js'))});
  const t1 = performance.now();
  const score = await import(${JSON.stringify(url('search-score.js'))});
  await import(${JSON.stringify(url('suggest-resolve.js'))});
  await import(${JSON.stringify(url('suggest-live.js'))});
  const t2 = performance.now();
  gc(); const h1 = process.memoryUsage().heapUsed;
  const idx = score.__index;
  let postings = 0;
  for (const d of idx.NAME_DOCS) postings += new Set(d.langText.en.name).size;
  console.log(JSON.stringify({
    importRankAndCatalogMs: t1 - t0,
    importWholeEngineMs: t2 - t0,
    heapDeltaBytes: h1 - h0,
    namePool: rank.NAME_POOL.length,
    artistPool: catalog.ARTIST_POOL.length,
    setPool: catalog.SET_POOL.length,
    setAliasPool: rank.setAliasPool().length,
    nameTokenVocab: idx.NAME_TOKEN_LIST.length,
    nameTokenPostings: postings,
    nameTokenVocabUtf8: Buffer.byteLength(idx.NAME_TOKEN_LIST.join('')),
  }));
`;
const runs = [];
for (let i = 0; i < 7; i += 1) {
  const child = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', engineProbe], { encoding: 'utf8' });
  if (child.status !== 0) throw new Error(child.stderr);
  runs.push(JSON.parse(child.stdout.trim().split('\n').pop()));
}
const mid = (k) => pct(runs.map((r) => r[k]), 0.5);
report.webEngine = {
  runs: runs.length,
  coldImportRankAndCatalogMsP50: mid('importRankAndCatalogMs'),
  coldImportWholeEngineMsP50: mid('importWholeEngineMs'),
  v8HeapDeltaBytesP50: mid('heapDeltaBytes'),
  namePool: runs[0].namePool,
  artistPool: runs[0].artistPool,
  setPool: runs[0].setPool,
  setAliasPool: runs[0].setAliasPool,
  nameTokenVocab: runs[0].nameTokenVocab,
  nameTokenPostings: runs[0].nameTokenPostings,
  nameTokenVocabUtf8: runs[0].nameTokenVocabUtf8,
};

// --- per-keystroke local rank cost (JS reference for the Dart port) ----------------------
const rankProbe = `
  const rank = await import(${JSON.stringify(url('suggest-rank.js'))});
  const words = ${JSON.stringify(['pikachu', 'charizard', 'mimikyu ex', 'talflamd', 'palkia legend', 'glaceon plasma', 'sylveon ex il', 'umbreon vmax', 'lugia legend', 'expedition'])};
  const first = [];
  for (const w of words) for (let i = 1; i <= w.length; i += 1) {
    const q = w.slice(0, i);
    const t = performance.now(); rank.rankNames(q); rank.parseTypedQuery(q); first.push(performance.now() - t);
  }
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  console.log(JSON.stringify({ keystrokes: first.length, p50: pct(first, 0.5), p95: pct(first, 0.95), max: Math.max(...first) }));
`;
const rankChild = spawnSync(process.execPath, ['--input-type=module', '-e', rankProbe], { encoding: 'utf8' });
if (rankChild.status !== 0) throw new Error(rankChild.stderr);
report.webRankPerKeystrokeMs = JSON.parse(rankChild.stdout.trim().split('\n').pop());

// --- print ------------------------------------------------------------------------
console.log(`node ${report.node}  icu ${report.icu}  unicode ${report.unicode}`);
console.log(`rows: names ${report.counts.names}, sets ${report.counts.sets}, artists ${report.counts.artists}; non-ASCII displays ${JSON.stringify(report.nonAsciiRows)}; max prior ${JSON.stringify(report.maxPrior)}`);
console.log(`\n${'format'.padEnd(26)}${'raw'.padStart(11)}${'gzip-9'.padStart(11)}${'brotli-11'.padStart(11)}`);
for (const [k, v] of Object.entries(report.formats)) {
  console.log(`${k.padEnd(26)}${kb(v.raw).padStart(11)}${kb(v.gzip9).padStart(11)}${kb(v.brotli11).padStart(11)}`);
}
console.log(`\n${'Node ms'.padEnd(26)}${'p50'.padStart(9)}${'min'.padStart(9)}${'max'.padStart(9)}`);
for (const [k, v] of Object.entries({ ...report.decodeMs, ...report.indexBuildMs })) {
  console.log(`${k.padEnd(26)}${v.p50.toFixed(3).padStart(9)}${v.min.toFixed(3).padStart(9)}${v.max.toFixed(3).padStart(9)}`);
}
console.log(`\nPKD1 round-trip mismatches: ${report.pkd1RoundTripMismatches}  content hash: ${report.pkd1ContentHash}`);
console.log(`resident bytes (typed layout): ${JSON.stringify(report.residentBytes)}`);
console.log(`web engine today (${report.webEngine.runs} cold Node processes, p50): ${JSON.stringify(report.webEngine)}`);
console.log(`web rankNames+parseTypedQuery, first call per prefix (Node ms): ${JSON.stringify(report.webRankPerKeystrokeMs)}`);
if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
if (pkdOut) fs.writeFileSync(pkdOut, pkd.bytes);
