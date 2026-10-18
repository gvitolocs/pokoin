import { createMemo, createSignal, Errored, For, Repeat, Show } from 'solid-js';
import { cardHref, formatPkn, imageSrc } from '@market/api.js';
import { cardReference, writeListingDrag } from '@market/chat-listing.js';
import { printingIdentity } from '@market/identity.js';
import { formatPknNumber, tilePricePkn } from '@market/pkn.js';
import { inventoryListingHref } from '@market/inventory-listings.js';
import { formatDayLabel } from '@market/portfolio-history.js';
import { DASHBOARD_SCAN, goMarket, marketUrl } from '@market/punchouts.js';
import '@market/sell-spreadsheet.css';
import { Alert, EmptyDesk, PageHead } from '../Desk.jsx';
import MiniCardTile from '../MiniCardTile.jsx';
import CollectionHistoryPanel from './CollectionHistoryPanel.jsx';

/** React DashboardBoundary: a render error leaves a one-line notice, not a blank page. */
export function DashboardBoundary(props) {
  return (
    <Errored
      fallback={(err) => {
        console.error('dashboard render failed', err());
        return (
          <div class="page desk seller-home" data-testid="seller-home-error">
            <p class="seller-panel-empty">The dashboard hit a drawing error. Reload the page.</p>
          </div>
        );
      }}
    >
      {props.children}
    </Errored>
  );
}

function HistoryBoundary(props) {
  return (
    <Errored
      fallback={(err) => {
        console.error('collection history render failed', err());
        return <p class="seller-panel-empty">Collection history is unavailable.</p>;
      }}
    >
      {props.children}
    </Errored>
  );
}

export function AddCardsArt() {
  return (
    <div class="seller-scan-art" aria-hidden="true">
      <svg viewBox="0 0 220 160" width="220" height="160">
        <defs>
          <linearGradient id="sellerCardBack" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#2a2433" />
            <stop offset="55%" stop-color="#1a1620" />
            <stop offset="100%" stop-color="#0e0c12" />
          </linearGradient>
          <linearGradient id="sellerPhoneGlass" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#2c2834" />
            <stop offset="100%" stop-color="#121016" />
          </linearGradient>
        </defs>
        {/* Card back — portrait trading-card silhouette */}
        <g transform="translate(118 18) rotate(12)">
          <rect x="0" y="0" width="72" height="100" rx="6" fill="url(#sellerCardBack)" stroke="#ffd33d" stroke-opacity="0.55" stroke-width="1.5" />
          <rect x="8" y="10" width="56" height="80" rx="3" fill="none" stroke="#ffd33d" stroke-opacity="0.28" stroke-width="1" />
          <circle cx="36" cy="50" r="14" fill="none" stroke="#ffd33d" stroke-opacity="0.4" stroke-width="1.25" />
          <circle cx="36" cy="50" r="5" fill="#ffd33d" fill-opacity="0.35" />
        </g>
        {/* Phone */}
        <g transform="translate(28 22)">
          <rect x="0" y="0" width="78" height="128" rx="12" fill="#0a090d" stroke="#5c5c5c" stroke-width="2" />
          <rect x="6" y="10" width="66" height="100" rx="4" fill="url(#sellerPhoneGlass)" />
          <rect x="18" y="28" width="42" height="58" rx="3" fill="none" stroke="#ffd33d" stroke-opacity="0.75" stroke-width="1.5" stroke-dasharray="3 2" />
          <circle cx="39" cy="118" r="4" fill="#38363f" />
          <rect x="30" y="4" width="18" height="3" rx="1.5" fill="#38363f" />
        </g>
        {/* Scan beam */}
        <path
          d="M98 78 C112 70, 118 62, 128 48"
          fill="none"
          stroke="#ffd33d"
          stroke-opacity="0.55"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-dasharray="4 3"
        />
      </svg>
    </div>
  );
}

/** Same-origin link, or a full pokoin.com punch-out from the dashboard host. */
function DeskLink(props) {
  const target = () => String(props.href || '');
  return (
    <a
      class={props.class}
      href={target() || '/marketplace'}
      data-testid={props['data-testid']}
      onClick={(event) => {
        if (!target().startsWith('http')) return;
        event.preventDefault();
        goMarket(target());
      }}
    >
      {props.children}
    </a>
  );
}

