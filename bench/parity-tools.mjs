#!/usr/bin/env node
/**
 * React vs Solid parity for the tools / boards / content pages
 * (solid/src/routes/tools.js):
 *
 *   node parity-tools.mjs --a http://127.0.0.1:28661 --b http://127.0.0.1:28662 [--only /forum,/ocr]
 *
 * For every URL both builds load in fresh contexts; the check compares the
 * document title, headings, a class histogram of the page root (same markup
 * and classes), per-page element counts, the final URL (signed-out redirects)
 * and a few interactions, and reports console errors, failed requests and
 * reloads (a NotMigrated handoff). Live API data can move between loads, so a
 * differing check is retried once. Exit 1 when anything differs.
 *
 * `--signed-in 1` runs the signed-in pages (Admin, sync review, Scan Connect)
 * against fixtures only: a fake Firebase user is seeded in IndexedDB, Google
 * identity endpoints are answered locally, and every authenticated API call
 * and every non-GET is fulfilled by the fixture table below — nothing reaches
 * production with a token, and nothing is written anywhere.
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
  console.error('usage: node parity-tools.mjs --a <react base> --b <solid base> [--only /x,/y] [--signed-in 1]');
  process.exit(2);
}
const ONLY = arg('only', '').split(',').filter(Boolean);
const SIGNED_IN = arg('signed-in', '0') === '1';
const browser = await chromium.launch();

// ---------------------------------------------------------------- fixtures (signed-in mode)

const UID = 'parityUid000000000000000000';
const API_KEY = 'AIzaSyDlbKXeR0R3aAATZtCG6dhEPUw39DhXQpU';
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function fakeIdToken() {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: 'https://securetoken.google.com/pokoin', aud: 'pokoin', auth_time: now, user_id: UID, sub: UID,
    iat: now, exp: now + 3600, email: 'parity@example.test', firebase: { sign_in_provider: 'password' },
  })}.sig`;
}
const ID_TOKEN = fakeIdToken();

const NOW = Date.now();
const FIXTURE = {
  session: {
    id: 'sess_fixture', status: 'waiting', paused: false, batchId: 'batch_fixture',
    createdAt: new Date(NOW - 5000).toISOString(),
  },
  pairing: { pin: '4821', qrSecret: 'fixture-qr-secret-not-real', expiresAt: new Date(NOW + 110000).toISOString() },
  batch: {
    id: 'batch_fixture', status: 'open',
    defaults: {
      game: 'pokemon', language: 'EN', condition: 'NM', foilState: 'standard', firstEdition: false,
      signed: false, altered: false, location: 'box1', stack: 1, startPosition: 1, stackSize: 1, quantity: 1, mergeRepeats: true,
    },
  },
  items: [
    {
      id: 'item_a', seq: 1, position: 1, status: 'active', recognitionState: 'matched', cardId: '806390',
      cardName: 'Mega Rayquaza ex', setName: 'Storm Emeralda', collectorNumber: '113/076', nationality: 'japanese',
      language: 'JP', condition: 'NM', foilState: 'standard', quantity: 1, location: 'box1', pricePkn: 1234, priceSuggested: false,
      reviewed: true, hasImage: false,
    },
    {
      id: 'item_b', seq: 2, position: 2, status: 'active', recognitionState: 'ambiguous', cardId: '',
      cardName: '', language: 'EN', condition: 'NM', foilState: 'standard', quantity: 2, location: 'box1', pricePkn: null,
      candidates: [], hasImage: false,
    },
  ],
};
const SYNC = {
  sync: {
    summary: {
      powerToolsReconcile: {
        matched: 12, locationsApplied: 3,
        ctOnly: [{ ctProductId: 'ct1', name: 'Pikachu', game: 'pokemon', condition: 'NM', language: 'EN', quantity: 1, pricePkn: 50, cardId: '806390' }],
        ptOnly: [
          { name: 'Charizard', game: 'pokemon', setName: 'Base Set', collectorNumber: '4/102', condition: 'LP', language: 'EN', quantity: 1, pricePkn: 900 },
          { name: 'Blastoise', game: 'pokemon', setName: 'Base Set', collectorNumber: '2/102', condition: 'NM', language: 'EN', quantity: 2, pricePkn: 400, location: 'b2' },
        ],
      },
    },
  },
};

/** [method, url pattern, body]: the fixture table for authenticated calls. */
const ROUTES = [
  ['POST', /\/api\/scan-session\?action=start/, () => ({ session: FIXTURE.session, batch: FIXTURE.batch, pairing: FIXTURE.pairing, serverTime: Date.now() })],
  ['POST', /\/api\/scan-session\?action=/, () => ({ session: FIXTURE.session, pairing: FIXTURE.pairing })],
  ['GET', /\/api\/scan-session/, () => ({ session: FIXTURE.session, pairing: FIXTURE.pairing })],
  ['GET', /\/api\/scan-batch\?action=image/, () => ({})],
  ['GET', /\/api\/scan-batch/, () => ({ batch: FIXTURE.batch, items: FIXTURE.items, session: FIXTURE.session })],
  ['POST', /\/api\/scan-batch/, () => ({ ok: true, batch: FIXTURE.batch, items: [] })],
  ['GET', /cardtrader.*sync|sync-status|cardtrader-sync/i, () => SYNC],
  ['GET', /expansion-symbols|expansionSymbols/i, () => ({ expansions: [
    { name: 'Base Set', symbol_image_url: 'https://cdn.pokoin.com/s/base.png', logo_image_url: '' },
    { name: 'Jungle', symbol_image_url: '', logo_image_url: 'https://cdn.pokoin.com/l/jungle.png' },
  ] })],
  ['GET', /seller-settings|sellerSettings/i, () => ({ shipFromCountry: 'it', acceptsPkn: true })],
  ['GET', /marketplace-listings|seller-listings|sellerListings/i, () => ({ listings: [] })],
  ['GET', /cardtrader-status|cardtrader\?action=status|cardtrader-connect/i, () => ({ status: { metadata: {} }, sync: { summary: {} } })],
];

