import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The dashboard markup guards live with the Solid pages (solid/src/pages/SellerHome.test.js,
// solid/src/pages/Inventory.test.js, solid/src/components/inventory/CollectionHoldings.test.js).
const root = path.dirname(fileURLToPath(import.meta.url));
const cssSrc = fs.readFileSync(path.join(root, 'seller-home.css'), 'utf8');
const vercel = fs.readFileSync(path.join(root, '../../vercel.json'), 'utf8');

test('vercel serves /dashboard on the market SPA and redirects the legacy host', () => {
  const config = JSON.parse(vercel);
  const dashRootRedirect = (config.redirects || []).find(
    (r) => r.source === '/' && (r.has || []).some((h) => h.value === 'dashboard.pokoin.com'),
  );
  assert.equal(dashRootRedirect?.destination, 'https://pokoin.com/dashboard');
  const dashScanRedirect = (config.redirects || []).find(
    (r) => r.source === '/scan' && (r.has || []).some((h) => h.value === 'dashboard.pokoin.com'),
  );
  assert.equal(dashScanRedirect?.destination, 'https://pokoin.com/dashboard/scan');
  const dashRewrite = (config.rewrites || []).find(
    (r) => r.source === '/dashboard' && r.destination === '/market/index.html',
  );
  assert.ok(dashRewrite, '/dashboard must rewrite to the market SPA');
  const dashScanRewrite = (config.rewrites || []).find(
    (r) => r.source === '/dashboard/scan' && r.destination === '/market/index.html',
  );
  assert.ok(dashScanRewrite, '/dashboard/scan must rewrite to the market SPA');
  const dashHostRewrite = (config.rewrites || []).find(
    (r) => (r.has || []).some((h) => h.value === 'dashboard.pokoin.com'),
  );
  assert.equal(dashHostRewrite, undefined);
  const apexRootRewrite = (config.rewrites || []).find(
    (r) => r.source === '/' && r.destination === '/landing.html' && !r.has,
  );
  assert.ok(apexRootRewrite, 'apex / must rewrite to landing.html (not filesystem index.html)');
  const build = fs.readFileSync(path.join(root, '../../scripts/build-web.sh'), 'utf8');
  assert.match(build, /landing\.html/);
  assert.doesNotMatch(build, /cp "\$ROOT\/index\.html" "\$OUT\/index\.html"/);
});

test('dashboard listings sheet and history chart CSS', () => {
  assert.match(cssSrc, /grid-template-columns:\s*repeat\(12, minmax\(0, 1fr\)\)/);
  assert.match(cssSrc, /\.seller-listing-tile \{/);
  assert.doesNotMatch(cssSrc, /\.seller-listing-row \{/);
  assert.match(cssSrc, /@media \(max-width: 900px\)/);
  assert.match(cssSrc, /repeat\(8, minmax\(0, 1fr\)\)/);
  assert.match(cssSrc, /repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(cssSrc, /\.seller-history-point \{[^}]*border-radius:\s*50%/);
  assert.match(cssSrc, /\.seller-history-y/);
  assert.match(cssSrc, /\.seller-history-tip/);
  assert.match(cssSrc, /\.seller-history-frame/);
  assert.match(cssSrc, /min-height:\s*11rem/);
  assert.doesNotMatch(cssSrc, /seller-history-ghost-line/);
});

test('CardTrader 1-DR assets sit beside Your listings and zoom like the scan desk', () => {
  assert.match(cssSrc, /\.seller-listing-art > \.thumb-zoom-host \{/);
  assert.match(cssSrc, /\.seller-secondary-grid\.has-1dr > \.seller-insights-panel \{\s*grid-column: 1 \/ -1;/);
});
