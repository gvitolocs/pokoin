#!/usr/bin/env node
// CPU profile (CDP Profiler, 200 µs sampling) of typing a query into the header search,
// or (--switch) of a print-language switch with that query's suggestions open.
// Prints the top self-time functions and writes a .cpuprofile (open it in Chrome
// DevTools > Performance, or speedscope.app).
//   node profile.mjs --base https://pokoin.com --profile desktop|mobile --query pikachu --label <sha>
//   node profile.mjs --base http://127.0.0.1:28621 --switch japanese --sourcemap-dir ../solid/dist
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NETWORKS, PRINT_LANG_LABELS, PROFILES, QUERIES, ROUTES, SELECTORS, TIMING } from './config.mjs';
import { launch, openBenchPage, pressFor } from './lib/browser.mjs';
import { settle, sleep, waitRowsStable, wallNow } from './lib/measure.mjs';
import { decodeMappings, originalPosition } from './bundle.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPECIAL = { '(idle)': 'idle', '(program)': 'program', '(garbage collector)': 'gc', '(root)': 'root' };

const USAGE = `usage: node profile.mjs [options]
  --base <url>        (default https://pokoin.com)
  --profile <name>    desktop | mobile (default desktop)
  --query <text>      typed one key every ${TIMING.keyIntervalMs} ms (default ${QUERIES.search})
  --switch <code>     profile only a print-language switch (${Object.keys(PRINT_LANG_LABELS).join(' | ')})
                      made after the query's rows settle, instead of the typing
  --label <text>      used in the default output name
  --out <file>        .cpuprofile path (default results/profile-<label>-<profile>.cpuprofile)
  --interval <us>     sampling interval in microseconds (default 200)
  --top <n>           functions to print (default 40)
  --net <preset>      ${Object.keys(NETWORKS).join(' | ')} | none
  --channel <name>    chromium | headless-shell | chrome
  --sourcemap-dir <d> dist directory with *.js.map of the SAME build being profiled
                      (e.g. vite build --sourcemap served by vite preview): prints
                      original source:line and names next to minified frames
  --headed`;

function parseArgs(argv) {
  const opts = {
    base: 'https://pokoin.com', profile: 'desktop', query: QUERIES.search, label: 'unlabeled', out: null, switch: null,
    interval: 200, top: 40, net: null, channel: 'chromium', sourcemapDir: null, headed: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq > 0 ? eq : undefined).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!arg.startsWith('--') || !(name in opts)) throw new Error(`unknown argument ${arg}\n${USAGE}`);
    if (typeof opts[name] === 'boolean') {
      opts[name] = true;
      continue;
    }
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value == null) throw new Error(`--${name} needs a value`);
    opts[name] = value;
  }
  opts.base = opts.base.replace(/\/+$/, '');
  opts.interval = Number(opts.interval);
  opts.top = Number(opts.top);
  if (!PROFILES[opts.profile]) throw new Error(`unknown profile ${opts.profile}`);
  if (opts.net === 'none') opts.net = null;
  if (opts.net && !NETWORKS[opts.net]) throw new Error(`unknown --net ${opts.net}`);
  if (opts.switch && !PRINT_LANG_LABELS[opts.switch]) throw new Error(`unknown --switch ${opts.switch}`);
  return opts;
}