async function signedInContext(context, log) {
  // Firebase persisted user (browserLocalPersistence → IndexedDB) before any script runs.
  await context.addInitScript(({ uid, apiKey, token }) => {
    const user = {
      uid, email: 'parity@example.test', emailVerified: true, isAnonymous: false, providerData: [],
      stsTokenManager: { refreshToken: 'fixture-refresh', accessToken: token, expirationTime: Date.now() + 3600 * 1000 },
      createdAt: String(Date.now()), lastLoginAt: String(Date.now()), apiKey, appName: '[DEFAULT]',
    };
    localStorage.setItem('pokoin.auth.session', JSON.stringify({ uid, signedIn: true, admin: true, at: Date.now() }));
    const open = indexedDB.open('firebaseLocalStorageDb', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
    open.onsuccess = () => {
      const tx = open.result.transaction('firebaseLocalStorage', 'readwrite');
      tx.objectStore('firebaseLocalStorage').put({ fbase_key: `firebase:authUser:${apiKey}:[DEFAULT]`, value: user });
    };
  }, { uid: UID, apiKey: API_KEY, token: ID_TOKEN });
  await context.route(/identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ users: [{ localId: UID, email: 'parity@example.test', emailVerified: true, providerUserInfo: [] }], id_token: ID_TOKEN, refresh_token: 'fixture-refresh', expires_in: '3600', user_id: UID }),
  }));
  await context.route(/firestore\.googleapis\.com/, (route) => {
    const url = route.request().url();
    if (/documents\/users\//.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        name: `projects/pokoin/databases/(default)/documents/users/${UID}`,
        fields: { uid: { stringValue: UID }, admin: { booleanValue: true }, username: { stringValue: 'parity' } },
      }) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  const handler = async (route) => {
    const request = route.request();
    const method = request.method();
    const url = request.url();
    if (/\/stream|text\/event-stream/.test(url) || request.headers().accept === 'text/event-stream') {
      log.push(`fixture ${method} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
      const hello = { session: FIXTURE.session, batch: FIXTURE.batch, serverTime: Date.now() };
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: hello\ndata: ${JSON.stringify(hello)}\n\nevent: items\ndata: ${JSON.stringify({ items: FIXTURE.items })}\n\n` });
    }
    const hit = ROUTES.find(([m, re]) => m === method && re.test(url));
    if (hit) {
      log.push(`fixture ${method} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hit[2]()) });
    }
    if (method !== 'GET' || request.headers().authorization) {
      // Never let a token or a write leave the machine.
      log.push(`blocked ${method} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fallback();
  };
  await context.route('https://api.pokoin.com/**', handler);
  await context.route(/127\.0\.0\.1:\d+\/api\//, handler);
}

// ---------------------------------------------------------------- page reads

async function snapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#root .page, #root .sanitize') || document.querySelector('#root');
    const histogram = {};
    for (const el of root ? root.querySelectorAll('[class]') : []) {
      for (const name of el.classList) histogram[name] = (histogram[name] || 0) + 1;
    }
    const text = (sel) => [...document.querySelectorAll(sel)].map((n) => n.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return {
      title: document.title,
      url: location.pathname + location.search,
      h1: text('#root h1').slice(0, 5),
      h2: text('#root h2').slice(0, 40),
      histogram,
    };
  });
}

