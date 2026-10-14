import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const homeSrc = read('./SellerHome.jsx');
// The React SellerDashboardView is split in two Solid components.
const viewSrc = read('../components/dashboard/SellerDashboardView.jsx');
const historySrc = read('../components/dashboard/CollectionHistoryPanel.jsx');
const dashSrc = `${viewSrc}\n${historySrc}`;
const chromeSrc = read('../components/Chrome.jsx');

const CARD_ICON = 'M6 3h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm8 0h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM6 14h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zm8 0h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z';
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('Chrome Dashboard nav is a same-origin /dashboard link', () => {
  assert.match(chromeSrc, /to=\{DASHBOARD_HOME\}/);
  assert.doesNotMatch(chromeSrc, /onDashboard \? '\/'/);
  assert.doesNotMatch(chromeSrc, /dashboard\.pokoin\.com/);
  assert.match(chromeSrc, /to="\/mypokoin\/collection"/);
  assert.match(chromeSrc, />Collection</);
});

test('Dashboard nav icon is four portrait card rectangles, not equal squares', () => {
  assert.match(chromeSrc, new RegExp(`dashboard: '${escape(CARD_ICON)}'`));
  assert.match(chromeSrc, /d=\{ICO\.dashboard\}/);
  assert.doesNotMatch(chromeSrc, /M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z/);
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
  assert.match(dashSrc, /Cards owned|Card owned/);
  assert.match(dashSrc, /Math\.max\(0, Number\(props\.ownedCards\) \|\| 0\) \+ oneDayReadyCards\(\)/);
  assert.match(dashSrc, /last sold median of its condition and language/);
  assert.doesNotMatch(dashSrc, /Sold today/);
  assert.doesNotMatch(dashSrc, /Dump minimum/);
  assert.match(dashSrc, /collection-history-hatch/);
  assert.match(dashSrc, /Listed for sale/);
  assert.match(dashSrc, /Currency availability/);
  assert.match(dashSrc, /formatPknNumber\(balance\(\)\)/);
  assert.match(dashSrc, /Digital \/ NFT/);
  assert.doesNotMatch(dashSrc, /<span>Physical<\/span>/);
  assert.match(homeSrc, /availablePkn/);
  assert.match(homeSrc, /pknBalance=\{availablePkn\(\)\}/);
  assert.match(dashSrc, /Total asking value/);
  assert.doesNotMatch(dashSrc, /Portfolio value/);
  assert.match(dashSrc, /View collection/);
  assert.match(dashSrc, /href=\{DASHBOARD_SCAN\}/);
  assert.doesNotMatch(dashSrc, /to="\/scan"/);
  assert.match(dashSrc, /Add Cards/);
  assert.match(dashSrc, /Scan cards to add them to your collection or list them for sale/);
  assert.doesNotMatch(dashSrc, /<h3>Collection value history<\/h3>/);
  const historyImport = historySrc.match(/import \{[^}]+\} from '@market\/portfolio-history\.js'/)?.[0] || '';
  assert.match(historyImport, /\bwithLiveToday\b/);
  assert.match(historyImport, /\bhistoryDateTicks\b/);
  assert.match(historySrc, /createSignal\(DEFAULT_HISTORY_PRESET\)|createSignal\('1M'\)/);
  assert.match(historySrc, /type="date"/);
  assert.match(historySrc, /availableHistoryPresets/);
  assert.match(historySrc, /Collection history will appear here/);
  assert.match(historySrc, /Scan cards to start building your portfolio/);
  assert.match(historySrc, /data-history=\{chart\(\)\.hasLine \? 'series' : \(chart\(\)\.hasPoint \? 'point' : 'empty'\)\}/);
  assert.match(dashSrc, /live=\{historyLive\(\)\}/);
  assert.doesNotMatch(dashSrc, /seller-history-ghost-line/);
  assert.doesNotMatch(dashSrc, /currency-availability-graph/);
  assert.doesNotMatch(dashSrc, /Site balance available to spend/);
  assert.doesNotMatch(dashSrc, /fake.?line/i);
  // Empty collection still keeps the chart hero — not a collapsed EmptyDesk.
  assert.doesNotMatch(dashSrc, /portfolio-empty-scan/);
  assert.match(dashSrc, /portfolio-view-collection/);
  assert.match(dashSrc, /CollectionHistoryPanel/);
  assert.match(dashSrc, /HistoryBoundary/);
  assert.match(homeSrc + dashSrc, /DashboardBoundary/);
  assert.match(dashSrc, /historyPending/);
  assert.match(homeSrc, /fetchPortfolioHistory/);
  assert.doesNotMatch(homeSrc, /fetchCheapestPricePknMap/);
  assert.doesNotMatch(homeSrc, /writePortfolioHistory/);
  assert.match(dashSrc, /collection-history-tip/);
  assert.doesNotMatch(dashSrc, /No cards in your collection yet/);
  assert.match(dashSrc, /Trending on Pokoin/);
  assert.match(dashSrc, /marketUrl\(cardHref\(card\(\)\)\)/);
  assert.match(dashSrc, /Your listings/);
  assert.match(dashSrc, /const LISTING_PREVIEW = 72/);
  assert.match(dashSrc, /\.slice\(0, LISTING_PREVIEW\)/);
  assert.match(dashSrc, /Show all \$\{[\w.()]*length\}/);
  assert.match(dashSrc, /ListingPreviewTile/);
  assert.doesNotMatch(dashSrc, /ListingPreviewRow/);
  assert.doesNotMatch(dashSrc, /seller-listing-copy/);
  assert.doesNotMatch(dashSrc, /seller-listing-price/);
  assert.match(homeSrc, /const LISTINGS_PAGE = 1000/);
  assert.doesNotMatch(homeSrc, /LISTING_PREVIEW/);
  assert.doesNotMatch(homeSrc, /live\.slice\(0,/);
  // Art-only Your listings tiles: no set/condition/qty/price chrome on the preview.
  const tileFn = viewSrc.match(/function ListingPreviewTile[\s\S]*?\n\}/)?.[0] || '';
  assert.match(tileFn, /name=\{name\(\)\}|name=\{name\}/);
  assert.doesNotMatch(tileFn, /setName|set_name|\.condition|quantityAvailable|formatPkn|badge=/);
  assert.match(dashSrc, /Collection insights/);
  assert.doesNotMatch(dashSrc, /kicker="Seller"/);
  assert.doesNotMatch(dashSrc, /List Cards/);
  assert.doesNotMatch(homeSrc, /marketplace\/portfolio/);
  assert.doesNotMatch(homeSrc, /fetchPortfolio\(/);
});

