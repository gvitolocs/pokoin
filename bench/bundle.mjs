#!/usr/bin/env node
// Bundle report for a Vite dist directory: raw / gzip-9 / brotli-11 sizes of every JS
// and CSS asset, the entry chunk(s) and modulepreloads from index.html, the static
// import graph of the entry, and (when .map files exist) entry bytes attributed to
// source modules and npm packages by decoding the sourcemap VLQ mappings.
//   node bundle.mjs <distDir> [--top 40] [--json out.json] [--html index.html]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: node bundle.mjs <distDir> [--top 40] [--json out.json] [--html index.html]';

// ---------- sourcemap decoding ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i += 1) B64_INDEX[B64.charCodeAt(i)] = i;

/**
 * Decodes a source map v3 `mappings` string. Returns one array per generated line of
 * [generatedColumn, sourceIndex] pairs (sourceIndex -1 for segments without a source),
 * or with { full: true } [generatedColumn, sourceIndex, sourceLine, sourceColumn, nameIndex]
 * (all 0-based; nameIndex -1 when the segment has no name).
 */
export function decodeMappings(mappings, { full = false } = {}) {
  const lines = [];
  let line = [];
  let genCol = 0;
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  let nameIdx = 0;
  const fields = [0, 0, 0, 0, 0];
  let i = 0;
  const n = mappings.length;
  while (i < n) {
    const c = mappings.charCodeAt(i);
    if (c === 59) { // ';' next generated line
      lines.push(line);
      line = [];
      genCol = 0;
      i += 1;
      continue;
    }
    if (c === 44) { // ',' next segment
      i += 1;
      continue;
    }
    let count = 0;
    while (i < n) {
      const ch = mappings.charCodeAt(i);
      if (ch === 44 || ch === 59) break;
      let value = 0;
      let shift = 0;
      let digit;
      do {
        const code = mappings.charCodeAt(i);
        digit = code < 128 ? B64_INDEX[code] : -1;
        if (digit < 0) throw new Error(`invalid base64 VLQ character at offset ${i}`);
        value += (digit & 31) * 2 ** shift;
        shift += 5;
        i += 1;
      } while (digit & 32);
      const negative = value % 2 === 1;
      value = (value - (negative ? 1 : 0)) / 2;
      if (count < 5) fields[count] = negative ? -value : value;
      count += 1;
    }
    genCol += fields[0];
    if (count >= 4) {
      srcIdx += fields[1];
      srcLine += fields[2];
      srcCol += fields[3];
      if (count >= 5) nameIdx += fields[4];
      line.push(full ? [genCol, srcIdx, srcLine, srcCol, count >= 5 ? nameIdx : -1] : [genCol, srcIdx]);
    } else {
      line.push(full ? [genCol, -1, -1, -1, -1] : [genCol, -1]);
    }
  }
  lines.push(line);
  return lines;
}

/** Original position of a generated (0-based line, 0-based column) in a parsed map. */
export function originalPosition(map, decoded, line, column) {
  const segs = decoded[line];
  if (!segs || !segs.length) return null;
  let lo = 0;
  let hi = segs.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid][0] <= column) {
      hit = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (hit < 0 || segs[hit][1] < 0) return null;
  const [, src, srcLine, srcCol, nameIdx] = segs[hit];
  return {
    source: normalizeSource(map.sources[src], map.sourceRoot),
    line: srcLine + 1,
    column: srcCol + 1,
    name: nameIdx >= 0 && map.names ? map.names[nameIdx] : null,
  };
}

const isAscii = (text) => !/[^\x00-\x7f]/.test(text);
const byteLen = (text) => Buffer.byteLength(text, 'utf8');

/**
 * Attributes every byte of `code` to a source index of `map` (-1 = unmapped).
 * Columns are UTF-16 offsets; byte counts are UTF-8. Newlines count as unmapped.
 */