/** Self time per function / script from a CDP Profiler profile (µs). */
export function analyzeProfile(prof) {
  const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
  const samples = prof.samples || [];
  const deltas = prof.timeDeltas || [];
  const stamps = [];
  let t = prof.startTime;
  for (let i = 0; i < samples.length; i += 1) {
    t += deltas[i] || 0;
    stamps.push(t);
  }
  const selfByNode = new Map();
  for (let i = 0; i < samples.length; i += 1) {
    const end = i + 1 < samples.length ? stamps[i + 1] : prof.endTime;
    const dur = Math.max(0, end - stamps[i]);
    selfByNode.set(samples[i], (selfByNode.get(samples[i]) || 0) + dur);
  }
  // Inclusive time: a node's self time counts once for every distinct function on its stack.
  const parents = new Map();
  for (const n of prof.nodes) for (const child of n.children || []) parents.set(child, n.id);
  const keyOf = (cf) => `${cf.functionName || '(anonymous)'}\u0000${cf.url}\u0000${cf.lineNumber}\u0000${cf.columnNumber}`;
  const totalByKey = new Map();
  for (const [id, us] of selfByNode) {
    const seen = new Set();
    for (let at = id; at != null; at = parents.get(at)) {
      const key = keyOf(nodes.get(at)?.callFrame || {});
      if (seen.has(key)) continue;
      seen.add(key);
      totalByKey.set(key, (totalByKey.get(key) || 0) + us);
    }
  }
  const special = { idle: 0, program: 0, gc: 0, root: 0 };
  const fns = new Map();
  const scripts = new Map();
  for (const [id, us] of selfByNode) {
    const cf = nodes.get(id)?.callFrame || {};
    const name = cf.functionName || '(anonymous)';
    if (SPECIAL[name]) {
      special[SPECIAL[name]] += us;
      continue;
    }
    const key = keyOf(cf);
    const row = fns.get(key) || {
      name, url: cf.url || '', line: (cf.lineNumber ?? -1) + 1, col: (cf.columnNumber ?? -1) + 1, selfUs: 0, totalUs: totalByKey.get(key) || 0,
    };
    row.selfUs += us;
    fns.set(key, row);
    const script = cf.url || '(native)';
    scripts.set(script, (scripts.get(script) || 0) + us);
  }
  const totalUs = prof.endTime - prof.startTime;
  const scriptUs = [...fns.values()].reduce((a, r) => a + r.selfUs, 0);
  return {
    totalUs,
    idleUs: special.idle,
    programUs: special.program,
    gcUs: special.gc,
    scriptUs,
    busyUs: totalUs - special.idle,
    functions: [...fns.values()].sort((a, b) => b.selfUs - a.selfUs),
    scripts: [...scripts.entries()].map(([url, selfUs]) => ({ url, selfUs })).sort((a, b) => b.selfUs - a.selfUs),
  };
}

const ms = (us) => (us / 1000).toFixed(1);

/** Resolves script URLs to original positions using the *.js.map files under `dir`. */
export function createSymbolicator(dir) {
  const files = new Map();
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js.map')) files.set(entry.name.slice(0, -4), full);
    }
  };
  walk(dir);
  const cache = new Map();
  return (url, line, column) => {
    let base;
    try {
      base = path.basename(new URL(url).pathname);
    } catch {
      return null;
    }
    if (!files.has(base)) return null;
    if (!cache.has(base)) {
      const map = JSON.parse(fs.readFileSync(files.get(base), 'utf8'));
      cache.set(base, { map, decoded: decodeMappings(map.mappings || '', { full: true }) });
    }
    const { map, decoded } = cache.get(base);
    return originalPosition(map, decoded, line, column);
  };
}

