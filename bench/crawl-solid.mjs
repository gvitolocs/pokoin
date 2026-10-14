// node crawl.mjs --base http://127.0.0.1:PORT --app <worktree>/market/src/App.jsx [--only a,b]
// Loads every route the old React App served (sample params), plus game sites,
// shortlinks, unknown paths and framed pages, on the production-shaped build
// (preview.mjs --dist-web). Fails on: a [react-legacy] report, any request for
// a React chunk (/market/assets/*.js), a console error, a failed request, a page
// with no heading, or a non-Solid boot. Read-only: signed out, GETs only.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const arg = (name, fallback = '') => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const BASE = arg('base');
const app = readFileSync(arg('app'), 'utf8');
const sample = { lang: 'en', cardId: '806390', slug: 'base-set', listingId: 'abc', kind: 'graded', id: '515', deckId: '284',
  decklistId: '28752', playerId: '2875', eraId: 'ex', artistSlug: 'mitsuhiro-arita', username: 'seller', categoryId: 'general',
  topicId: 'abc123', location: 'box1', code: 'parityfixture' };
const routes = [...app.matchAll(/both\('([^']+)'/g)].map((m) => m[1]).filter((p) => p !== '/')
  .flatMap((p) => (p.includes(':slug?') ? [p.replace('/:slug?', ''), p.replace(':slug?', 'mega-rayquaza-ex')] : [p]))
  .map((p) => p.replace(/:(\w+)/g, (_, k) => sample[k] ?? 'x'));
const extra = [
  '/one-piece/marketplace', '/one-piece/marketplace/search?q=luffy', '/one-piece/marketplace/sets',
  '/one-piece/marketplace/en/cards/816522', '/magic/marketplace', '/magic/marketplace/en/cards/458094',
  '/yugioh/marketplace/search?q=dark%20magician', '/one-piece/wallet', '/806390', '/806390/some-slug',
  '/does-not-exist', '/one-piece/does-not-exist', '/marketplace?ui=react',
];
const only = arg('only') ? arg('only').split(',') : null;
const urls = only || [...new Set([...routes, ...extra])];
// Known-benign noise on any build: Google's report-only frame-ancestors CSP report.
const BENIGN = /Content Security Policy directive: "frame-ancestors|csp\.withgoogle\.com|google-analytics|googletagmanager/;

const browser = await chromium.launch();
let bad = 0;
async function visit(url, { framed = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
      // Read-only crawl: preflights and writes (analytics beacons) never leave the browser.
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
  const onConsole = (m) => { if (m.type() === 'error' && !BENIGN.test(m.text())) problems.push(`console: ${m.text().slice(0, 180)}`); };
  page.on('console', onConsole);
  page.on('pageerror', (e) => problems.push(`pageerror: ${String(e).slice(0, 180)}`));
  page.on('request', (r) => { if (/\/market\/assets\/[^?]*\.js(\?|$)/.test(r.url())) problems.push(`REACT CHUNK ${r.url()}`); });
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText || '';
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(f) && !BENIGN.test(r.url())) problems.push(`failed: ${r.method()} ${r.url().slice(0, 140)} ${f}`);
  });
  let target = page;
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
    await page.goto(`${BASE}${url}`, { waitUntil: 'load' });
  }
  await page.waitForTimeout(3500);
  const shape = await target.evaluate(() => ({
    ui: window.__POKOIN_UI__ || '',
    legacy: window.__POKOIN_REACT_LEGACY__ || '',
    at: `${location.pathname}${location.search}`,
    h1: [...document.querySelectorAll('h1')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean)[0] || '',
    root: Boolean(document.querySelector('#root > *, #app > *, body > div > *')),
  })).catch((e) => ({ ui: '', legacy: '', at: '?', h1: '', root: false, err: String(e).slice(0, 120) }));
  if (shape.ui !== 'solid') problems.push(`booted ${shape.ui || 'nothing'}`);
  if (!shape.root) problems.push('empty page');
  await context.close();
  const ok = !problems.length;
  if (!ok) bad += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${framed ? '[framed] ' : ''}${url} → ${shape.at}  h1="${shape.h1.slice(0, 50)}"${shape.legacy ? `  legacy=${shape.legacy}` : ''}${ok ? '' : `\n     ${problems.join('\n     ')}`}`);
}
for (const url of urls) await visit(url);
if (!only) for (const url of ['/marketplace/en/cards/806390', '/profile', '/marketplace/en/users/seller']) await visit(url, { framed: true });
await browser.close();
console.log(`crawl: ${urls.length + (only ? 0 : 3) - bad}/${urls.length + (only ? 0 : 3)} clean`);
process.exit(bad ? 1 : 0);