async function counts(page, selectors) {
  const out = {};
  for (const sel of selectors) out[sel] = await page.locator(sel).count();
  return out;
}

async function settle(page, read, { quietMs = 1200, maxMs = 15000 } = {}) {
  let last = await read();
  let since = Date.now();
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await page.waitForTimeout(150);
    const next = await read();
    if (JSON.stringify(next) !== JSON.stringify(last)) {
      last = next;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) break;
  }
  return last;
}

async function withPage(base, fn) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const log = [];
  if (SIGNED_IN) await signedInContext(context, log);
  const page = await context.newPage();
  const errors = [];
  const failed = [];
  let navigations = 0;
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 160)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text().slice(0, 160));
  });
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText || '';
    if (/ERR_ABORTED/.test(reason)) return; // superseded requests / media preload cancels
    failed.push(`${request.method()} ${request.url().slice(0, 120)} ${reason}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failed.push(`${response.status()} ${response.url().slice(0, 120)}`);
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });
  try {
    const value = await fn(page, base);
    return { value, errors, failed, navigations, log };
  } finally {
    await context.close();
  }
}

const read = (page, selectors) => async () => ({ ...(await snapshot(page)), counts: await counts(page, selectors) });

function check(path, selectors, interact) {
  return {
    name: path,
    run: async (page, base) => {
      await page.goto(`${base}${path}`, { waitUntil: 'load' });
      const first = await settle(page, read(page, selectors));
      if (!interact) return { load: first };
      const after = await interact(page);
      return { load: first, after };
    },
  };
}

const BOARD = ['.test-dock a', '.sanitize-bar', '.sanitize-main h1'];
const jobs = SIGNED_IN ? [
  check('/admin', ['.thread', '.empty-desk']),
  check('/marketplace/admin/edit', ['form.desk-panel', '.sell-field input'], async (page) => {
    await page.check('input[type="checkbox"]');
    return settle(page, () => counts(page, ['form.desk-panel']));
  }),
  check('/inventory/sync-review', ['.order-row', '.stock-nav a', '.ct-pt-inline input'], async (page) => {
    await page.locator('.order-row button', { hasText: 'Skip' }).first().click();
    return settle(page, async () => ({ rows: await page.locator('.order-row').count(), note: await page.locator('.ct-connect-ok').textContent().catch(() => '') }));
  }),
  check('/inventory/scan', ['.scan-row', '.scan-pin span', '.scan-qr svg', '.sd-seg button', '.scan-intent-seg button', '.scan-manual-add input'], async (page) => {
    await page.locator('#root').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('?');
    const help = await page.locator('.scan-help').count();
    await page.keyboard.press('Escape');
    await page.click('[data-testid="scan-intent-collection"]');
    const priceCols = await page.locator('.scan-row-head [role="columnheader"]').count();
    await page.click('.sd-gear');
    const stackMenu = await page.locator('.sd-stack-menu').count();
    return { help, priceCols, stackMenu, rows: await page.locator('.scan-row').count() };
  }),
] : [
  check('/tests', [...BOARD, '.tests-card']),
  check('/sanitize', [...BOARD, '.sanitize-shot', '.sanitize-guides'], async (page) => {
    await page.click('.sanitize-toggle input');
    const guides = await page.locator('.sanitize-guides').count();
    await page.locator('.sanitize-frame').first().click();
    const dialog = await page.locator('dialog.zoom[open]').count();
    return { guides, dialog };
  }),
  check('/espurr', [...BOARD, '.espurr-group', '.sanitize-shot']),
  check('/ocr', [...BOARD, '.ocr-expansion', '.ocr-filters button', '.ocr-card'], async (page) => {
    await page.locator('.ocr-filters button').nth(1).click();
    const one = await settle(page, () => counts(page, ['.ocr-expansion']));
    await page.fill('.ocr-filters input', 'base');
    const two = await settle(page, () => counts(page, ['.ocr-expansion']));
    return { one, two };
  }),
  check('/ocr/artists', [...BOARD, '.ocr-artist-table tbody tr'], async (page) => {
    await page.fill('.ocr-filters input', 'arita');
    return settle(page, async () => ({ rows: await page.locator('.ocr-artist-table tbody tr').count(), url: await page.evaluate(() => location.search) }));
  }),
  check('/artwork', [...BOARD, '.artwork-test-case', '.tile', '.artwork-status']),
  check('/jumbos', [...BOARD, '.jumbos-set', '.jumbos-grid figure']),
  check('/poko', [...BOARD, '.poko-tile', 'audio', 'video']),
  check('/poko/archive', [...BOARD, '.poko-groups button', '.poko-clips li'], async (page) => {
    await page.locator('.poko-groups button').nth(1).click();
    const one = await settle(page, () => counts(page, ['.poko-clips li', '.poko-groups button.on']));
    await page.fill('.poko-archive-controls input', 'ep3');
    const two = await settle(page, () => page.locator('.poko-controls-count').textContent());
    return { one, two };
  }),
  check('/about', ['.about-section', '.about-surface', '.about-links a']),
  check('/careers', ['.careers-principle-card', '.careers-perk-card', '.careers-life-tile', '.careers-media-art', '.careers-dept'], async (page) => {
    await page.locator('.careers-arrow').nth(1).click();
    await page.waitForTimeout(800);
    return { prevDisabled: await page.locator('.careers-arrow').first().isDisabled() };
  }),
  check('/forum', ['.forum-cat', '.forum-topic', '.forum-empty'], async (page) => {
    const cat = await page.locator('.forum-cat').first();
    if (!(await cat.count())) return null;
    await cat.click();
    return settle(page, read(page, ['.forum-cat.on', '.forum-topic']));
  }),
  check('/forum/topic/does-not-exist', ['.forum-post', '.forum-empty', '.desk-alert']),
  check('/scan', ['.scan-stage', '.file-pill', '.scan-fields input'], async (page) => {
    await page.fill('.scan-fields input', 'umbreon');
    await page.locator('.desk-actions button.ghost').click();
    await page.waitForURL(/search/, { timeout: 10000 }).catch(() => {});
    return page.evaluate(() => location.pathname + location.search);
  }),
  check('/cardscan', ['.scan-stage']),
  // Signed out: React and Solid send these to /auth?from=… (Solid preview shows the NotMigrated note there).
  check('/admin', []),
  check('/marketplace/admin/edit', []),
  check('/inventory/scan', []),
  check('/dashboard/scan', []),
  check('/inventory/sync-review', []),
];

// ---------------------------------------------------------------- run

function differences(a, b, at = '$', out = [], limit = 8) {
  if (out.length >= limit) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[key], b[key], `${at}.${key}`, out, limit);
    return out;
  }
  out.push(`${at}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  return out;
}

