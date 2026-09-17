#!/usr/bin/env node
// Scan Connect end-to-end: real desktop SPA (Vite) + real phone page
// (BattleScan web/index.html + static/scan-connect.js) + real CardVault
// handlers on a throwaway Postgres. Only the GPU identify service is replaced
// by a scripted queue, because recognition quality is not what this tests.
//
// Run on nezopt (Chromium + playwright-core present):
//   SCAN_TEST_DATABASE_URL=postgres://postgres:scantest@127.0.0.1:55432/scantest \
//   node scripts/scan-connect-e2e.mjs
//
// Env: CARDVAULT_DIR, BATTLESCAN_DIR, PLAYWRIGHT_CORE (module dir), E2E_HEADFUL=1,
// E2E_SHOTS=<dir> to save screenshots.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const projects = path.resolve(repo, '..');
const CARDVAULT = process.env.CARDVAULT_DIR || path.join(projects, 'cardvault', 'pokemon_card_vault');
const BATTLESCAN = process.env.BATTLESCAN_DIR || path.join(projects, 'BattleScan');
const PLAYWRIGHT = process.env.PLAYWRIGHT_CORE || path.join(projects, 'pokemon-card-extension', 'node_modules', 'playwright-core');
const DB_URL = process.env.SCAN_TEST_DATABASE_URL;
const API_PORT = 18990;
const VITE_PORT = 5199;
const PHONE_PORT = 5198;
const SELLER = 'e2e-seller-0000000000001';
const SHOTS = process.env.E2E_SHOTS || '';

if (!DB_URL) {
  console.error('SCAN_TEST_DATABASE_URL is required (throwaway database).');
  process.exit(2);
}

const require = createRequire(path.join(CARDVAULT, 'package.json'));
const { Pool } = require('pg');
const { chromium, devices } = createRequire(import.meta.url)(PLAYWRIGHT);

const children = [];
function start(name, cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  child.log = log;
  child.name = name;
  children.push(child);
  return child;
}