function MixBar(props) {
  const width = () => Math.max(0, Math.min(100, Number(props.pct) || 0));
  return (
    <div class={`seller-mix-row tone-${props.tone || 'gold'}`}>
      <div class="seller-mix-meta">
        <span>{props.label}</span>
        <strong>{Math.round(width())}%</strong>
      </div>
      <div class="seller-mix-track" aria-hidden="true">
        <span style={{ width: `${width()}%` }} />
      </div>
    </div>
  );
}

function MoverCard(props) {
  // Always punch out to pokoin.com from the dashboard host (same as listings).
  const card = () => props.card;
  const href = () => marketUrl(cardHref(card()));
  const art = () => imageSrc(card(), 'grid') || imageSrc(card(), 'hero');
  const identity = () => printingIdentity(card());
  const price = () => formatPkn(tilePricePkn(card()));
  return (
    <a
      class="seller-mover"
      href={href()}
      draggable="true"
      onDragStart={(event) => writeListingDrag(event, cardReference(card()))}
      onClick={(event) => {
        if (!href().startsWith('http')) return;
        event.preventDefault();
        goMarket(href());
      }}
    >
      <span class="seller-mover-art">
        <Show when={art()} fallback={<span class="tile-ph" />}><img src={art()} alt="" loading="lazy" /></Show>
      </span>
      <span class="seller-mover-copy">
        <strong>{card().name || 'Card'}</strong>
        <Show when={identity().tileLine}><em>{identity().tileLine}</em></Show>
        <Show when={price()}><span class="seller-mover-price">{price()}</span></Show>
      </span>
    </a>
  );
}

// Same 12-by-6 miniature sheet as CardTrader 1-DR.
const LISTING_PREVIEW = 72;

function ListingPreviewTile(props) {
  // Your listings sheet: art-only miniatures. Name stays on aria-label; no
  // set / condition / qty / price chrome on the tile itself.
  const row = () => props.row;
  const name = () => row().cardName || row().card_name || 'Card';
  return (
    <MiniCardTile
      imageUrl={row().cardImageUrl || row().card_image_url || ''}
      name={name()}
      title={name()}
      cardId={row().cardId || row().card_id || ''}
      listingId={row().id || row().listingId || ''}
      sellerUid={row().sellerUid || row().seller_uid || ''}
      seller={row().sellerUsername || row().seller_name || ''}
      pricePkn={row().pricePkn || row().price_pkn || 0}
      href={props.href || ''}
    />
  );
}

function SellSpreadsheetTile() {
  return (
    <a class="sell-sheet-tile" href="/mypokoin/spreadsheet" data-testid="sell-via-spreadsheet">
      <span class="sell-sheet-tile-icon">
        <svg viewBox="0 0 48 48" width="34" height="34" aria-hidden="true">
          <path fill="currentColor" d="M12 6h16l8 8v26a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm14 2v8h8" />
          <path fill="currentColor" d="M16 24h7v2h-7v-2zm0 5h16v2H16v-2zm0 5h16v2H16v-2z" />
          <path fill="currentColor" d="M29.2 22.4 33 26.2l3.8-3.8 1.4 1.4-3.8 3.8 3.8 3.8-1.4 1.4-3.8-3.8-3.8 3.8-1.4-1.4 3.8-3.8-3.8-3.8z" />
        </svg>
      </span>
      <strong>Sell via spreadsheet</strong>
      <span>Start selling by uploading an excel/csv file</span>
    </a>
  );
}

// Same 12-by-6 miniature sheet as Your listings.
const ASSET_PREVIEW = 72;

function assetTitle(item) {
  const flags = [item.reverse ? 'Reverse' : '', item.firstEdition ? '1st Ed.' : '', item.graded ? 'Graded' : ''].filter(Boolean);
  const details = [
    item.cardName || 'Card',
    item.setName,
    item.condition,
    item.language,
    ...flags,
    item.pricePkn > 0
      ? `last sold ${formatPkn(item.pricePkn)}${item.priceDay ? ` on ${formatDayLabel(item.priceDay)}` : ''}`
      : 'never sold',
  ].filter(Boolean).join(' · ');
  return item.quantity > 1 ? `${details} · Qty ${item.quantity}` : details;
}

