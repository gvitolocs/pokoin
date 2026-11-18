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

test('Chrome Dashboard nav is a same-origin /dashboard link', () => {
  assert.match(chromeSrc, /to=\{DASHBOARD_HOME\}/);
  assert.doesNotMatch(chromeSrc, /onDashboard \? '\/'/);
  assert.doesNotMatch(chromeSrc, /dashboard\.pokoin\.com/);
  assert.match(chromeSrc, /to="\/mypokoin\/collection"/);
  assert.match(chromeSrc, />Collection</);
});

test('Dashboard nav uses the CardGTS arrows', () => {
  assert.match(chromeSrc, /aria-label="Dashboard"><BuySellIcon size=\{20\} \/>/);
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
  // The whole book comes from the stored MyPokoin book (lib/owner-book.js).
  assert.match(homeSrc, /loadOwnerBook\(id, gameId,/);
  assert.match(dashSrc, /!props\.listingsLoading/);
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
  // Multi-day smooth path only; a single live day is a point — no flat underline.
  assert.match(historySrc, /<Show when=\{chart\(\)\.hasLine\}><path class="seller-history-line"/);
  // The draw-in reveal rides a clip rect that rests at the full plot width, so
  // nothing is hidden unless an animation is actually running.
  assert.match(historySrc, /prefers-reduced-motion/);
  assert.match(historySrc, /<clipPath id=\{REVEAL_CLIP\}>[\s\S]*?width=\{CHART_W\}/);
  assert.match(historySrc, /clip-path=\{`url\(#\$\{REVEAL_CLIP\}\)`\}/);
  assert.match(historySrc, /requestAnimationFrame\(step\)/);
  assert.match(historySrc, /cancelAnimationFrame\(revealFrame\)/);
  assert.match(historySrc, /onCleanup\(showWholeChart\)/);
  // The end dot joins late; the hover dot and the tip are never hidden.
  assert.match(historySrc, /ref=\{\(el\) => \{ endDotNode = el; \}\}/);
  assert.match(historySrc, /class="seller-history-point is-hover" style=/);
  // One dot under the cursor: the last-day dot yields while a hover is active.
  assert.match(historySrc, /display: hovered\(\)\.dot \? 'none' : ''/);
  assert.match(historySrc, /seller-history-liquidity/);
  assert.match(historySrc, /seller-history-legend/);
  assert.match(historySrc, /seller-history-point/);
  assert.match(historySrc, /historyTimeline/);
  assert.match(historySrc, /timelineRatio/);
  // The future projection is gone: the realized window is the whole plot.
  assert.doesNotMatch(historySrc, /projection|forecast/i);
  assert.match(historySrc, /seller-history-today/);
  assert.doesNotMatch(historySrc, /CHART_W \* 0\.85/);
  assert.doesNotMatch(historySrc, /<circle[\s\S]*seller-history-point/);
  // No value axis is painted any more: the curve owns the whole frame.
  assert.doesNotMatch(historySrc, /seller-history-y|chart\(\)\.axis/);
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
  assert.match(viewSrc, /<CardTraderAssetsPanel assets=\{assets\(\)\} currency=\{props\.moverCurrency\} \/>/);
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

test('Top movers tiles never underline on hover', () => {
  const css = read('../../../market/src/seller-home.css');
  // The Top movers tile is one link; the global a:hover underline must not
  // reach into it — the tile's own outline is the hover affordance.
  const linkRule = css.match(/\.mover-tile-link:hover[^\0]*?\}/)?.[0] || '';
  assert.match(linkRule, /:focus/);
  assert.match(linkRule, /:active/);
  assert.match(linkRule, /text-decoration: none/);
  // The Trending rail tile keeps its no-underline hover.
  assert.match(css, /\.seller-mover:hover \{[^}]*text-decoration: none/);
});

test('Top movers tiles have no native tooltip, one screen-reader sentence', () => {
  const panelSrc = read('../components/dashboard/TopMoversPanel.jsx');
  // The link carries the whole tile as an aria-label, not a title that
  // repeats the visible text as a native tooltip over the change line.
  const linkTag = panelSrc.match(/<a class="mover-tile-link"[^>]*>/)?.[0] || '';
  assert.match(linkTag, /aria-label=\{moverTitle\(mover\(\), props\.currency\)\}/);
  assert.doesNotMatch(linkTag, / title=/);
  // Nothing inside the tile carries a title either.
  assert.doesNotMatch(panelSrc, / title=/);
});

test('the movers spark tip lives inside the sparkline box', () => {
  const panelSrc = read('../components/dashboard/TopMoversPanel.jsx');
  const css = read('../../../market/src/seller-home.css');
  // Placement is the pure helper: anchored to the day, clamped to the box
  // edges, never over the copy above the sparkline.
  assert.match(panelSrc, /moverSparkTipPlacement\(sparkPoint\(\), spark\(\)\)/);
  const tipRule = css.match(/\.mover-spark-tip \{[^}]*\}/)?.[0] || '';
  assert.doesNotMatch(tipRule, /bottom:/);
  assert.doesNotMatch(tipRule, /top:/);
});

test('the plot is one curve over its steps: no fill, no band, no shadow', () => {
  const css = read('../../../market/src/seller-home.css');
  // Nothing is painted under the curve: no stacked areas, no gradient fill.
  assert.doesNotMatch(historySrc, /cardsArea|liquidityArea|smoothHistoryBandPath|seller-history-fill|linearGradient/);
  assert.doesNotMatch(css, /\.seller-history-(fill|rule)\s*\{/);
  const lineRule = css.match(/\.seller-history-grid \.seller-history-line \{[^}]*\}/)?.[0] || '';
  assert.match(lineRule, /stroke:\s*var\(--history-cards\)/);
  assert.match(lineRule, /stroke-width:\s*2\.5/);
  assert.doesNotMatch(lineRule, /filter|shadow/);
  // The true steps ride in the same revealed group, painted before the curve.
  const clipAt = historySrc.indexOf('clip-path={`url(#${REVEAL_CLIP})`}');
  const stepAt = historySrc.indexOf('class="seller-history-step"');
  const lineAt = historySrc.indexOf('class="seller-history-line"');
  assert.ok(clipAt > 0 && stepAt > clipAt && stepAt < lineAt,
    'the stepped stroke must be revealed with the curve and sit under it');
  const stepRule = css.match(/\.seller-history-grid \.seller-history-step \{[^}]*\}/)?.[0] || '';
  assert.match(stepRule, /stroke:\s*var\(--muted\)/);
  assert.match(stepRule, /stroke-width:\s*1;/);
  // One baseline hairline instead of a grid, and no value axis to label it.
  assert.match(historySrc, /<line class="seller-history-baseline"/);
  assert.doesNotMatch(historySrc, /seller-history-rule/);
});