/** The Solid preview has no /auth page: compare the redirect target, not the NotMigrated note. */
function comparable(value) {
  const load = value?.load;
  if (load?.url?.startsWith('/auth')) return { url: load.url };
  return value;
}

let failures = 0;
const table = [];
for (const job of jobs.filter((j) => !ONLY.length || ONLY.includes(j.name))) {
  let a;
  let b;
  let same = false;
  for (let attempt = 0; attempt < 2 && !same; attempt += 1) {
    a = await withPage(A, job.run);
    b = await withPage(B, job.run);
    same = JSON.stringify(comparable(a.value)) === JSON.stringify(comparable(b.value));
  }
  const issues = [
    ...a.errors.map((e) => `A error ${e}`), ...b.errors.map((e) => `B error ${e}`),
    ...a.failed.map((e) => `A failed ${e}`), ...b.failed.map((e) => `B failed ${e}`),
  ];
  if (b.navigations > a.navigations) issues.push(`B reloaded (${b.navigations} vs ${a.navigations} navigations)`);
  if (!same || issues.length) failures += 1;
  const load = b.value?.load || {};
  table.push({
    url: job.name,
    same,
    h1: (load.h1 || []).join(' / '),
    counts: JSON.stringify(load.counts || {}),
    errorsA: a.errors.length,
    errorsB: b.errors.length,
    failedA: a.failed.length,
    failedB: b.failed.length,
  });
  console.log(`${same ? 'SAME' : 'DIFF'} ${job.name}`);
  if (!same) for (const line of differences(comparable(a.value), comparable(b.value))) console.log(`  ${line}`);
  for (const line of issues) console.log(`  ${line}`);
  if (SIGNED_IN) for (const line of [...new Set([...a.log, ...b.log])]) console.log(`  · ${line}`);
}
await browser.close();
console.log(`\n| URL | React = Solid | Solid h1 | Solid counts | console errors R/S | failed requests R/S |`);
console.log('| --- | --- | --- | --- | --- | --- |');
for (const row of table) {
  console.log(`| \`${row.url}\` | ${row.same ? 'yes' : 'NO'} | ${row.h1} | ${row.counts.replace(/\|/g, '\\|')} | ${row.errorsA}/${row.errorsB} | ${row.failedA}/${row.failedB} |`);
}
console.log(`parity: ${table.length - failures}/${table.length} checks clean`);
process.exit(failures ? 1 : 0);
