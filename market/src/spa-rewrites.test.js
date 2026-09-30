import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const appSrc = fs.readFileSync(path.join(root, 'App.jsx'), 'utf8');
const vercel = JSON.parse(fs.readFileSync(path.join(root, '../../vercel.json'), 'utf8'));

/** Every production SPA route in App.jsx (dev-only routes excluded). */
function appRoutes() {
  const routes = new Set();
  for (const line of appSrc.split('\n')) {
    if (line.includes('import.meta.env.DEV')) continue;
    for (const match of line.matchAll(/both\('([^']+)'|path="([^"]+)"/g)) {
      const route = match[1] || match[2];
      if (route.startsWith('/') && !route.includes('*')) routes.add(route);
    }
  }
  return [...routes];
}

/** Vercel source pattern -> RegExp (host-conditioned rewrites never apply everywhere). */
function sourcePattern(source) {
  const body = (source.replace(/\/$/, '') || '/')
    .replace(/:[A-Za-z_]+\(([^)]*)\)/g, '($1)')
    .replace(/:[A-Za-z_]+\*/g, '.*')
    .replace(/:[A-Za-z_]+/g, '[^/]+');
  return new RegExp(`^${body}/?$`);
}

test('every production App.jsx route has a vercel rewrite (else Vercel 404s before the SPA loads)', () => {
  const patterns = (vercel.rewrites || [])
    .filter((rewrite) => !rewrite.has)
    .map((rewrite) => sourcePattern(rewrite.source));
  const missing = appRoutes()
    .map((route) => route.replace(/:[A-Za-z_]+/g, 'x'))
    .filter((sample) => !patterns.some((pattern) => pattern.test(sample)));
  assert.deepEqual(missing, []);
});

test('seller stock routes reached from StockNav are rewritten', () => {
  const sources = new Set((vercel.rewrites || []).map((rewrite) => rewrite.source));
  for (const route of ['/inventory/sync-review', '/bought', '/stock', '/product']) {
    assert.ok(sources.has(route), `${route} rewrite`);
    assert.ok(sources.has(`${route}/`), `${route}/ rewrite`);
  }
});
