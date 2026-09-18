import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const appSrc = fs.readFileSync(path.join(root, 'App.jsx'), 'utf8');
const chromeSrc = fs.readFileSync(path.join(root, 'components/Chrome.jsx'), 'utf8');
const homeSrc = fs.readFileSync(path.join(root, 'pages/SellerHome.jsx'), 'utf8');
const collectionSrc = fs.readFileSync(path.join(root, 'pages/Collection.jsx'), 'utf8');
const nftSrc = fs.readFileSync(path.join(root, 'pages/Nft.jsx'), 'utf8');
const deskSrc = fs.readFileSync(path.join(root, 'pages/ScanDesk.jsx'), 'utf8');
const vercel = fs.readFileSync(path.join(root, '../../vercel.json'), 'utf8');

test('dashboard host / renders SellerHome; /scan stays ScanDesk', () => {
  assert.match(appSrc, /import SellerHome from '\.\/pages\/SellerHome\.jsx'/);
  assert.match(appSrc, /both\('\/',\s*dashboard \? <SellerHome \/>/);
  assert.match(appSrc, /both\('\/scan',\s*dashboard \? <ScanDesk \/>/);
  assert.match(appSrc, /Navigate to=\{dashboard \? '\/' : '\/marketplace'\}/);
});

test('vercel serves SellerHome SPA at dashboard.pokoin.com / (landing is landing.html)', () => {
  const config = JSON.parse(vercel);
  const dashRootRedirect = (config.redirects || []).find(
    (r) => r.source === '/' && (r.has || []).some((h) => h.value === 'dashboard.pokoin.com'),
  );
  assert.equal(dashRootRedirect, undefined);
  const dashRootRewrite = (config.rewrites || []).find(
    (r) => r.source === '/'
      && r.destination === '/market/index.html'
      && (r.has || []).some((h) => h.value === 'dashboard.pokoin.com'),
  );
  assert.ok(dashRootRewrite, 'dashboard / must rewrite to market SPA');
  const apexRootRewrite = (config.rewrites || []).find(
    (r) => r.source === '/' && r.destination === '/landing.html' && !r.has,
  );
  assert.ok(apexRootRewrite, 'apex / must rewrite to landing.html (not filesystem index.html)');
  const build = fs.readFileSync(path.join(root, '../../scripts/build-web.sh'), 'utf8');
  assert.match(build, /landing\.html/);
  assert.doesNotMatch(build, /cp "\$ROOT\/index\.html" "\$OUT\/index\.html"/);
});

test('Chrome Dashboard nav resolves to / on dashboard host; Collection replaces NFT label', () => {
  assert.match(chromeSrc, /onDashboard \? '\/' : DASHBOARD_HOME/);
  assert.doesNotMatch(chromeSrc, /onDashboard \? '\/scan'/);
  assert.match(chromeSrc, /to="\/collection"/);
  assert.match(chromeSrc, />Collection</);
});

test('SellerHome Portfolio uses Firestore collection and View collection CTA', () => {
  assert.match(homeSrc, /user_card_collections/);
  assert.match(homeSrc, /sumOwnedQuantity/);
  assert.match(homeSrc, /marketUrl\(APP\.collection\)/);
  assert.match(homeSrc, /Cards owned|Card owned/);
  assert.match(homeSrc, /Listed for sale/);
  assert.match(homeSrc, /Sum of quantity on live asks/);
  assert.match(homeSrc, /listed\?\.cards/);
  assert.match(homeSrc, /View collection/);
  assert.match(homeSrc, /to="\/scan"/);
  assert.match(homeSrc, /add them to your collection or list them for sale/);
  assert.doesNotMatch(homeSrc, /Total listed/);
  assert.doesNotMatch(homeSrc, /Your live listings/);
  assert.doesNotMatch(homeSrc, /marketplace\/portfolio/);
  assert.doesNotMatch(homeSrc, /fetchPortfolio/);
});

test('/collection is holdings; /nft redirects to /collection', () => {
  assert.match(appSrc, /both\('\/collection',\s*<Collection/);
  assert.match(appSrc, /both\('\/nft',\s*<NftRedirect/);
  assert.match(nftSrc, /Navigate to="\/collection"/);
  assert.match(collectionSrc, /partitionHoldings|isNftHolding/);
  assert.match(collectionSrc, /data-testid="collection-physical"|Physical/);
  assert.match(collectionSrc, /Request physical shipping \(NFT\)|canShip/);
});

test('ScanDesk has list|collection intent without resetting batch', () => {
  assert.match(deskSrc, /submitIntent/);
  assert.match(deskSrc, /scan-intent-list/);
  assert.match(deskSrc, /scan-intent-collection/);
  assert.match(deskSrc, /scanApi\.submit\(t, batch\.id, submitKey\.current, submitIntent\)/);
  assert.match(deskSrc, /What do you want to do\?/);
});

test('SellerHome gates unsigned users like other seller desks', () => {
  assert.match(homeSrc, /Navigate to=\{`\/auth\?from=/);
  assert.match(homeSrc, /SessionWait/);
});