test('Dashboard history panel keeps chart frame; never draws a real fake series', () => {
  // Multi-day polyline only; a single live day is a point — no flat underline.
  assert.match(historySrc, /<Show when=\{chart\(\)\.hasLine\}><polyline class="seller-history-line"/);
  assert.match(historySrc, /seller-history-liquidity/);
  assert.match(historySrc, /seller-history-legend/);
  assert.match(historySrc, /seller-history-point/);
  assert.match(historySrc, /historyTimeline/);
  assert.match(historySrc, /timelineRatio/);
  assert.match(historySrc, /projectPortfolio/);
  assert.match(historySrc, /seller-history-band/);
  assert.match(historySrc, /seller-history-forecast/);
  assert.doesNotMatch(historySrc, /CHART_W \* 0\.85/);
  assert.doesNotMatch(historySrc, /<circle[\s\S]*seller-history-point/);
  assert.match(historySrc, /seller-history-y/);
  assert.match(historySrc, /seller-history-x/);
  assert.match(historySrc, /collection-history-tip/);
  assert.doesNotMatch(dashSrc, /seller-history-ghost-line/);
  // Trending reads the fast best_sellers rail; the marketplace hydrate
  // (fetchHome) is seconds cold on api.pokoin.com and was discarded anyway.
  assert.match(homeSrc, /RAIL\.bestSellers/);
  assert.match(homeSrc, /moversFromRail\(bestSellers\)/);
  assert.doesNotMatch(homeSrc, /fetchHome\(/);
  assert.doesNotMatch(homeSrc, /\+\d+%/);
  assert.doesNotMatch(dashSrc, /series\(total/);
});

test('CardTrader 1-Day Ready stock shows as dashboard assets, never as listings', () => {
  const panelSrc = viewSrc;
  const targetsSrc = read('../components/desk/InventoryTargets.jsx');
  const tileSrc = read('../components/MiniCardTile.jsx');
  assert.match(homeSrc, /fetchCardTraderAssets\(token\)/);
  assert.match(homeSrc, /cardTraderAssets=\{cardTraderAssets\(\)\}/);
  assert.match(viewSrc, /<CardTraderAssetsPanel assets=\{assets\(\)\} \/>/);
  assert.match(viewSrc, /CardTrader 1-DR assets/);
  assert.match(panelSrc, /<Show when=\{props\.assets\?\.oneDayReady\}>/);
  assert.match(panelSrc, /not listed on Pokoin/);
  // Same miniature sheet as Your listings, beside it in the secondary grid.
  assert.match(panelSrc, /class="seller-listing-list"/);
  assert.match(panelSrc, /<MiniCardTile/);
  // Both sheets zoom the full card on hover, like the scan desk.
  assert.match(tileSrc, /<ThumbZoom src=\{full\(\)\} full alt=\{name\(\)\}>/);
  assert.match(viewSrc, /seller-secondary-grid/);
  assert.match(viewSrc, /'has-1dr': oneDayReadyCards\(\) > 0/);
  // The desk never offers CardTrader as a target for a 1-Day Ready account.
  assert.match(targetsSrc, /data\?\.status\?\.connected === true && !ready1d/);
});