/**
 * CardTrader 1-Day Ready inventory beside Your listings:
 * CardTrader stocks and
 * sells it, so it shows as assets, never as Pokoin listings.
 */
function CardTraderAssetsPanel(props) {
  const [showAll, setShowAll] = createSignal(false);
  const items = () => (Array.isArray(props.assets?.items) ? props.assets.items : []);
  const totals = () => props.assets?.totals || {};
  const shown = () => (showAll() ? items() : items().slice(0, ASSET_PREVIEW));
  return (
    <Show when={props.assets?.oneDayReady}>
      <section class="seller-panel ct1dr-panel" aria-labelledby="ct1dr-title" data-testid="cardtrader-1dr-assets">
        <header class="seller-panel-head">
          <h2 id="ct1dr-title">CardTrader 1-DR</h2>
          <Show when={items().length}>
            <span class="ct1dr-totals" title="Stocked and sold by CardTrader 1-Day Ready — not listed on Pokoin">
              {Number(totals().cards || 0).toLocaleString('en-US')} cards · {formatPkn(totals().valuePkn || 0) || '0 PKN'}
            </span>
          </Show>
        </header>
        <Show when={items().length} fallback={<p class="seller-panel-empty">No 1-Day Ready cards yet. Press Sync now under CardTrader in Profile.</p>}>
          <div class="seller-listing-list" data-testid="cardtrader-1dr-grid">
            <For each={shown()}>
              {(item) => (
                <MiniCardTile
                  imageUrl={item.imageUrl}
                  name={item.cardName || 'Card'}
                  title={assetTitle(item)}
                  cardId={item.cardId || ''}
                  pricePkn={item.pricePkn}
                  href={item.cardId ? marketUrl(inventoryListingHref(item)) : ''}
                  badge={item.quantity > 1 ? `×${item.quantity}` : ''}
                />
              )}
            </For>
          </div>
        </Show>
        <p class="ct1dr-lede">Stocked and sold by CardTrader 1-Day Ready — not listed on Pokoin.</p>
        <Show when={items().length > ASSET_PREVIEW}>
          <button type="button" class="seller-panel-link ct1dr-more" onClick={() => setShowAll((all) => !all)}>
            {showAll() ? 'Show fewer' : `Show all ${items().length}`}
          </button>
        </Show>
      </section>
    </Show>
  );
}

/**
 * Presentational seller dashboard.
 * Data is passed in so the fixture preview renders without Firebase.
 */
