import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const appSrc = fs.readFileSync(path.join(root, 'App.jsx'), 'utf8');
const chromeSrc = fs.readFileSync(path.join(root, 'components/Chrome.jsx'), 'utf8');
const homeSrc = fs.readFileSync(path.join(root, 'pages/SellerHome.jsx'), 'utf8');
const viewSrc = fs.readFileSync(path.join(root, 'components/SellerDashboardView.jsx'), 'utf8');
const cssSrc = fs.readFileSync(path.join(root, 'seller-home.css'), 'utf8');
const collectionSrc = fs.readFileSync(path.join(root, 'pages/Collection.jsx'), 'utf8');
const nftSrc = fs.readFileSync(path.join(root, 'pages/Nft.jsx'), 'utf8');
const deskSrc = fs.readFileSync(path.join(root, 'pages/ScanDesk.jsx'), 'utf8');
const vercel = fs.readFileSync(path.join(root, '../../vercel.json'), 'utf8');

const CARD_ICON = 'M6 3h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm8 0h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM6 14h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zm8 0h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z';

test('pokoin.com/dashboard renders SellerHome; /scan stays the public photo page', () => {
  assert.match(appSrc, /import SellerHome from '\.\/pages\/SellerHome\.jsx'/);
  assert.match(appSrc, /both\('\/dashboard',\s*<SellerHome \/>/);
  assert.match(appSrc, /both\('\/dashboard\/scan',\s*<ScanDesk \/>/);
  assert.match(appSrc, /both\('\/scan',\s*<Scan \/>/);
  assert.match(appSrc, /both\('\/',\s*<Navigate to="\/marketplace" replace \/>/);
  assert.doesNotMatch(appSrc, /dashboard \? <SellerHome/);
  assert.doesNotMatch(appSrc, /dashboard \? <ScanDesk/);
});

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

test('Chrome Dashboard nav is a same-origin /dashboard link', () => {
  assert.match(chromeSrc, /to=\{DASHBOARD_HOME\}/);
  assert.doesNotMatch(chromeSrc, /onDashboard \? '\/'/);
  assert.doesNotMatch(chromeSrc, /dashboard\.pokoin\.com/);
  assert.match(chromeSrc, /to="\/collection"/);
  assert.match(chromeSrc, />Collection</);
});

test('Dashboard nav icon is four portrait card rectangles, not equal squares', () => {
  assert.match(chromeSrc, /DASHBOARD_CARDS_ICON/);
  assert.match(chromeSrc, new RegExp(`dashboard:\\s*DASHBOARD_CARDS_ICON`));
  assert.match(chromeSrc, new RegExp(CARD_ICON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // Topbar reuses ICO.dashboard — no second hardcoded fat-square path.
  assert.match(chromeSrc, /d=\{ICO\.dashboard\}/);
  assert.doesNotMatch(chromeSrc, /dashboard: 'M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z'/);
  assert.equal(
    (chromeSrc.match(/M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z/g) || []).length,
    0,
  );
  assert.doesNotMatch(chromeSrc, /M3\.5 2h6\.5c\.8 0 1\.5\.7/);
});

test('SellerHome Portfolio uses authenticated collection summary API', () => {
  assert.match(homeSrc, /fetchCollectionSummary/);
  assert.match(homeSrc, /readPortfolioTilesCache/);
  assert.match(homeSrc, /writePortfolioTilesCache/);
  assert.match(homeSrc, /portfolioTilesFromSummary/);
  assert.doesNotMatch(homeSrc, /onSnapshot/);
  assert.doesNotMatch(homeSrc, /user_card_collections/);
  assert.doesNotMatch(homeSrc, /Missing or insufficient permissions/);
  assert.match(homeSrc, /Couldn't load your collection/);
  assert.match(homeSrc, /marketUrl\(APP\.collection\)/);
  assert.match(viewSrc, /Cards owned|Card owned/);
  assert.match(viewSrc, /Listed for sale/);
  assert.match(viewSrc, /Currency availability/);
  assert.match(viewSrc, /formatPknNumber\(balance\)/);
  assert.match(viewSrc, /Digital \/ NFT/);
  assert.doesNotMatch(viewSrc, /<span>Physical<\/span>/);
  assert.match(homeSrc, /availablePkn \} = useAuth\(\)/);
  assert.match(homeSrc, /pknBalance=\{availablePkn\}/);
  assert.match(viewSrc, /Total asking value/);
  assert.doesNotMatch(viewSrc, /Portfolio value/);
  assert.match(viewSrc, /View collection/);
  assert.match(viewSrc, /to=\{DASHBOARD_SCAN\}/);
  assert.doesNotMatch(viewSrc, /to="\/scan"/);
  assert.match(viewSrc, /Add Cards/);
  assert.match(viewSrc, /Scan cards to add them to your collection or list them for sale/);
  assert.match(viewSrc, /Collection value history/);
  assert.match(viewSrc, /Collection history will appear here/);
  assert.match(viewSrc, /Scan cards to start building your portfolio/);
  assert.match(viewSrc, /data-history=\{hasLine \? 'series' : \(hasPoint \? 'point' : 'empty'\)\}/);
  assert.doesNotMatch(viewSrc, /seller-history-ghost-line/);
  assert.doesNotMatch(viewSrc, /currency-availability-graph/);
  assert.doesNotMatch(viewSrc, /Site balance available to spend/);
  assert.doesNotMatch(viewSrc, /fake.?line/i);
  // Empty collection still keeps the chart hero — not a collapsed EmptyDesk.
  assert.doesNotMatch(viewSrc, /portfolio-empty-scan/);
  assert.match(viewSrc, /portfolio-view-collection/);
  assert.match(viewSrc, /CollectionHistoryPanel/);
  assert.match(viewSrc, /todayHistoryDay/);
  assert.match(viewSrc, /cardsValuePkn/);
  assert.match(homeSrc, /writePortfolioHistory/);
  assert.match(viewSrc, /collection-history-tip/);
  assert.doesNotMatch(viewSrc, /No cards in your collection yet/);
  assert.match(viewSrc, /Trending on Pokoin/);
  assert.match(viewSrc, /marketUrl\(cardHref\(card\)\)/);
  assert.match(viewSrc, /Your listings/);
  assert.match(viewSrc, /ListingPreviewTile/);
  assert.doesNotMatch(viewSrc, /ListingPreviewRow/);
  assert.doesNotMatch(viewSrc, /seller-listing-copy/);
  assert.doesNotMatch(viewSrc, /seller-listing-price/);
  assert.match(cssSrc, /grid-template-columns:\s*repeat\(12, minmax\(0, 1fr\)\)/);
  assert.match(cssSrc, /\.seller-listing-tile \{/);
  assert.doesNotMatch(cssSrc, /\.seller-listing-row \{/);
  assert.match(homeSrc, /const LISTING_PREVIEW = 72/);
  assert.match(cssSrc, /@media \(max-width: 900px\)/);
  assert.match(cssSrc, /repeat\(8, minmax\(0, 1fr\)\)/);
  assert.match(cssSrc, /repeat\(6, minmax\(0, 1fr\)\)/);
  // Art-only Your listings tiles: no set/condition/qty/price chrome on the preview.
  const tileFn = viewSrc.match(/function ListingPreviewTile[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(tileFn.includes('name={name}') || /name=\{name\}/.test(tileFn));
  assert.doesNotMatch(tileFn, /setName|set_name|\.condition|quantityAvailable|formatPkn|badge=/);
  assert.match(viewSrc, /Collection insights/);
  assert.doesNotMatch(viewSrc, /kicker="Seller"/);
  assert.doesNotMatch(viewSrc, /List Cards/);
  assert.doesNotMatch(homeSrc, /marketplace\/portfolio/);
  assert.doesNotMatch(homeSrc, /fetchPortfolio/);
});

test('Dashboard history panel keeps chart frame; never draws a real fake series', () => {
  // Multi-day polyline only; a single live day is a point — no flat underline.
  assert.match(viewSrc, /hasLine \? \([\s\S]*<polyline/);
  assert.match(viewSrc, /seller-history-point/);
  assert.match(viewSrc, /CHART_W \/ 2/);
  assert.doesNotMatch(viewSrc, /CHART_W \* 0\.85/);
  assert.doesNotMatch(viewSrc, /<circle[\s\S]*seller-history-point/);
  assert.match(cssSrc, /\.seller-history-point \{[^}]*border-radius:\s*50%/);
  assert.match(viewSrc, /seller-history-y/);
  assert.match(viewSrc, /seller-history-x/);
  assert.match(viewSrc, /collection-history-tip/);
  assert.match(cssSrc, /\.seller-history-y/);
  assert.match(cssSrc, /\.seller-history-tip/);
  assert.match(cssSrc, /\.seller-history-frame/);
  assert.match(cssSrc, /min-height:\s*11rem/);
  assert.doesNotMatch(viewSrc, /seller-history-ghost-line/);
  assert.doesNotMatch(cssSrc, /seller-history-ghost-line/);
  // Trending reads the fast best_sellers rail; the marketplace hydrate
  // (fetchHome) is seconds cold on api.pokoin.com and was discarded anyway.
  assert.match(homeSrc, /RAIL\.bestSellers/);
  assert.match(homeSrc, /bestSellerIds/);
  assert.doesNotMatch(homeSrc, /fetchHome\(/);
  assert.doesNotMatch(homeSrc, /\+\d+%/);
  assert.doesNotMatch(viewSrc, /series\(total/);
});

test('/collection is holdings; /nft redirects to /collection', () => {
  assert.match(appSrc, /both\('\/collection',\s*<Collection/);
  assert.match(appSrc, /both\('\/nft',\s*<NftRedirect/);
  assert.match(nftSrc, /Navigate to="\/collection"/);
  assert.match(collectionSrc, /partitionHoldings|isNftHolding/);
  assert.match(collectionSrc, /data-testid="collection-physical"|Physical/);
  assert.match(collectionSrc, /Request physical shipping \(NFT\)|canShip/);
  assert.match(collectionSrc, /fetchOwnedCollection/);
  assert.match(collectionSrc, /Couldn't load your collection/);
  assert.match(collectionSrc, /collection-retry/);
  assert.doesNotMatch(collectionSrc, /onSnapshot/);
  assert.doesNotMatch(collectionSrc, /user_card_collections/);
  assert.doesNotMatch(collectionSrc, /from 'firebase\/firestore'/);
  assert.doesNotMatch(collectionSrc, /Missing or insufficient permissions/);
});

test('ScanDesk has list|collection intent without resetting batch', () => {
  assert.match(deskSrc, /submitIntent/);
  assert.match(deskSrc, /scan-intent-list/);
  assert.match(deskSrc, /scan-intent-collection/);
  assert.match(deskSrc, /scanApi\.submit\(t, batch\.id, submitKey\.current, submitIntent,/);
  assert.match(deskSrc, /What do you want to do\?/);
});

test('SellerHome gates unsigned users like other seller desks', () => {
  assert.match(homeSrc, /Navigate to=\{`\/auth\?from=/);
  assert.match(homeSrc, /SessionWait/);
});

test('dashPreview layout fixtures stay off production hostnames', () => {
  assert.match(homeSrc, /dashPreview/);
  assert.match(homeSrc, /import\.meta\.env\.DEV/);
  assert.match(viewSrc, /Layout preview/);
  assert.match(homeSrc, /localhost/);
});

test('CardTrader 1-Day Ready stock shows as dashboard assets, never as listings', () => {
  const panelSrc = fs.readFileSync(path.join(root, 'components/CardTraderAssetsPanel.jsx'), 'utf8');
  const targetsSrc = fs.readFileSync(path.join(root, 'components/InventoryTargets.jsx'), 'utf8');
  assert.match(homeSrc, /fetchCardTraderAssets\(token\)/);
  assert.match(homeSrc, /cardTraderAssets=\{cardTraderAssets\}/);
  assert.match(viewSrc, /<CardTraderAssetsPanel assets=\{cardTraderAssets\} \/>/);
  assert.match(viewSrc, /CardTrader 1-DR assets/);
  assert.match(panelSrc, /if \(!assets\?\.oneDayReady\) return null;/);
  assert.match(panelSrc, /not listed on Pokoin/);
  // Same miniature sheet as Your listings, beside it in the secondary grid.
  assert.match(panelSrc, /className="seller-listing-list"/);
  assert.match(panelSrc, /<MiniCardTile/);
  // Both sheets zoom the full card on hover, like the scan desk.
  const tileSrc = fs.readFileSync(path.join(root, 'components/MiniCardTile.jsx'), 'utf8');
  assert.match(tileSrc, /<ThumbZoom src=\{full\} full alt=\{name\}>/);
  assert.match(cssSrc, /\.seller-listing-art > \.thumb-zoom-host \{/);
  assert.match(viewSrc, /seller-secondary-grid\$\{oneDayReadyCards > 0 \? ' has-1dr' : ''\}/);
  assert.match(cssSrc, /\.seller-secondary-grid\.has-1dr > \.seller-insights-panel \{\s*grid-column: 1 \/ -1;/);
  // The desk never offers CardTrader as a target for a 1-Day Ready account.
  assert.match(targetsSrc, /const on = data\?\.status\?\.connected === true && !ready1d;/);
});