export function attributeBytes(code, map) {
  const decoded = decodeMappings(map.mappings || '');
  const lines = code.split('\n');
  const bytes = new Map();
  const add = (idx, count) => {
    if (count > 0) bytes.set(idx, (bytes.get(idx) || 0) + count);
  };
  for (let l = 0; l < lines.length; l += 1) {
    const text = lines[l];
    if (l < lines.length - 1) add(-1, 1);
    const segs = decoded[l] || [];
    const size = isAscii(text) ? (from, to) => to - from : (from, to) => byteLen(text.slice(from, to));
    if (!segs.length) {
      add(-1, size(0, text.length));
      continue;
    }
    const sorted = segs.length > 1 && segs.some((s, k) => k && s[0] < segs[k - 1][0])
      ? [...segs].sort((p, q) => p[0] - q[0])
      : segs;
    add(-1, size(0, Math.min(sorted[0][0], text.length)));
    for (let k = 0; k < sorted.length; k += 1) {
      const from = Math.min(sorted[k][0], text.length);
      const to = k + 1 < sorted.length ? Math.min(sorted[k + 1][0], text.length) : text.length;
      if (to > from) add(sorted[k][1], size(from, to));
    }
  }
  return bytes;
}

/** Normalises a sourcemap source path to a repo-relative-looking path. */
export function normalizeSource(source, sourceRoot = '') {
  let s = String(source || '');
  if (sourceRoot && !/^([a-z]+:|\/)/i.test(s)) s = `${sourceRoot.replace(/\/?$/, '/')}${s}`;
  s = s.replace(/^webpack:\/\/[^/]*\//, '').replace(/^\0/, '').replace(/^\/@id\//, '').replace(/\?.*$/, '');
  while (s.startsWith('../')) s = s.slice(3);
  s = s.replace(/^\.\//, '');
  const nm = s.indexOf('node_modules/');
  return nm > 0 ? s.slice(nm) : s;
}

/**
 * Display names for app sources: strips the directory prefix they all share (absolute
 * paths appear when the build outDir lives outside the project), keeping one level.
 */
export function trimCommonPrefix(sources) {
  const app = sources.filter((s) => s !== '[unmapped]' && !s.startsWith('node_modules/') && packageOf(s) !== '(bundler runtime)');
  if (app.length < 2) return new Map(sources.map((s) => [s, s]));
  let prefix = app[0].split('/').slice(0, -1);
  for (const s of app) {
    const parts = s.split('/');
    let i = 0;
    while (i < prefix.length && i < parts.length - 1 && prefix[i] === parts[i]) i += 1;
    prefix = prefix.slice(0, i);
  }
  // keep the last shared folder ("src/...") so app packages stay readable
  const strip = prefix.length > 1 ? prefix.slice(0, -1).join('/').length + 1 : 0;
  return new Map(sources.map((s) => [s, app.includes(s) && strip ? s.slice(strip) : s]));
}

/** npm package (or app folder / bundler runtime) a normalised source belongs to. */
export function packageOf(source) {
  if (source === '[unmapped]') return '[unmapped]';
  const nm = source.lastIndexOf('node_modules/');
  if (nm >= 0) {
    const parts = source.slice(nm + 'node_modules/'.length).split('/');
    return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  if (/^(vite\/|commonjsHelpers|\x00|vite-|plugin-|__vite)/.test(source) || source.includes('vite/preload-helper')) {
    return '(bundler runtime)';
  }
  const parts = source.split('/');
  return `app:${parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length === 2 ? parts[0] : source}`;
}

// ---------- assets ----------

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function sizes(buf) {
  return {
    raw: buf.length,
    gzip: zlib.gzipSync(buf, { level: 9 }).length,
    brotli: zlib.brotliCompressSync(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    }).length,
  };
}

/** Script/modulepreload/stylesheet references in an HTML file. */
export function parseHtml(html) {
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    return m ? (m[2] ?? m[3] ?? m[4]) : null;
  };
  const entries = [];
  const preloads = [];
  const styles = [];
  for (const tag of html.match(/<script\b[^>]*>/gi) || []) {
    const src = attr(tag, 'src');
    if (src && /type\s*=\s*["']?module/i.test(tag)) entries.push(src);
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    const href = attr(tag, 'href');
    if (!href) continue;
    if (rel === 'modulepreload') preloads.push(href);
    else if (rel === 'stylesheet') styles.push(href);
  }
  return { entries, preloads, styles };
}

/** Relative static imports / re-exports of a built chunk (dynamic import() excluded). */
export function staticImports(code) {
  const out = new Set();
  const re = /\b(?:import|export)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?["'](\.{1,2}\/[^"']+)["']/g;
  let m;
  while ((m = re.exec(code))) out.add(m[1]);
  return [...out];
}

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const pct = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '–');

function table(headers, rows, alignRight = []) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => (alignRight.includes(i) ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i]))).join('  ');
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function parseArgs(argv) {
  const opts = { dist: null, top: 40, json: null, html: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--top') opts.top = Number(argv[++i]);
    else if (arg === '--json') opts.json = argv[++i];
    else if (arg === '--html') opts.html = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}\n${USAGE}`);
    else opts.dist = arg;
  }
  if (!opts.dist) throw new Error(USAGE);
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dist = path.resolve(opts.dist);
  if (!fs.statSync(dist, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${dist} is not a directory`);
  const files = walk(dist);
  const assetFiles = files.filter((f) => /\.(m?js|css)$/.test(f));
  const byBase = new Map(assetFiles.map((f) => [path.basename(f), f]));
  const report = { dist, assets: [], html: [], attribution: [] };

  for (const file of assetFiles) {
    const rel = path.relative(dist, file);
    report.assets.push({ file: rel, kind: file.endsWith('.css') ? 'css' : 'js', hasMap: fs.existsSync(`${file}.map`), ...sizes(fs.readFileSync(file)) });
  }
  report.assets.sort((a, b) => b.raw - a.raw);
  const sum = (list, key) => list.reduce((acc, a) => acc + a[key], 0);
  const js = report.assets.filter((a) => a.kind === 'js');
  const css = report.assets.filter((a) => a.kind === 'css');
  const sizeOf = (rel) => report.assets.find((a) => a.file === rel);

  console.log(`# Bundle report: ${dist}\n`);
  console.log(`${js.length} JS (${fmtBytes(sum(js, 'raw'))} raw / ${fmtBytes(sum(js, 'gzip'))} gzip / ${fmtBytes(sum(js, 'brotli'))} br), `
    + `${css.length} CSS (${fmtBytes(sum(css, 'raw'))} raw / ${fmtBytes(sum(css, 'gzip'))} gzip / ${fmtBytes(sum(css, 'brotli'))} br)\n`);
  console.log(table(
    ['asset', 'raw', 'gzip-9', 'brotli-11', 'map'],
    report.assets.slice(0, opts.top).map((a) => [a.file, fmtBytes(a.raw), fmtBytes(a.gzip), fmtBytes(a.brotli), a.hasMap ? 'yes' : '']),
    [1, 2, 3],
  ));
  if (report.assets.length > opts.top) console.log(`… ${report.assets.length - opts.top} smaller assets not shown`);

  // index.html entry points
  const htmlFiles = opts.html
    ? [path.resolve(dist, opts.html)]
    : files.filter((f) => path.dirname(f) === dist && f.endsWith('.html'));
  const resolveRef = (ref) => {
    const base = path.basename(ref.split(/[?#]/)[0]);
    return byBase.has(base) ? path.relative(dist, byBase.get(base)) : null;
  };
  const entryChunks = new Set();
  for (const htmlFile of htmlFiles) {
    const refs = parseHtml(fs.readFileSync(htmlFile, 'utf8'));
    if (!refs.entries.length && !refs.preloads.length && !refs.styles.length) continue;
    const rows = [];
    const group = (kind, list) => list.map((ref) => ({ kind, ref, file: resolveRef(ref) }));
    const refsResolved = [...group('entry', refs.entries), ...group('modulepreload', refs.preloads), ...group('stylesheet', refs.styles)];
    for (const r of refsResolved) {
      const s = r.file ? sizeOf(r.file) : null;
      rows.push([r.kind, r.file || `${r.ref} (not found)`, s ? fmtBytes(s.raw) : '–', s ? fmtBytes(s.gzip) : '–', s ? fmtBytes(s.brotli) : '–']);
      if (r.kind === 'entry' && r.file) entryChunks.add(r.file);
    }
    const initial = refsResolved.filter((r) => r.kind !== 'stylesheet' && r.file).map((r) => sizeOf(r.file));
    console.log(`\n## ${path.basename(htmlFile)}: entry chunks and preloads\n`);
    console.log(table(['kind', 'file', 'raw', 'gzip-9', 'brotli-11'], rows, [2, 3, 4]));
    console.log(`initial JS (entries + modulepreloads): ${fmtBytes(sum(initial, 'raw'))} raw / ${fmtBytes(sum(initial, 'gzip'))} gzip / ${fmtBytes(sum(initial, 'brotli'))} br`);

    // static import closure from the entries (what must load before the app runs)
    const seen = new Set();
    const queue = refsResolved.filter((r) => r.kind === 'entry' && r.file).map((r) => r.file);
    while (queue.length) {
      const rel = queue.shift();
      if (seen.has(rel)) continue;
      seen.add(rel);
      const code = fs.readFileSync(path.join(dist, rel), 'utf8');
      for (const spec of staticImports(code)) {
        const target = path.relative(dist, path.resolve(path.dirname(path.join(dist, rel)), spec));
        if (fs.existsSync(path.join(dist, target)) && !seen.has(target)) queue.push(target);
      }
    }
    const closure = [...seen].map(sizeOf).filter(Boolean);
    console.log(`static import graph of the entry: ${closure.length} chunk(s), ${fmtBytes(sum(closure, 'raw'))} raw / ${fmtBytes(sum(closure, 'gzip'))} gzip / ${fmtBytes(sum(closure, 'brotli'))} br`);
    report.html.push({ file: path.basename(htmlFile), refs: refsResolved, staticGraph: [...seen] });
  }

  // sourcemap attribution of the entry chunk(s)
  let anyMap = false;
  for (const rel of entryChunks) {
    const file = path.join(dist, rel);
    if (!fs.existsSync(`${file}.map`)) continue;
    anyMap = true;
    const code = fs.readFileSync(file, 'utf8');
    const map = JSON.parse(fs.readFileSync(`${file}.map`, 'utf8'));
    if (map.sections) {
      console.log(`\n${rel}.map is an indexed (sectioned) map; attribution not supported`);
      continue;
    }
    const total = byteLen(code);
    const bytes = attributeBytes(code, map);
    const modules = new Map();
    const packages = new Map();
    const sourceOf = (idx) => (idx >= 0 && map.sources[idx] != null ? normalizeSource(map.sources[idx], map.sourceRoot) : '[unmapped]');
    const display = trimCommonPrefix([...new Set([...bytes.keys()].map(sourceOf))]);
    for (const [idx, count] of bytes) {
      const src = display.get(sourceOf(idx));
      modules.set(src, (modules.get(src) || 0) + count);
      const pkg = packageOf(src);
      packages.set(pkg, (packages.get(pkg) || 0) + count);
    }
    const attributed = [...bytes.values()].reduce((a, b) => a + b, 0);
    const topModules = [...modules.entries()].sort((a, b) => b[1] - a[1]);
    const topPackages = [...packages.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`\n## ${rel}: ${fmtBytes(total)} attributed to ${modules.size} source modules (${fmtBytes(attributed)} accounted)\n`);
    console.log(table(['bytes', 'share', 'package'], topPackages.slice(0, opts.top).map(([p, b]) => [fmtBytes(b), pct(b, total), p]), [0, 1]));
    console.log('');
    console.log(table(['bytes', 'share', 'module'], topModules.slice(0, opts.top).map(([m, b]) => [fmtBytes(b), pct(b, total), m]), [0, 1]));
    report.attribution.push({
      chunk: rel,
      bytes: total,
      packages: topPackages.map(([name, b]) => ({ name, bytes: b })),
      modules: topModules.map(([name, b]) => ({ name, bytes: b })),
    });
  }
  if (!anyMap) {
    console.log('\nNo .map next to the entry chunk: build with sourcemaps for module attribution, e.g.');
    console.log('  (cd market && npx vite build --sourcemap --outDir /tmp/pokoin-dist-maps)  # then: node bundle.mjs /tmp/pokoin-dist-maps');
  }
  if (opts.json) {
    fs.writeFileSync(opts.json, `${JSON.stringify(report, null, 1)}\n`);
    console.log(`\nwrote ${opts.json}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
