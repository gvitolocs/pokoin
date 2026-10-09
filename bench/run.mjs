#!/usr/bin/env node
// Pokoin SPA browser benchmark runner.
//   node run.mjs --base https://pokoin.com --profile desktop|mobile --runs 10 \
//     --journeys cold,warm,search,... --label <sha> --out results/<name>.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { AUTH_JOURNEYS, NETWORKS, PROFILES, PUBLIC_JOURNEYS, TIMING } from './config.mjs';
import { launch, openBenchPage, playwrightVersion, pressFor } from './lib/browser.mjs';
import { summarizeJourney } from './lib/stats.mjs';
import * as loadJourneys from './lib/journeys-load.mjs';
import * as searchJourneys from './lib/journeys-search.mjs';
import * as navJourneys from './lib/journeys-nav.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const JOURNEYS = {
  cold: loadJourneys.cold,
  warm: loadJourneys.warm,
  search: searchJourneys.search,
  typo: searchJourneys.typo,
  printlang: searchJourneys.printlang,
  langtype: searchJourneys.langtype,
  card: navJourneys.card,
  back: navJourneys.back,
  rapid20: navJourneys.rapid20,
  scroll: loadJourneys.scroll,
  realtime: loadJourneys.realtime,
  collection: navJourneys.collection,
  checkout: navJourneys.checkout,
};

/** Metrics printed in progress lines and the final console table, when present. */
const HEADLINE = [
  'vitals.ttfb', 'vitals.fcp', 'vitals.lcp', 'vitals.cls', 'tbt', 'inp', 'inp.inputDelay',
  'keys.toRowsMs', 'keys.lastToFinalRowsMs', 'lang.toRowsMs', 'nav.toHeadingMs', 'nav.toImageMs', 'back.toResultsMs',
  'back.scrollRestored', 'rapid.totalMs', 'scroll.gapsOver33', 'lt.count', 'lt.blockingMs',
  'cpu.scriptMs', 'mem.heapPeakMB', 'net.downloads', 'net.bytes', 'net.apiCalls',
];

const USAGE = `usage: node run.mjs [options]
  --base <url>            site origin (default https://pokoin.com)
  --profile <name>        desktop | mobile (default desktop)
  --runs <n>              repetitions of every journey (default 5)
  --journeys <a,b,...>    ${[...PUBLIC_JOURNEYS, ...AUTH_JOURNEYS].join(',')}
                          (default: all public ones, plus auth ones with --auth-state)
  --label <text>          build label, e.g. the git sha (default unlabeled)
  --out <file>            result JSON (default results/<label>-<profile>-<time>.json)
  --net <preset>          ${Object.keys(NETWORKS).join(' | ')} | none (default none)
  --auth-state <file>     Playwright storageState JSON for collection/checkout
  --cooldown <ms>         pause between journeys (default 1000)
  --journey-timeout <ms>  per-journey limit (default ${TIMING.journeyTimeoutMs})
  --channel <name>        chromium (new headless, default) | headless-shell | chrome
  --headed                show the browser
  --verbose               journey debug logging`;

function parseArgs(argv) {
  const opts = {
    base: 'https://pokoin.com',
    profile: 'desktop',
    runs: 5,
    journeys: null,
    label: 'unlabeled',
    out: null,
    net: null,
    authState: null,
    cooldown: 1000,
    journeyTimeout: TIMING.journeyTimeoutMs,
    channel: 'chromium',
    headed: false,
    verbose: false,
  };
  const flags = new Set(['headed', 'verbose', 'help']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq > 0 ? eq : undefined);
    if (flags.has(name)) {
      opts[name] = true;
      continue;
    }
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value == null) throw new Error(`--${name} needs a value`);
    const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(key in opts)) throw new Error(`unknown option --${name}`);
    opts[key] = value;
  }
  if (opts.help) return opts;
  opts.base = opts.base.replace(/\/+$/, '');
  opts.runs = Number.parseInt(opts.runs, 10);
  opts.cooldown = Number(opts.cooldown);
  opts.journeyTimeout = Number(opts.journeyTimeout);
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error('--runs must be a positive integer');
  if (!PROFILES[opts.profile]) throw new Error(`unknown profile ${opts.profile}`);
  if (opts.net === 'none') opts.net = null;
  if (opts.net && !NETWORKS[opts.net]) throw new Error(`unknown --net ${opts.net}`);
  if (opts.authState && !fs.existsSync(opts.authState)) throw new Error(`--auth-state ${opts.authState} not found`);
  const list = opts.journeys
    ? opts.journeys.split(',').map((s) => s.trim()).filter(Boolean)
    : [...PUBLIC_JOURNEYS, ...(opts.authState ? AUTH_JOURNEYS : [])];
  for (const name of list) {
    if (!JOURNEYS[name]) throw new Error(`unknown journey ${name}`);
  }
  opts.journeys = list;
  return opts;
}