test('hover is a hollow dot with one line floating over the day', () => {
  const css = read('../../../market/src/seller-home.css');
  // The label is placed by the pure anchor helper, not by a corner card.
  assert.match(historySrc, /historyLabelAnchor\(\{/);
  assert.match(historySrc, /class="seller-history-tip collection-history-tip"/);
  assert.doesNotMatch(historySrc, /seller-history-tip-(day|total|note)/);
  const tipRule = css.match(/\.seller-history-tip \{[^}]*\}/)?.[0] || '';
  assert.match(tipRule, /white-space: nowrap/);
  assert.match(tipRule, /transform: translate\(-50%, -100%\)/);
  assert.doesNotMatch(tipRule, /box-shadow|min-width/);
  const hoverRule = css.match(/\.seller-history-point\.is-hover \{[^}]*\}/)?.[0] || '';
  assert.match(hoverRule, /background:\s*var\(--surface\)/);
  assert.match(hoverRule, /border:\s*2px solid var\(--history-cards\)/);
});

test('liquidity is an option that is remembered, off until the seller asks', () => {
  const css = read('../../../market/src/seller-home.css');
  const toggle = historySrc.match(/<button[^>]*seller-history-liquidity-toggle[\s\S]*?<\/button>/)?.[0] || '';
  assert.match(toggle, />\s*Show liquidity\s*</);
  assert.match(toggle, /aria-pressed=\{String\(band\(\)\)\}/);
  assert.match(toggle, /onClick=\{toggleBand\}/);
  assert.match(historySrc, /pokoin\.dashboard\.showLiquidity/);
  assert.match(historySrc, /localStorage\.getItem\(SHOW_LIQUIDITY_KEY\) === '1'/);
  assert.match(historySrc, /localStorage\.setItem\(SHOW_LIQUIDITY_KEY, on \? '1' : '0'\)/);
  // A browser that refuses storage starts from off and simply forgets.
  assert.ok((historySrc.match(/try \{/g) || []).length >= 2);
  // Its own scale, in its own strip under the baseline, dashed.
  assert.match(historySrc, /liquidityBandRatio\(c\.day\.assets\.currencyPkn, peak\)/);
  assert.match(historySrc, /Liquidity, own scale \(peak /);
  const bandRule = css.match(/\.seller-history-grid \.seller-history-liquidity \{[^}]*\}/)?.[0] || '';
  assert.match(bandRule, /stroke:\s*var\(--history-liquidity\)/);
  assert.match(bandRule, /stroke-dasharray: 5 4/);
  assert.doesNotMatch(bandRule, /fill-opacity/);
});

test('reduced motion skips the draw, the count-up and the pulse', () => {
  const css = read('../../../market/src/seller-home.css');
  // drawIn bails before the first frame, so the numbers and the curve land
  // finished: the count-up and the head dot only ever move inside that rAF.
  const draw = historySrc.match(/function drawIn\(\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(draw, /if \(reducedMotion\(\) \|\| !revealRect\) return;/);
  assert.match(draw, /setCounted\(historyCountValue\(target, progress\)\)/);
  assert.match(draw, /smoothHistoryPointAt\(chart\(\)\.curve, CHART_W \* progress\)/);
  assert.match(draw, /HISTORY_DRAW_MS/);
  assert.match(historySrc, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  // A single point has no stroke to draw and no ring to breathe with.
  assert.match(historySrc, /if \(!hasLine \|\| key === playedRange\) return;/);
  const point = historySrc.match(/class="seller-history-point"[\s\S]*?<\/span>/)?.[0] || '';
  assert.match(point, /<Show when=\{chart\(\)\.hasLine\}>[\s\S]*?seller-history-pulse/);
  // The ring is CSS-only, so one media query stops it too.
  const pulseRule = css.match(/\.seller-history-pulse \{[^}]*\}/)?.[0] || '';
  assert.match(pulseRule, /animation: seller-history-breathe 1\.3s/);
  const reduce = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(reduce, /\.seller-history-pulse \{\s*animation: none;/);
});
