// Crawl every route the old React App served on the production-shaped Solid build:
//   git show origin/main~N:market/src/App.jsx > /tmp/App.jsx   # the last commit that had it
//   node solid/scripts/preview.mjs --dist-web <out> --port PORT
//   node crawl-solid.mjs --base http://127.0.0.1:PORT --app /tmp/App.jsx [--only a,b] [--md table.md]
// Loads every both('…') route (sample params), plus game sites, shortlinks, unknown
// paths and framed pages. Fails a page on: a `[react-legacy]` console error (logged
// with the page URL), any request for React code (the old /market/assets/*.js entry,
// or a script whose body is React), a console error, a failed request, an empty page,
// or no Solid entry. The `?ui=react` link and a stored React preference must trip the
// [react-legacy] wire instead. Read-only: signed out, GETs only (writes are answered
// in the browser and never leave it).
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const arg = (name, fallback = '') => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const BASE = arg('base');
const app = readFileSync(arg('app'), 'utf8');
const sample = { lang: 'en', cardId: '806390', slug: 'base-set', listingId: 'abc', kind: 'graded', id: '515', deckId: '284',
  decklistId: '28752', playerId: '2875', eraId: 'ex', artistSlug: 'mitsuhiro-arita', username: 'seller', categoryId: 'general',
  topicId: 'abc123', location: 'box1', code: 'parityfixture' };