function shortUrl(url, base) {
  if (!url) return '(native)';
  return url.startsWith(base) ? url.slice(base.length) : url.replace(/^https?:\/\//, '');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const profile = PROFILES[opts.profile];
  const out = path.resolve(opts.out || path.join(HERE, 'results', `profile-${opts.label.replace(/[^\w.-]+/g, '_')}-${opts.profile}.cpuprofile`));
  const browser = await launch({ headed: opts.headed, channel: opts.channel });
  try {
    const { page, cdp } = await openBenchPage(browser, profile, { net: opts.net ? NETWORKS[opts.net] : null });
    await page.goto(`${opts.base}${ROUTES.home}`, { waitUntil: 'load', timeout: TIMING.gotoTimeoutMs });
    const input = page.locator(SELECTORS.searchInput);
    await input.waitFor({ state: 'visible', timeout: TIMING.readyTimeoutMs });
    await settle(page, TIMING.settleMs);

    const session = cdp.session;
    await session.send('Profiler.enable');
    await session.send('Profiler.setSamplingInterval', { interval: opts.interval });
    const typeQuery = async () => {
      await pressFor(profile)(input);
      await sleep(200);
      const presses = [];
      const start = wallNow();
      const keys = [...opts.query];
      for (let i = 0; i < keys.length; i += 1) {
        const wait = start + i * TIMING.keyIntervalMs - wallNow();
        if (wait > 0) await sleep(wait);
        presses.push(page.keyboard.press(keys[i]));
      }
      await Promise.all(presses);
      return waitRowsStable(page, TIMING.rowsStableMs, 10000);
    };
    let rows;
    let t0;
    if (opts.switch) {
      // Same steps as the printlang journey; only the option press is profiled.
      await typeQuery();
      await pressFor(profile)(page.locator(SELECTORS.printLangButton).first());
      const menu = page.locator(SELECTORS.printLangMenu).first();
      await menu.waitFor({ state: 'visible', timeout: 5000 });
      const option = menu.locator(SELECTORS.langOption, { hasText: PRINT_LANG_LABELS[opts.switch] }).first();
      const button = option.locator('button');
      const target = (await button.count()) ? button.first() : option;
      await sleep(500);
      await session.send('Profiler.start');
      t0 = wallNow();
      await pressFor(profile)(target);
      rows = await waitRowsStable(page, 500, 5000);
    } else {
      await session.send('Profiler.start');
      t0 = wallNow();
      rows = await typeQuery();
    }
    const { profile: prof } = await session.send('Profiler.stop');
    const wall = wallNow() - t0;

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(prof));
    const a = analyzeProfile(prof);
    console.log(`# CPU profile: ${opts.switch ? `print language -> ${opts.switch} with ` : ''}"${opts.query}" on ${opts.base} (${opts.profile}, CPU ×${profile.cpuThrottle}, ${opts.interval} µs sampling)`);
    console.log(`window ${ms(a.totalUs)} ms (wall ${wall.toFixed(0)} ms) · busy ${ms(a.busyUs)} ms · JS self ${ms(a.scriptUs)} ms · `
      + `GC ${ms(a.gcUs)} ms · program/native ${ms(a.programUs)} ms · idle ${ms(a.idleUs)} ms · final rows ${rows ? rows.count : 0}\n`);
    const symbolicate = opts.sourcemapDir ? createSymbolicator(path.resolve(opts.sourcemapDir)) : null;
    let mapped = 0;
    console.log(`Top ${opts.top} functions by self time:`);
    console.log(`${'self ms'.padStart(9)}  ${'total ms'.padStart(9)}  ${'% busy'.padStart(6)}  function  (script:line:col)${symbolicate ? '  => original' : ''}`);
    for (const f of a.functions.slice(0, opts.top)) {
      let orig = '';
      if (symbolicate && f.url && f.line > 0) {
        const pos = symbolicate(f.url, f.line - 1, f.col - 1);
        if (pos) {
          mapped += 1;
          orig = `  => ${pos.name || f.name} ${pos.source}:${pos.line}:${pos.column}`;
        }
      }
      console.log(`${ms(f.selfUs).padStart(9)}  ${ms(f.totalUs).padStart(9)}  ${((f.selfUs / a.busyUs) * 100).toFixed(1).padStart(6)}  ${f.name}  (${shortUrl(f.url, opts.base)}:${f.line}:${f.col})${orig}`);
    }
    if (symbolicate && !mapped) console.log('(no frame matched a map in --sourcemap-dir: maps must come from the exact build being profiled)');
    console.log('\nSelf time by script:');
    for (const s of a.scripts.slice(0, 12)) {
      console.log(`${ms(s.selfUs).padStart(9)}  ${((s.selfUs / a.busyUs) * 100).toFixed(1).padStart(6)}  ${shortUrl(s.url, opts.base)}`);
    }
    console.log(`\nwrote ${path.relative(process.cwd(), out) || out} (open in DevTools > Performance or https://www.speedscope.app)`);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