async function waitHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch (_) {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${url}`);
}

// ---------------------------------------------------------------- phone host + fake identify

const box = { xyxy: [180, 90, 780, 930], score: 0.97 };
let scene = null; // null = empty table, else { hits: [[id, score], ...] }
const identifyLatencyMs = Number(process.env.E2E_IDENTIFY_MS || 60);

function sceneResponse(catalog) {
  const hits = scene ? scene.hits.map(([public_id, score]) => ({ public_id, score, name: `card ${public_id}` })) : [];
  return {
    ok: true,
    identity: 'public_id',
    catalog,
    img_w: 960,
    img_h: 720,
    boxes: scene ? [box] : [],
    hits,
    top1: hits[0] || null,
    cards: [],
  };
}

const phoneServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PHONE_PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (url.pathname === '/identify' && req.method === 'POST') {
    req.resume();
    await new Promise((r) => req.on('end', r));
    await new Promise((r) => setTimeout(r, identifyLatencyMs));
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(sceneResponse(url.searchParams.get('catalog'))));
  }
  if (url.pathname === '/catalogs') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ catalogs: ['pokemon_western', 'pokemon_japanese', 'pokemon_chinese', 'pokemon_generic', 'one_piece_english', 'one_piece_japanese', 'one_piece_singles', 'riftbound_western'].map((id) => ({ id })) }));
  }
  if (url.pathname === '/connect' || url.pathname === '/') {
    const html = fs.readFileSync(path.join(BATTLESCAN, 'web', 'index.html'), 'utf8').replace(
      '<script src="/static/scan-connect.js"></script>',
      `<script>window.SCAN_CONNECT_API="http://127.0.0.1:${API_PORT}";window.CARDSCAN_API="http://127.0.0.1:${PHONE_PORT}";</script>\n  <script src="/static/scan-connect.js"></script>`,
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(html);
  }
  if (url.pathname.startsWith('/static/')) {
    const file = path.join(BATTLESCAN, 'web', url.pathname);
    if (file.startsWith(path.join(BATTLESCAN, 'web', 'static')) && fs.existsSync(file)) {
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'image/png');
      return res.end(fs.readFileSync(file));
    }
  }
  res.statusCode = 404;
  res.end('not found');
});

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function showCard(hits, holdMs = 900) {
  scene = { hits };
  await sleep(holdMs);
  scene = null;
  await sleep(900); // ≥ 2 empty frames at 280 ms re-arms the phone
}

async function rows(page) {
  return page.$$eval('.scan-queue .scan-row:not(.scan-row-head)', (els) => els.map((el) => {
    const selects = el.querySelectorAll('select');
    return {
      id: el.getAttribute('data-row'),
      card: el.querySelector('.c-card strong')?.textContent || '',
      language: selects[0]?.value || el.querySelector('.c-lang')?.textContent,
      condition: selects[1]?.value || el.querySelector('.c-cond')?.textContent,
      finish: selects[2]?.value || el.querySelector('.c-finish')?.textContent,
      qty: Number(el.querySelector('.c-qty')?.textContent),
      location: el.querySelector('.c-loc input')?.value ?? el.querySelector('.c-loc')?.textContent,
      price: el.querySelector('.c-price input')?.value ?? '',
      state: el.querySelector('.c-state')?.textContent || '',
    };
  }));
}

async function waitRows(page, n, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await rows(page);
    if (last.length === n) return last;
    await sleep(100);
  }
  throw new Error(`expected ${n} rows, saw ${last.length}: ${JSON.stringify(last)}`);
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

async function focusRow(page, index) {
  await page.locator('.scan-queue .scan-row:not(.scan-row-head) .c-num').nth(index).click();
}

let qrPhoneRef = null;
let qrLinkRef = '';
const results = [];
const debugPages = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`ok   ${name} (${Date.now() - t0} ms)`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
    throw error;
  }
}

// ---------------------------------------------------------------- run

async function main() {
  const api = start('api', process.execPath, ['scripts/scan-connect-dev-server.js', '--reset'], {
    cwd: CARDVAULT,
    env: { ...process.env, SCAN_DEV_FAKE_AUTH: '1', PORT: String(API_PORT), NODE_ENV: 'development' },
  });
  const vite = start('vite', process.execPath, [path.join(repo, 'market', 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: path.join(repo, 'market'),
    env: { ...process.env, POKOIN_API_PROXY: `http://127.0.0.1:${API_PORT}` },
  });
  await new Promise((r) => phoneServer.listen(PHONE_PORT, '127.0.0.1', r));
  await waitHttp(`http://127.0.0.1:${API_PORT}/api/scan-session?sessionId=x`);
  await waitHttp(`http://127.0.0.1:${VITE_PORT}/inventory/scan`);

  const browser = await chromium.launch({
    headless: process.env.E2E_HEADFUL !== '1',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const phoneCtx = await browser.newContext({ ...devices['iPhone 13'], permissions: ['camera'] });
  const desktop = await desktopCtx.newPage();
  const phone = await phoneCtx.newPage();
  desktop.on('pageerror', (e) => console.log('desktop pageerror', e.message));
  desktop.on('console', (m) => {
    if (m.type() === 'error') console.log('desktop console', m.text().slice(0, 300));
  });
  debugPages.push(['desktop', desktop], ['phone', phone]);
  phone.on('pageerror', (e) => console.log('phone pageerror', e.message));

  // Answer the SPA's desk-session request the way the Chrome extension does
  // (market/src/auth.jsx). The API side accepts `seller:<uid>` only in dev.
  await desktopCtx.addInitScript((uid) => {
    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'POKOIN_EXTENSION_DESK_SESSION_REQUEST') {
        window.postMessage({
          type: 'POKOIN_EXTENSION_DESK_SESSION',
          source: 'pokemon-card-extension',
          token: `seller:${uid}`,
          uid,
          expiresAt: Date.now() + 3600_000,
        }, window.location.origin);
      }
    });
  }, SELLER);
  const injectSession = async () => {};

  let pin = '';
  await step('desktop opens Scan and a 4-digit PIN appears', async () => {
    await desktop.goto(`http://127.0.0.1:${VITE_PORT}/inventory/scan`);
    await desktop.waitForTimeout(400);
    await injectSession();
    await desktop.waitForSelector('.scan-pin span', { timeout: 15_000 });
    pin = (await desktop.$$eval('.scan-pin span', (els) => els.map((e) => e.textContent).join('')));
    assert.match(pin, /^[0-9]{4}$/);
    assert.ok(await desktop.$('.scan-qr svg path'), 'QR rendered');
    await shot(desktop, '01-desktop-connect');
  });

  await step('mobile enters the PIN on the keypad and connects', async () => {
    await phone.goto(`http://127.0.0.1:${PHONE_PORT}/connect`);
    await phone.waitForSelector('.sc-key');
    await shot(phone, '02-phone-keypad');
    for (const d of pin) await phone.locator('.sc-key', { hasText: new RegExp(`^${d}$`) }).click();
    await phone.waitForSelector('.sc-bar:not([hidden])', { timeout: 10_000 });
    assert.equal(await phone.isHidden('#scanConnectPanel'), true);
  });

  await step('desktop shows the phone as connected', async () => {
    await desktop.waitForFunction(() => /iPhone connected|Scanning/.test(document.querySelector('.scan-status')?.textContent || ''), null, { timeout: 10_000 });
    assert.equal(await desktop.$('.scan-pin'), null, 'PIN panel gone after pairing');
    await shot(phone, '03-phone-connected');
  });

  await step('Shift+G sets the Batch Default language to Italian (PowerTools g)', async () => {
    await desktop.locator('.scan-queue').focus();
    await desktop.keyboard.press('Shift+KeyG');
    await desktop.waitForFunction(() => document.querySelector('.scan-defaults select')?.value === 'IT');
    await desktop.waitForTimeout(250);
  });

  await step('three cards scanned on the phone arrive as Italian rows', async () => {
    await showCard([['220962', 0.93]]);
    await showCard([['233564', 0.94], ['233090', 0.61]]);
    await showCard([['240808', 0.95]]);
    const list = await waitRows(desktop, 3);
    assert.deepEqual(list.map((r) => r.language), ['IT', 'IT', 'IT']);
    assert.deepEqual(list.map((r) => r.card), ['Espurr', 'Pikachu δ', 'Tapu Lele GX']);
  });

  await step('typing in a text field never triggers row shortcuts', async () => {
    await focusRow(desktop, 0);
    const input = desktop.locator('.scan-defaults input').first();
    await input.click();
    await input.fill('');
    await desktop.keyboard.type('Box A12');
    await desktop.keyboard.press('Enter');
    await desktop.waitForTimeout(400);
    const list = await rows(desktop);
    assert.equal(list[0].language, 'IT', '"a" in the input did not switch to EN');
    assert.equal(list[0].condition, 'NM');
    assert.equal(await desktop.inputValue('.scan-defaults input'), 'Box A12');
  });

  await step('Shift+A switches the default to English; Italian rows stay Italian', async () => {
    await desktop.locator('.scan-queue').focus();
    await desktop.keyboard.press('Shift+KeyA');
    await desktop.waitForFunction(() => document.querySelector('.scan-defaults select')?.value === 'EN');
    await desktop.waitForTimeout(250);
    await showCard([['504600', 0.78], ['233564', 0.74]], 1700); // ambiguous
    const list = await waitRows(desktop, 4);
    assert.deepEqual(list.map((r) => r.language), ['IT', 'IT', 'IT', 'EN']);
    assert.deepEqual(list.map((r) => r.location), ['', '', '', 'Box A12'], 'location snapshots too');
    assert.match(list[3].state, /Check match/);
  });

  await step('phone reload keeps the pairing; desktop refresh keeps the batch', async () => {
    await phone.reload();
    await phone.waitForSelector('.sc-bar:not([hidden])', { timeout: 10_000 });
    await desktop.reload();
    await desktop.waitForTimeout(400);
    await injectSession();
    await waitRows(desktop, 4, 15_000);
    await desktop.waitForFunction(() => /connected|Scanning/.test(document.querySelector('.scan-status')?.textContent || ''), null, { timeout: 10_000 });
  });

  await step('two identical copies in a row become one row with Qty 2 and an Undo toast', async () => {
    await showCard([['241092', 0.96]]);
    await showCard([['241092', 0.96]]);
    const list = await waitRows(desktop, 5);
    assert.equal(list[4].qty, 2);
    await desktop.waitForSelector('.scan-toast:has-text("Qty 1 → 2")', { timeout: 5000 });
    await shot(desktop, '04-desktop-queue');
  });

  await step('ambiguous printing resolved with Alt+2 (keyboard)', async () => {
    await focusRow(desktop, 3);
    await desktop.keyboard.press('Alt+Digit2');
    await desktop.waitForFunction(() => {
      const row = document.querySelectorAll('.scan-queue .scan-row:not(.scan-row-head)')[3];
      return row && /Pikachu/.test(row.textContent) && !/Check match/.test(row.querySelector('.c-state').textContent);
    }, null, { timeout: 5000 });
  });

  await step('finish and quantity with PowerTools i and Pokoin +', async () => {
    await focusRow(desktop, 1);
    await desktop.keyboard.press('KeyI');
    await desktop.keyboard.press('Equal');
    await desktop.waitForFunction(() => {
      const row = document.querySelectorAll('.scan-queue .scan-row:not(.scan-row-head)')[1];
      return row.querySelectorAll('select')[2].value === 'reverse' && row.querySelector('.c-qty').textContent === '2';
    }, null, { timeout: 5000 });
  });

  await step('? opens the shortcut overlay and Esc closes it', async () => {
    await desktop.locator('.scan-queue').focus();
    await desktop.keyboard.press('Shift+Slash');
    await desktop.waitForSelector('.scan-help');
    await shot(desktop, '05-desktop-help');
    await desktop.keyboard.press('Escape');
    await desktop.waitForSelector('.scan-help', { state: 'detached' });
  });

  await step('prices filled; submit with Ctrl+Enter then Enter', async () => {
    const inputs = desktop.locator('.scan-queue .c-price input');
    const n = await inputs.count();
    for (let i = 0; i < n; i += 1) {
      await inputs.nth(i).click();
      await inputs.nth(i).fill('25');
      await desktop.keyboard.press('Enter');
    }
    await desktop.waitForFunction(() => !document.querySelector('.scan-submit')?.disabled, null, { timeout: 8000 });
    const label = await desktop.textContent('.scan-submit');
    assert.equal(label, 'Add 7 cards to Inventory');
    await desktop.locator('.scan-queue').focus();
    await desktop.keyboard.press('Control+Enter');
    await desktop.waitForSelector('.scan-modal-box');
    await shot(desktop, '06-desktop-confirm');
    await desktop.keyboard.press('Enter');
    await desktop.waitForSelector('.scan-done', { timeout: 10_000 });
    await shot(desktop, '07-desktop-done');
  });

  await step('inventory contains exactly the intended articles', async () => {
    const pool = new Pool({ connectionString: DB_URL });
    const listed = (await pool.query(
      `select card_id, language, condition, foil_state, reverse, quantity_available as qty, location, source
       from public.marketplace_user_listings where seller_uid = $1
       order by language desc, card_id, foil_state`,
      [SELLER],
    )).rows;
    await pool.end();
    assert.deepEqual(listed, [
      { card_id: '220962', language: 'IT', condition: 'NM', foil_state: 'standard', reverse: false, qty: 1, location: '', source: 'pokoin_scan_batch' },
      { card_id: '233564', language: 'IT', condition: 'NM', foil_state: 'reverse', reverse: true, qty: 2, location: '', source: 'pokoin_scan_batch' },
      { card_id: '240808', language: 'IT', condition: 'NM', foil_state: 'standard', reverse: false, qty: 1, location: '', source: 'pokoin_scan_batch' },
      { card_id: '233564', language: 'EN', condition: 'NM', foil_state: 'standard', reverse: false, qty: 1, location: 'Box A12', source: 'pokoin_scan_batch' },
      { card_id: '241092', language: 'EN', condition: 'NM', foil_state: 'standard', reverse: false, qty: 2, location: 'Box A12', source: 'pokoin_scan_batch' },
    ]);
  });

  await step('phone learns the session is over', async () => {
    await phone.waitForSelector('#scanConnectPanel:not([hidden])', { timeout: 10_000 });
    await shot(phone, '08-phone-ended');
  });

  await step('dashboard QR link opens the phone pre-filled with the code and connects without typing', async () => {
    await desktop.click('text=Scan another batch');
    await desktop.waitForSelector('.scan-qr[data-connect-url]', { timeout: 15_000 });
    const pinNow = await desktop.$$eval('.scan-pin span', (els) => els.map((e) => e.textContent).join(''));
    const link = await desktop.getAttribute('.scan-qr', 'data-connect-url');
    assert.match(link, /^https:\/\/scan\.pokoin\.com\/connect#c=[0-9]{4}&k=[A-Za-z0-9_-]{32}$/);
    assert.equal(new URLSearchParams(link.split('#')[1]).get('c'), pinNow);
    const qrPhone = await (await browser.newContext({ ...devices['iPhone 13'], permissions: ['camera'] })).newPage();
    // Same fragment, served from the local phone host.
    await qrPhone.goto(`http://127.0.0.1:${PHONE_PORT}/connect#${link.split('#')[1]}`);
    await qrPhone.waitForFunction((pin) => [...document.querySelectorAll('.sc-slot')].map((e) => e.textContent).join('') === pin, pinNow, { timeout: 5000 });
    await shot(qrPhone, '09-phone-qr-prefilled');
    await qrPhone.waitForSelector('.sc-bar:not([hidden])', { timeout: 10_000 });
    assert.equal(new URL(qrPhone.url()).hash, '', 'secret removed from the address bar');
    await desktop.waitForFunction(() => /iPhone connected|Scanning/.test(document.querySelector('.scan-status')?.textContent || ''), null, { timeout: 10_000 });
    await shot(desktop, '10-desktop-connected-by-qr');
    qrPhoneRef = qrPhone;
    qrLinkRef = link;
  });

  await step('phone keeps scanning while the API is unreachable and delivers once it recovers', async () => {
    const before = (await rows(desktop)).length;
    await qrPhoneRef.route('**/api/scan-phone?action=scan', (route) => route.abort('internetdisconnected'));
    await showCard([['233090', 0.95]]);
    await desktop.waitForTimeout(1500);
    assert.equal((await rows(desktop)).length, before, 'nothing delivered while offline');
    await qrPhoneRef.unroute('**/api/scan-phone?action=scan');
    const list = await waitRows(desktop, before + 1, 15_000);
    assert.equal(list.at(-1).card, 'Pikachu δ');
  });

  await step('reused, tampered and expired QR links are refused and fall back to the keypad', async () => {
    const hash = qrLinkRef.split('#')[1];
    const openLink = async (fragment) => {
      const page = await (await browser.newContext({ ...devices['iPhone 13'], permissions: ['camera'] })).newPage();
      await page.goto(`http://127.0.0.1:${PHONE_PORT}/connect#${fragment}`);
      await page.waitForFunction(() => /expired|not valid/i.test(document.querySelector('.sc-status')?.textContent || ''), null, { timeout: 8000 });
      assert.equal(await page.isVisible('.sc-keys'), true, 'keypad offered');
      assert.equal(await page.isHidden('.sc-bar'), true, 'not connected');
      return page;
    };
    await openLink(hash); // reused: already claimed above
    // Fresh pairing for tamper + expiry.
    await desktop.click('text=Disconnect');
    await desktop.waitForSelector('.scan-qr[data-connect-url]', { timeout: 10_000 });
    const fresh = (await desktop.getAttribute('.scan-qr', 'data-connect-url')).split('#')[1];
    const params = new URLSearchParams(fresh);
    const wrongPin = String((Number(params.get('c')) + 1) % 10000).padStart(4, '0');
    await openLink(`c=${wrongPin}&k=${params.get('k')}`);
    await openLink(`c=${params.get('c')}&k=${'A'.repeat(32)}`);
    const pool = new Pool({ connectionString: DB_URL });
    await pool.query("update public.scan_pairings set expires_at = now() - interval '1 second' where pin = $1", [params.get('c')]);
    await pool.end();
    await openLink(fresh);
    await shot(desktop, '11-desktop-after-rejections');
  });


  const perf = await desktop.evaluate(() => window.__pokoinScanPerf || []);
  fs.writeFileSync(path.join(process.env.E2E_OUT || '/tmp', 'scan-connect-e2e-perf.json'), JSON.stringify(perf, null, 1));
  await browser.close();
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(error);
  for (const [name, page] of debugPages) {
    try {
      console.error(`--- ${name} page text ---\n${(await page.evaluate(() => document.body.innerText)).slice(0, 1200)}`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `fail-${name}.png`) });
    } catch (_) {
      // page gone
    }
  }
  for (const child of children) {
    console.error(`--- ${child.name} log tail ---\n${child.log.slice(-30).join('')}`);
  }
} finally {
  for (const child of children) child.kill('SIGTERM');
  phoneServer.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} steps passed`);
  process.exit(exitCode);
}