const routes = [...app.matchAll(/both\('([^']+)'/g)].map((m) => m[1]).filter((p) => p !== '/')
  .filter((p) => !app.includes(`import.meta.env.DEV ? both('${p}'`))
  .flatMap((p) => (p.includes(':slug?') ? [p.replace('/:slug?', ''), p.replace(':slug?', 'mega-rayquaza-ex')] : [p]))
  .map((p) => p.replace(/:(\w+)/g, (_, k) => sample[k] ?? 'x'));
const extra = [
  '/', '/one-piece/marketplace', '/one-piece/marketplace/search?q=luffy', '/one-piece/marketplace/sets',
  '/one-piece/marketplace/en/cards/816522', '/magic/marketplace', '/magic/marketplace/en/cards/458094',
  '/yugioh/marketplace/search?q=dark%20magician', '/one-piece/wallet', '/806390', '/806390/some-slug',
  '/does-not-exist', '/marketplace/does-not-exist', '/one-piece/does-not-exist',
];
/** Visits that must trip the [react-legacy] wire: { url, pref } (pref = stored pokoin.ui). */
const TRIPWIRES = [
  { url: '/marketplace?ui=react', pref: '', reason: 'ui=react' },
  { url: '/marketplace/sets', pref: 'react-auto', reason: 'pref:react-auto' },
];
const only = arg('only') ? arg('only').split(',') : null;
const urls = only || [...new Set([...routes, ...extra])];
// Known-benign noise on any build: Google's report-only frame-ancestors CSP report.
const BENIGN = /Content Security Policy directive: "frame-ancestors|csp\.withgoogle\.com|google-analytics|googletagmanager/;
/** React's runtime, minified or not: its error-decoder URL and element symbols. */
const REACT_CODE = /react\.dev\/errors|reactjs\.org\/docs\/error-decoder|__REACT_DEVTOOLS_GLOBAL_HOOK__|Symbol\.for\("react\.(?:transitional\.)?element"\)/;

const browser = await chromium.launch();
const rows = [];
let bad = 0;

async function visit(url, { framed = false, pref = '', expectLegacy = '' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  if (pref) {
    // A visitor who once picked React: the stored preference exists before the first load only.
    await context.addInitScript((value) => {
      if (!sessionStorage.getItem('crawl.seeded')) {
        sessionStorage.setItem('crawl.seeded', '1');
        localStorage.setItem('pokoin.ui', value);
      }
    }, pref);
  }
  // Production-shaped calls from the local origin (bench/parity.mjs sameOriginApi):
  // the API sees Origin pokoin.com, and /card-images 301s to the CDN as on pokoin.com.
  await context.route('https://api.pokoin.com/**', async (route) => {
    try {
      const request = route.request();
      const cors = {
        'access-control-allow-origin': request.headers().origin || BASE,
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': request.headers()['access-control-request-headers'] || '*',
      };
      // Read-only crawl: preflights and writes (client-error reports, beacons) never leave the browser.
      if (!['GET', 'HEAD'].includes(request.method())) return await route.fulfill({ status: 204, headers: cors });
      const response = await route.fetch({ headers: { ...request.headers(), origin: 'https://pokoin.com' } });
      await route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    } catch (_) { /* closed in flight */ }
  });
  await context.route('**/card-images/**', (route) => route.fulfill({
    status: 301,
    headers: { location: route.request().url().replace(/^.*\/card-images\//, 'https://cdn.pokoin.com/') },
  }).catch(() => {}));
  const page = await context.newPage();
  const problems = [];
  const legacy = [];
  let solidEntry = false;
  let jsBytes = 0;
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (text.includes('[react-legacy]')) {
      legacy.push(text);
      if (!expectLegacy) console.error(`[react-legacy] ${BASE}${url}: ${text.slice(0, 200)}`);
      return;
    }
    if (!BENIGN.test(text)) problems.push(`console: ${text.slice(0, 180)}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${String(e).slice(0, 180)}`));
  page.on('request', (r) => {
    const href = r.url();
    if (/\/market\/assets\/[^?]*\.js(\?|$)/.test(href)) problems.push(`REACT CHUNK ${href}`);
    if (/\/market\/s\/index-[\w-]+\.js(\?|$)/.test(href)) solidEntry = true;
  });
  page.on('response', async (response) => {
    const href = response.url();
    if (!href.startsWith(BASE) || !/\.js(\?|$)/.test(href)) return;
    try {
      const body = await response.text();
      jsBytes += Number(response.headers()['content-length']) || Buffer.byteLength(body);
      if (REACT_CODE.test(body)) problems.push(`REACT CODE in ${href}`);
    } catch (_) { /* navigated away */ }
  });
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText || '';
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(f) && !BENIGN.test(r.url())) problems.push(`failed: ${r.method()} ${r.url().slice(0, 140)} ${f}`);
  });
  let target = page;
  let status = 0;
  if (framed) {
    // Same-origin parent (frame-ancestors allows self): the frame boot path, not a CSP test.
    await page.goto(`${BASE}/marketplace`, { waitUntil: 'load' });
    await page.evaluate((src) => {
      const frame = document.createElement('iframe');
      frame.id = 'crawl-frame';
      frame.src = src;
      frame.style.cssText = 'width:1200px;height:900px';
      document.body.appendChild(frame);
    }, `${BASE}${url}`);
    const handle = await page.waitForSelector('#crawl-frame', { state: 'attached' });
    target = await handle.contentFrame();
    await target.waitForLoadState('load');
  } else {
    const response = await page.goto(`${BASE}${url}`, { waitUntil: 'load' });
    status = response?.status() || 0;
  }
  await page.waitForTimeout(3500);
  const shape = await target.evaluate(() => ({
    legacy: window.__POKOIN_REACT_LEGACY__ || '',
    at: `${location.pathname}${location.search}`,
    h1: [...document.querySelectorAll('h1')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean)[0] || '',
    root: Boolean(document.querySelector('#root > *')),
    landing: !document.querySelector('#root') && Boolean(document.querySelector('body > *')),
  })).catch((e) => ({ legacy: '', at: '?', h1: '', root: false, landing: false, err: String(e).slice(0, 120) }));
  const landing = url === '/' && shape.landing;
  const notFound = status === 404;
  if (!landing && !notFound) {
    if (!solidEntry) problems.push('no Solid entry loaded');
    if (!shape.root) problems.push('empty page');
  }
  if (expectLegacy) {
    if (!legacy.some((text) => text.includes(`[react-legacy] ${expectLegacy}`))) problems.push(`expected a [react-legacy] ${expectLegacy} report`);
  } else if (legacy.length) {
    problems.push(`REACT-LEGACY ${legacy[0].slice(0, 160)}`);
  }
  await context.close();
  const ok = !problems.length;
  if (!ok) bad += 1;
  const label = `${framed ? '[framed] ' : ''}${pref ? `[pokoin.ui=${pref}] ` : ''}${url}`;
  rows.push({ url: label, status, at: landing ? '/ (landing)' : (notFound ? '404 (edge)' : shape.at), h1: landing ? '(landing)' : shape.h1, ok, problems, legacy: shape.legacy, jsBytes });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} → ${rows.at(-1).at}  h1="${shape.h1.slice(0, 50)}"${shape.legacy ? `  legacy=${shape.legacy}` : ''}${ok ? '' : `\n     ${problems.join('\n     ')}`}`);
}

for (const url of urls) await visit(url);
if (!only) {
  for (const url of ['/marketplace/en/cards/806390', '/profile', '/marketplace/en/users/seller']) await visit(url, { framed: true });
  for (const wire of TRIPWIRES) await visit(wire.url, { pref: wire.pref, expectLegacy: wire.reason });
}
await browser.close();
const md = arg('md');
if (md) {
  const cell = (text) => String(text || '').replace(/\|/g, '\\|');
  const lines = ['| # | URL | final URL | heading | result |', '| --- | --- | --- | --- | --- |'];
  rows.forEach((row, index) => lines.push(`| ${index + 1} | \`${cell(row.url)}\` | \`${cell(row.at)}\` | ${cell(row.h1.slice(0, 60))} | ${row.ok ? 'OK' : `FAIL: ${cell(row.problems.join('; ').slice(0, 200))}`} |`));
  writeFileSync(md, `${lines.join('\n')}\n`);
}
console.log(`crawl: ${rows.length - bad}/${rows.length} clean`);
process.exit(bad ? 1 : 0);
