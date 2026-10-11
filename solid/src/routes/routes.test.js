import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { applyRedirect, redirectLines } from '../../../scripts/write-cloudflare-web-routing.mjs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const tables = ['../router.js', './account.js', './browse.js', './commerce.js', './tools.js'].map(read).join('\n');
const vercel = JSON.parse(read('../../../vercel.json'));

/** Every production route of the Solid router (dev-only routes and the 404 catch-all excluded). */
function routes() {
  const out = [];
  for (const line of tables.split('\n')) {
    if (line.includes('import.meta.env.DEV')) continue;
    for (const match of line.matchAll(/\{ path: '([^']+)', component: (\w+)(?:, info: \{ to: '([^']+)' \})?/g)) {
      if (match[1] !== '*404') out.push({ path: match[1], component: match[2], to: match[3] || '' });
    }
  }
  return out;
}

const sample = (route) => route.replace(/:lang\b/, 'en').replace(/:\w+\??/g, 'x');
const BOARDS = /^\/(tests|sanitize|espurr|ocr|artwork|jumbos|poko)(\/|$)/;

test('the route table is what the old React App served', () => {
  const paths = routes().map((row) => row.path);
  assert.ok(paths.length >= 90, `${paths.length} routes`);
  for (const path of ['/', '/marketplace', '/marketplace/:lang/cards/:cardId/:slug?', '/wallet']) {
    assert.ok(paths.includes(path), path);
  }
});

test('every Solid route is the SPA shell on Cloudflare (else the edge 404s before Solid loads)', () => {
  const lines = redirectLines();
  const wrong = [];
  for (const { path } of routes()) {
    if (path === '/') continue; // the landing page
    const url = sample(path);
    const rule = applyRedirect(url, lines);
    const board = BOARDS.test(url);
    const ok = board
      ? rule?.code === 301 && rule.location.startsWith('https://test.pokoin.com/')
      : rule?.code === 200 && rule.location === '/market/app';
    if (!ok) wrong.push(`${url} → ${rule ? `${rule.code} ${rule.location}` : 'no rule (404)'}`);
  }
  assert.deepEqual(wrong, []);
});

/** Vercel source pattern -> RegExp (host-conditioned rewrites never apply everywhere). */
function sourcePattern(source) {
  const body = (source.replace(/\/$/, '') || '/')
    .replace(/:[A-Za-z_]+\(([^)]*)\)/g, '($1)')
    .replace(/:[A-Za-z_]+\*/g, '.*')
    .replace(/:[A-Za-z_]+/g, '[^/]+');
  return new RegExp(`^${body}/?$`);
}

test('every Solid route has a vercel rewrite (test.pokoin.com 404s before the SPA loads otherwise)', () => {
  const patterns = (vercel.rewrites || [])
    .filter((rewrite) => !rewrite.has)
    .map((rewrite) => sourcePattern(rewrite.source));
  const missing = routes()
    .map(({ path }) => sample(path))
    .filter((url) => !patterns.some((pattern) => pattern.test(url)));
  assert.deepEqual(missing, []);
});

test('seller stock routes reached from StockNav are rewritten on Vercel', () => {
  const sources = new Set((vercel.rewrites || []).map((rewrite) => rewrite.source));
  for (const route of ['/inventory/sync-review', '/bought', '/stock', '/product']) {
    assert.ok(sources.has(route), `${route} rewrite`);
    assert.ok(sources.has(`${route}/`), `${route}/ rewrite`);
  }
});

test('pages and redirects sit at the URLs links and bookmarks use', () => {
  const byPath = new Map(routes().map((row) => [row.path, row]));
  const pages = {
    '/artwork': 'ArtworkHover',
    '/careers': 'Careers',
    '/mypokoin/1dr': 'CardTraderOneDay',
    '/mypokoin/zero': 'CardTraderZero',
    '/mypokoin/spreadsheet': 'SellSpreadsheet',
    '/mypokoin/collection': 'Inventory',
    '/dashboard': 'SellerHome',
    '/dashboard/scan': 'ScanDesk',
    '/scan': 'Scan',
  };
  for (const [path, component] of Object.entries(pages)) {
    assert.equal(byPath.get(path)?.component, component, path);
  }
  const redirects = {
    '/': '/marketplace',
    '/collection': '/mypokoin/collection',
    '/nft': '/mypokoin/collection',
    '/inventory': '/mypokoin',
    '/product': '/product/box',
    '/swap': '/exchange',
    '/ambassador': '/ambassadorprogram',
  };
  for (const [path, to] of Object.entries(redirects)) {
    assert.deepEqual([byPath.get(path)?.component, byPath.get(path)?.to], ['RedirectTo', to], path);
  }
  assert.doesNotMatch(tables, /pages\/Collection\.jsx/);
});
