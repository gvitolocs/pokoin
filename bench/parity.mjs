#!/usr/bin/env node
/**
 * Functional parity between two builds of the SPA (React vs Solid), the release
 * gate for the Solid canary:
 *
 *   node parity.mjs --a http://127.0.0.1:28511 --b http://127.0.0.1:28510 [--checks home,suggest] [--queries a,b]
 *
 * Each check loads the same page on both builds in fresh contexts and compares
 * what a user sees. Live API data can move between the two loads, so a check
 * that differs is retried once before it counts as a mismatch. Exit code 1 when
 * any check differs (2 on usage errors). API calls are normalised to the
 * pokoin.com Origin (see sameOriginApi; --same-origin-api 0 turns it off).
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const A = arg('a');
const B = arg('b');
if (!A || !B) {
  console.error('usage: node parity.mjs --a <base> --b <base> [--checks home,suggest] [--queries q1,q2]');
  process.exit(2);
}
const CHECKS = arg('checks', 'home,suggest').split(',').filter(Boolean);
const QUERIES = arg('queries', 'pikachu,pikahcu,charizard,miikyu ex,eevee i,hgss energy,palkia legen,061 shieldon,dawe,umbreon vmax').split(',');

const browser = await chromium.launch();

/**
 * The API varies on Origin and Cloudflare caches each variant separately, so two
 * previews on different ports can read different snapshots of the same rail.
 * Send every API call as pokoin.com does (one shared cache entry) and relax the
 * CORS response for the local origin; the bodies are untouched.
 */
async function sameOriginApi(context) {
  await context.route('https://api.pokoin.com/**', async (route) => {
    try {
      const request = route.request();
      const response = await route.fetch({ headers: { ...request.headers(), origin: 'https://pokoin.com' } });
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
    } catch (_) {
      /* the page or context closed with the request in flight */
    }
  });
}

async function withPage(base, fn) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (arg('same-origin-api', '1') !== '0') await sameOriginApi(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 200)));
  try {
    return { ...(await fn(page, base)), errors };
  } finally {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
  }
}

/** Poll `read` until its value is unchanged for `quietMs` (network pages, hydration). */
async function settle(page, read, { quietMs = 1500, maxMs = 15000 } = {}) {
  let last = await read();
  let since = Date.now();
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await page.waitForTimeout(100);
    const next = await read();
    if (JSON.stringify(next) !== JSON.stringify(last)) {
      last = next;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      break;
    }
  }
  return last;
}

async function home(page, base) {
  await page.goto(`${base}/marketplace`, { waitUntil: 'load' });
  const value = await settle(page, () => page.$$eval('section.carousel', (sections) => sections.map((section) => ({
    title: section.querySelector('h2')?.textContent?.trim() || '',
    tiles: [...section.querySelectorAll('a.tile')].map((tile) => `${tile.getAttribute('href')}|${tile.querySelector('.price, .oos')?.textContent?.trim() || ''}`),
  }))));
  return { value };
}

async function suggest(page, base, query) {
  await page.goto(`${base}/marketplace`, { waitUntil: 'load' });
  await page.waitForSelector('#market-search', { timeout: 60000 });
  await page.click('#market-search');
  await page.waitForTimeout(1500);
  for (const ch of query) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(110);
  }
  const value = await settle(page, async () => ({
    rows: await page.$$eval('#market-suggest [data-suggest-id]', (rows) => rows.map((row) => row.getAttribute('data-suggest-id'))),
    footer: await page.$eval('.suggest-all', (node) => node.textContent.trim()).catch(() => ''),
  }));
  return { value };
}

/** Up to `limit` paths where two JSON values differ (`carousels[1].tiles[3]: a → b`). */
function differences(a, b, at = '$', out = [], limit = 6) {
  if (out.length >= limit) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) differences(a[key], b[key], `${at}.${key}`, out, limit);
    return out;
  }
  out.push(`${at}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  return out;
}

const jobs = [];
if (CHECKS.includes('home')) jobs.push({ name: 'home', run: (page, base) => home(page, base) });
if (CHECKS.includes('suggest')) {
  for (const query of QUERIES) jobs.push({ name: `suggest:${query}`, run: (page, base) => suggest(page, base, query) });
}

let failures = 0;
for (const job of jobs) {
  let a;
  let b;
  let same = false;
  for (let attempt = 0; attempt < 2 && !same; attempt += 1) {
    a = await withPage(A, job.run);
    b = await withPage(B, job.run);
    same = JSON.stringify(a.value) === JSON.stringify(b.value);
  }
  const errors = [...a.errors.map((e) => `A ${e}`), ...b.errors.map((e) => `B ${e}`)];
  if (!same || errors.length) failures += 1;
  console.log(`${same ? 'SAME' : 'DIFF'} ${job.name}${errors.length ? `  errors: ${errors.join(' | ')}` : ''}`);
  if (!same) {
    for (const line of differences(a.value, b.value)) console.log(`  ${line}`);
  }
}
await browser.close();
console.log(`parity: ${jobs.length - failures}/${jobs.length} checks identical`);
process.exit(failures ? 1 : 0);