function median(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function fmt(value) {
  if (value == null || !Number.isFinite(value)) return '-';
  if (Number.isInteger(value)) return String(value);
  return Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 1 ? value.toFixed(1) : value.toFixed(3);
}

/** One-line digest of a run: headline metrics (arrays shown as their median). */
function digest(metrics) {
  const parts = [];
  for (const key of HEADLINE) {
    if (!(key in metrics)) continue;
    const value = metrics[key];
    parts.push(Array.isArray(value) ? `${key}~${fmt(median(value))}` : `${key}=${fmt(value)}`);
  }
  return parts.join(' ');
}

function environment(opts, browser, userAgent) {
  const cpus = os.cpus();
  return {
    timestamp: new Date().toISOString(),
    base: opts.base,
    label: opts.label,
    profile: opts.profile,
    net: opts.net || 'none',
    runs: opts.runs,
    journeys: opts.journeys,
    cpuThrottle: PROFILES[opts.profile].cpuThrottle,
    viewport: PROFILES[opts.profile].viewport,
    userAgent,
    channel: opts.channel,
    headed: opts.headed,
    browserVersion: browser.version(),
    playwrightVersion: playwrightVersion(),
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    hostname: os.hostname(),
    cpuCount: cpus.length,
    cpuModel: cpus[0] ? cpus[0].model : null,
    totalMemMB: Math.round(os.totalmem() / 1048576),
    loadavgStart: os.loadavg().map((v) => Math.round(v * 100) / 100),
    loadavgEnd: null,
    durationMs: null,
    argv: process.argv.slice(2),
  };
}

function defaultOut(opts) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const label = opts.label.replace(/[^\w.-]+/g, '_');
  return path.join(HERE, 'results', `${label}-${opts.profile}${opts.net ? `-${opts.net}` : ''}-${stamp}.json`);
}

function writeResult(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 1)}\n`);
}

async function runJourney(browser, opts, name, run) {
  const profile = PROFILES[opts.profile];
  const opened = [];
  const env = {
    base: opts.base,
    profileName: opts.profile,
    profile,
    opts,
    press: pressFor(profile),
    log: (msg) => {
      if (opts.verbose) console.error(`    [${name}] ${msg}`);
    },
    newPage: async ({ auth = false } = {}) => {
      const handle = await openBenchPage(browser, profile, {
        net: opts.net ? NETWORKS[opts.net] : null,
        storageState: auth ? opts.authState : null,
      });
      opened.push(handle.context);
      return handle;
    },
  };
  const t0 = performance.now();
  let timer = null;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`journey timed out after ${opts.journeyTimeout} ms`)), opts.journeyTimeout);
    });
    const result = await Promise.race([JOURNEYS[name](env), timeout]);
    const wallMs = Math.round(performance.now() - t0);
    if (result && result.skipped) return { run, ok: false, skipped: result.skipped, wallMs };
    return { run, ok: true, wallMs, metrics: result.metrics, detail: result.detail };
  } catch (err) {
    const message = err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err);
    return { run, ok: false, error: message, wallMs: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
    await Promise.all(opened.map((context) => context.close().catch(() => {})));
  }
}

function summaryTable(data) {
  const rows = [];
  for (const [journey, summary] of Object.entries(data.summary)) {
    const runs = data.runs[journey];
    const ok = runs.filter((r) => r.ok).length;
    const skipped = runs.find((r) => r.skipped);
    if (skipped) {
      rows.push(`${journey.padEnd(10)} skipped: ${skipped.skipped}`);
      continue;
    }
    rows.push(`${journey.padEnd(10)} ok ${ok}/${runs.length}`);
    for (const key of HEADLINE) {
      const s = summary[key];
      if (!s || !s.n) continue;
      rows.push(`  ${key.padEnd(24)} n=${String(s.n).padEnd(4)} p50=${fmt(s.p50).padEnd(9)} p95=${fmt(s.p95).padEnd(9)} max=${fmt(s.max)}`);
    }
  }
  return rows.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const out = opts.out ? path.resolve(opts.out) : defaultOut(opts);
  const browser = await launch({ headed: opts.headed, channel: opts.channel });
  const probe = await openBenchPage(browser, PROFILES[opts.profile]);
  const userAgent = await probe.page.evaluate(() => navigator.userAgent);
  await probe.context.close();

  const data = {
    schema: 1,
    environment: environment(opts, browser, userAgent),
    runs: Object.fromEntries(opts.journeys.map((name) => [name, []])),
    summary: {},
  };
  const t0 = performance.now();
  const finish = (partial) => {
    data.environment.loadavgEnd = os.loadavg().map((v) => Math.round(v * 100) / 100);
    data.environment.durationMs = Math.round(performance.now() - t0);
    if (partial) data.partial = true;
    for (const name of opts.journeys) data.summary[name] = summarizeJourney(data.runs[name]);
    writeResult(out, data);
  };
  process.once('SIGINT', () => {
    finish(true);
    console.error(`\ninterrupted: partial results written to ${out}`);
    process.exit(130);
  });

  console.error(`pokoin bench: ${opts.base} profile=${opts.profile} net=${opts.net || 'none'} runs=${opts.runs} `
    + `journeys=${opts.journeys.join(',')} chromium ${browser.version()} load=${os.loadavg()[0].toFixed(2)}`);
  for (let run = 1; run <= opts.runs; run += 1) {
    for (const name of opts.journeys) {
      const result = await runJourney(browser, opts, name, run);
      data.runs[name].push(result);
      const tag = `[${opts.profile} ${run}/${opts.runs}] ${name.padEnd(10)}`;
      if (result.ok) console.error(`${tag} ok ${(result.wallMs / 1000).toFixed(1)}s ${digest(result.metrics)}`);
      else if (result.skipped) console.error(`${tag} skipped: ${result.skipped}`);
      else console.error(`${tag} FAILED ${result.error}`);
      if (opts.cooldown > 0) await new Promise((resolve) => setTimeout(resolve, opts.cooldown));
    }
  }
  await browser.close();
  finish(false);
  console.log(summaryTable(data));
  console.log(`\nwrote ${path.relative(process.cwd(), out) || out}`);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  if (/^(unknown|unexpected|--)/.test(err && err.message)) console.error(USAGE);
  process.exit(1);
});