export function SellerDashboardView(props) {
  const [showAllListings, setShowAllListings] = createSignal(false);
  const listed = () => props.listed;
  const listingRows = () => props.listingRows || [];
  const movers = () => props.movers || [];
  const assets = () => props.cardTraderAssets || null;
  const oneDayReadyCards = () => (assets()?.oneDayReady ? Math.max(0, Number(assets().totals?.cards) || 0) : 0);
  const empty = () => !props.loading && !props.error
    && props.ownedCards === 0
    && !(listed()?.cards > 0)
    && oneDayReadyCards() === 0;

  const physicalQty = () => Math.max(0, Number(props.physicalOwned) || 0);
  const nftQty = () => Math.max(0, Number(props.nftOwned) || 0);
  const owned = () => Math.max(0, Number(props.ownedCards) || 0) + oneDayReadyCards();
  const balance = () => Math.max(0, Number(props.pknBalance) || 0);
  const listedCards = () => Math.max(0, Number(listed()?.cards) || 0);
  const mixBase = () => physicalQty() + nftQty();
  const physicalPct = () => (mixBase() > 0 ? (physicalQty() / mixBase()) * 100 : 0);
  const nftPct = () => (mixBase() > 0 ? (nftQty() / mixBase()) * 100 : 0);
  const listedPct = () => (owned() > 0 ? Math.min(100, (listedCards() / owned()) * 100) : 0);
  const unique = () => Math.max(0, Number(props.uniqueItems) || 0);
  const oneDayReadyTotals = () => (assets()?.oneDayReady ? assets().totals || null : null);
  const oneDayReadyValue = () => Math.max(0, Number(oneDayReadyTotals()?.valuePkn) || 0);
  const oneDayReadyPriced = () => Math.max(0, Number(oneDayReadyTotals()?.pricedCards) || 0);
  const shownListings = () => (showAllListings() ? listingRows() : listingRows().slice(0, LISTING_PREVIEW));
  // Today's chart point is the wallet and 1-DR value shown on this tile.
  const historyLive = createMemo(() => ({ currencyPkn: balance(), cards: oneDayReadyTotals() || undefined }));

  return (
    <div class="page desk seller-home" data-testid="seller-home">
      <Show when={props.previewBanner}>
        <p class="seller-preview-banner" role="status">Layout preview — fixture data, not your live collection.</p>
      </Show>
      <PageHead title="Dashboard">
        <Show when={props.inventoryHref}>
          <DeskLink class="btn" href={props.inventoryHref} data-testid="dashboard-mypokoin">MyPokoin</DeskLink>
        </Show>
      </PageHead>

      <div class="seller-home-grid">
        <section class="seller-tile seller-tile-portfolio" aria-labelledby="seller-portfolio-title">
          <header class="seller-tile-head">
            <h2 id="seller-portfolio-title">Portfolio</h2>
            <p class="seller-tile-sub">Your collection</p>
          </header>

          <Show when={props.loading}>
            <div class="seller-tile-body" aria-busy="true" aria-label="Loading collection">
              <div class="seller-metrics">
                <Repeat count={4}>
                  {() => (
                    <div class="seller-metric">
                      <div class="skeleton-line" />
                      <div class="skeleton-line short" />
                    </div>
                  )}
                </Repeat>
              </div>
              <div class="skeleton-line seller-history-skel" />
            </div>
          </Show>

          <Show when={props.error}>
            <div class="seller-tile-body">
              <Alert>{props.error}</Alert>
              <div class="seller-tile-actions">
                <button type="button" class="btn ghost" onClick={() => props.onRetry?.()} data-testid="portfolio-retry">Retry</button>
                <DeskLink class="btn ghost" href={props.collectionHref} data-testid="portfolio-view-collection">View collection</DeskLink>
              </div>
            </div>
          </Show>

          <Show when={!props.loading && !props.error}>
            <div class={['seller-tile-body', { 'is-empty': empty() }]}>
              <div class="seller-metrics" data-testid="portfolio-metrics">
                <div class="seller-metric">
                  <strong>{owned().toLocaleString('en-US')}</strong>
                  <span>{owned() === 1 ? 'Card owned' : 'Cards owned'}</span>
                </div>
                <div class="seller-metric">
                  <strong>{listed()?.failed ? '—' : listedCards().toLocaleString('en-US')}</strong>
                  <span>Listed for sale</span>
                </div>
                <div class="seller-metric" data-testid="currency-availability">
                  <strong>{formatPknNumber(balance())} PKN</strong>
                  <span>Currency availability</span>
                </div>
                <div class="seller-metric">
                  <strong>{nftQty().toLocaleString('en-US')}</strong>
                  <span>Digital / NFT</span>
                </div>
              </div>

              <Show when={listed() && !listed().failed && listed().listedPkn > 0}>
                <p class="seller-asking" data-testid="total-asking-value">
                  <span>Total asking value</span>
                  <strong>{formatPkn(listed().listedPkn)}</strong>
                </p>
              </Show>

              <Show when={oneDayReadyCards() > 0}>
                <p class="seller-asking" data-testid="cardtrader-1dr-value">
                  <span>
                    CardTrader 1-DR assets · {oneDayReadyCards().toLocaleString('en-US')} cards
                    {' · '}
                    {oneDayReadyPriced().toLocaleString('en-US')} with a sale
                  </span>
                  <strong title="Each card at the last sold median of its condition and language. A card that never sold counts 0 PKN.">
                    {oneDayReadyValue() > 0 ? formatPkn(oneDayReadyValue()) : '0 PKN'}
                  </strong>
                </p>
              </Show>

              <HistoryBoundary>
                <CollectionHistoryPanel series={props.historySeries || []} pending={Boolean(props.historyPending)} live={historyLive()} />
              </HistoryBoundary>

              <div class="seller-tile-actions">
                <DeskLink class="btn ghost" href={props.collectionHref} data-testid="portfolio-view-collection">View collection</DeskLink>
              </div>
            </div>
          </Show>
        </section>

        <section class="seller-tile seller-tile-list" aria-labelledby="seller-list-title">
          <header class="seller-tile-head">
            <h2 id="seller-list-title">Add Cards</h2>
            <p class="seller-tile-sub">Scan cards to add them to your collection or list them for sale.</p>
          </header>
          <div class="seller-tile-body seller-tile-cta">
            <AddCardsArt />
            <a class="btn" href={DASHBOARD_SCAN} data-testid="list-cards-scan">Scan cards</a>
          </div>
        </section>
      </div>

      <section class="sell-sheet-hub" aria-labelledby="sell-and-buy-title">
        <h2 id="sell-and-buy-title">Sell and Buy</h2>
        <div class="sell-sheet-hub-grid">
          <SellSpreadsheetTile />
        </div>
      </section>

      <section class="seller-panel seller-movers-panel" aria-labelledby="seller-movers-title">
        <header class="seller-panel-head">
          <h2 id="seller-movers-title">Trending on Pokoin</h2>
          <DeskLink class="seller-panel-link" href={props.marketplaceHref}>Marketplace →</DeskLink>
        </header>
        <Show
          when={movers().length}
          fallback={<p class="seller-panel-empty">{props.loading ? 'Loading marketplace…' : 'Marketplace trending rail is unavailable right now.'}</p>}
        >
          <div class="seller-movers-rail" data-testid="marketplace-movers">
            <For each={movers()}>{(card) => <MoverCard card={card} />}</For>
          </div>
        </Show>
      </section>

      {/* CardTrader 1-DR sits next to Your listings as the same miniature sheet. */}
      <div class={['seller-secondary-grid', { 'has-1dr': oneDayReadyCards() > 0 }]}>
        <section class="seller-panel" aria-labelledby="seller-listings-title">
          <header class="seller-panel-head">
            <h2 id="seller-listings-title">Your listings</h2>
            <span class="seller-panel-links">
              <Show when={props.salesHref}><DeskLink class="seller-panel-link" href={props.salesHref}>Sold history →</DeskLink></Show>
              <DeskLink class="seller-panel-link" href={props.inventoryHref}>View MyPokoin →</DeskLink>
            </span>
          </header>
          <Show when={listed()?.failed}><p class="seller-panel-empty">Listings unavailable.</p></Show>
          <Show when={!listed()?.failed && listingRows().length}>
            <div class="seller-listing-list" data-testid="your-listings">
              <For each={shownListings()}>
                {(row) => <ListingPreviewTile row={row} href={props.listingHrefFor?.(row) || props.inventoryHref} />}
              </For>
            </div>
          </Show>
          <Show when={!listed()?.failed && listingRows().length > LISTING_PREVIEW}>
            <button type="button" class="seller-panel-link ct1dr-more" onClick={() => setShowAllListings((all) => !all)}>
              {showAllListings() ? 'Show fewer' : `Show all ${listingRows().length}`}
            </button>
          </Show>
          <Show when={!listed()?.failed && !listingRows().length && !props.loading}>
            <EmptyDesk nested title="No cards listed yet" lede="Scan a pile and list what you want to sell.">
              <a class="btn" href={DASHBOARD_SCAN}>Scan cards</a>
            </EmptyDesk>
          </Show>
        </section>

        <CardTraderAssetsPanel assets={assets()} />

        <section class="seller-panel seller-insights-panel" aria-labelledby="seller-insights-title">
          <header class="seller-panel-head">
            <h2 id="seller-insights-title">Collection insights</h2>
          </header>
          <Show
            when={!props.loading && !props.error && owned() > 0}
            fallback={<p class="seller-panel-empty">{props.loading ? 'Loading…' : 'Insights appear once you own cards.'}</p>}
          >
            <div class="seller-insights" data-testid="collection-insights">
              <p class="seller-insight-line">
                <strong>{unique().toLocaleString('en-US')}</strong>
                {' '}
                unique
                {unique() === 1 ? ' card' : ' cards'}
                {' · '}
                <strong>{owned().toLocaleString('en-US')}</strong>
                {' '}
                total quantity
              </p>
              <h3 class="seller-insight-h">Collection mix</h3>
              <MixBar label="Physical" pct={physicalPct()} tone="gold" />
              <MixBar label="Digital / NFT" pct={nftPct()} tone="blue" />
              <MixBar label="Listed of owned" pct={listedPct()} tone="green" />
            </div>
          </Show>
        </section>
      </div>
    </div>
  );
}
