import { Link } from 'react-router-dom';
import { cardHref, formatPkn, imageSrc } from '../api.js';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import { printingIdentity } from '../identity.js';
import { formatPknNumber, tilePricePkn } from '../pkn.js';
import { marketUrl, goMarket } from '../punchouts.js';

/**
 * Collection value chart. Real `series` when available; otherwise a flat line
 * at the current site PKN balance (currency availability).
 */
export function CollectionHistoryPanel({ series = null, currencyPkn = null }) {
  const balance = Math.max(0, Number(currencyPkn) || 0);
  const fromSeries = Array.isArray(series)
    ? series.map(Number).filter((n) => Number.isFinite(n))
    : [];
  const points = fromSeries.length >= 2
    ? fromSeries
    : (balance > 0 ? [balance, balance] : []);
  const hasSeries = points.length >= 2;
  const balanceOnly = hasSeries && fromSeries.length < 2;
  let polyline = '';
  let area = '';
  if (hasSeries) {
    const w = 640;
    const h = 200;
    const min = Math.min(...points);
    const max = Math.max(...points);
    const flat = max === min;
    const span = max - min || 1;
    const coords = points.map((v, i) => {
      const x = (i / (points.length - 1)) * w;
      // Flat balance line sits mid-frame; real series scale to the data.
      const y = flat ? h * 0.45 : h - ((v - min) / span) * (h - 24) - 12;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    polyline = coords.join(' ');
    area = `0,${h} ${polyline} ${w},${h}`;
  }
  return (
    <div
      className="seller-history"
      data-testid="collection-history"
      data-history={hasSeries ? (balanceOnly ? 'balance' : 'series') : 'empty'}
    >
      <div className="seller-history-head">
        <h3>{balanceOnly ? 'Currency availability' : 'Collection value history'}</h3>
      </div>
      <div className="seller-history-frame">
        <svg
          className={`seller-history-grid${hasSeries ? '' : ' is-empty'}`}
          viewBox="0 0 640 200"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {[0.25, 0.5, 0.75].map((y) => (
            <line key={y} x1="0" x2="640" y1={200 * y} y2={200 * y} />
          ))}
          {[0.2, 0.4, 0.6, 0.8].map((x) => (
            <line key={x} y1="0" y2="200" x1={640 * x} x2={640 * x} />
          ))}
          {hasSeries ? (
            <>
              <polygon className="seller-history-fill" points={area} />
              <polyline className="seller-history-line" points={polyline} fill="none" />
            </>
          ) : (
            <>
              {/* Decorative silhouette only — not real metrics. */}
              <path
                className="seller-history-ghost-fill"
                d="M0 168 C72 152, 110 124, 168 118 C230 112, 268 148, 328 132 C392 114, 430 78, 488 88 C548 98, 590 126, 640 108 L640 200 L0 200 Z"
              />
              <path
                className="seller-history-ghost-line"
                d="M0 168 C72 152, 110 124, 168 118 C230 112, 268 148, 328 132 C392 114, 430 78, 488 88 C548 98, 590 126, 640 108"
                fill="none"
              />
            </>
          )}
        </svg>
        {balanceOnly ? (
          <div className="seller-history-empty" data-testid="currency-availability-graph">
            <p className="seller-history-title">{formatPknNumber(balance)} PKN</p>
            <p className="seller-history-lede">Site balance available to spend</p>
          </div>
        ) : null}
        {!hasSeries ? (
          <div className="seller-history-empty">
            <p className="seller-history-title">Collection history will appear here</p>
            <p className="seller-history-lede">
              Scan cards to start building your portfolio.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AddCardsArt() {
  return (
    <div className="seller-scan-art" aria-hidden="true">
      <svg viewBox="0 0 220 160" width="220" height="160">
        <defs>
          <linearGradient id="sellerCardBack" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#2a2433" />
            <stop offset="55%" stopColor="#1a1620" />
            <stop offset="100%" stopColor="#0e0c12" />
          </linearGradient>
          <linearGradient id="sellerPhoneGlass" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2c2834" />
            <stop offset="100%" stopColor="#121016" />
          </linearGradient>
        </defs>
        {/* Card back — portrait trading-card silhouette */}
        <g transform="translate(118 18) rotate(12)">
          <rect
            x="0"
            y="0"
            width="72"
            height="100"
            rx="6"
            fill="url(#sellerCardBack)"
            stroke="#ffd33d"
            strokeOpacity="0.55"
            strokeWidth="1.5"
          />
          <rect
            x="8"
            y="10"
            width="56"
            height="80"
            rx="3"
            fill="none"
            stroke="#ffd33d"
            strokeOpacity="0.28"
            strokeWidth="1"
          />
          <circle cx="36" cy="50" r="14" fill="none" stroke="#ffd33d" strokeOpacity="0.4" strokeWidth="1.25" />
          <circle cx="36" cy="50" r="5" fill="#ffd33d" fillOpacity="0.35" />
        </g>
        {/* Phone */}
        <g transform="translate(28 22)">
          <rect
            x="0"
            y="0"
            width="78"
            height="128"
            rx="12"
            fill="#0a090d"
            stroke="#5c5c5c"
            strokeWidth="2"
          />
          <rect x="6" y="10" width="66" height="100" rx="4" fill="url(#sellerPhoneGlass)" />
          <rect
            x="18"
            y="28"
            width="42"
            height="58"
            rx="3"
            fill="none"
            stroke="#ffd33d"
            strokeOpacity="0.75"
            strokeWidth="1.5"
            strokeDasharray="3 2"
          />
          <circle cx="39" cy="118" r="4" fill="#38363f" />
          <rect x="30" y="4" width="18" height="3" rx="1.5" fill="#38363f" />
        </g>
        {/* Scan beam */}
        <path
          d="M98 78 C112 70, 118 62, 128 48"
          fill="none"
          stroke="#ffd33d"
          strokeOpacity="0.55"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray="4 3"
        />
      </svg>
    </div>
  );
}

function MixBar({ label, pct, tone }) {
  const width = Math.max(0, Math.min(100, Number(pct) || 0));
  return (
    <div className={`seller-mix-row tone-${tone || 'gold'}`}>
      <div className="seller-mix-meta">
        <span>{label}</span>
        <strong>{Math.round(width)}%</strong>
      </div>
      <div className="seller-mix-track" aria-hidden="true">
        <span style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function MoverCard({ card }) {
  // Always punch out to pokoin.com from the dashboard host (same as listings).
  const href = marketUrl(cardHref(card));
  const art = imageSrc(card, 'grid') || imageSrc(card, 'hero');
  const identity = printingIdentity(card);
  const price = formatPkn(tilePricePkn(card));
  if (href.startsWith('http')) {
    return (
      <a
        className="seller-mover"
        href={href}
        onClick={(event) => {
          event.preventDefault();
          goMarket(href);
        }}
      >
        <span className="seller-mover-art">
          {art ? <img src={art} alt="" loading="lazy" /> : <span className="tile-ph" />}
        </span>
        <span className="seller-mover-copy">
          <strong>{card.name || 'Card'}</strong>
          {identity.tileLine ? <em>{identity.tileLine}</em> : null}
          {price ? <span className="seller-mover-price">{price}</span> : null}
        </span>
      </a>
    );
  }
  return (
    <Link className="seller-mover" to={href}>
      <span className="seller-mover-art">
        {art ? <img src={art} alt="" loading="lazy" /> : <span className="tile-ph" />}
      </span>
      <span className="seller-mover-copy">
        <strong>{card.name || 'Card'}</strong>
        {identity.tileLine ? <em>{identity.tileLine}</em> : null}
        {price ? <span className="seller-mover-price">{price}</span> : null}
      </span>
    </Link>
  );
}

function ListingPreviewRow({ row, formatPrice, href }) {
  const art = row.cardImageUrl || row.card_image_url || '';
  const name = row.cardName || row.card_name || 'Card';
  const setName = row.setName || row.set_name || '';
  const condition = row.condition || 'NM';
  const qty = row.quantityAvailable ?? row.quantity_available ?? 1;
  const price = formatPrice(row.pricePkn ?? row.price_pkn);
  const meta = [setName, condition].filter(Boolean).join(' · ');
  const link = href || '#';
  if (link.startsWith('http')) {
    return (
      <a
        className="seller-listing-row"
        href={link}
        onClick={(event) => {
          event.preventDefault();
          goMarket(link);
        }}
      >
        <span className="seller-listing-art">
          {art ? <img src={art} alt="" loading="lazy" /> : <span className="tile-ph" />}
        </span>
        <span className="seller-listing-copy">
          <strong>{name}</strong>
          <em>{meta || 'Listing'}</em>
          <span className="seller-listing-qty">Qty {qty}</span>
        </span>
        <span className="seller-listing-price">{price || '—'}</span>
      </a>
    );
  }
  return (
    <Link className="seller-listing-row" to={link}>
      <span className="seller-listing-art">
        {art ? <img src={art} alt="" loading="lazy" /> : <span className="tile-ph" />}
      </span>
      <span className="seller-listing-copy">
        <strong>{name}</strong>
        <em>{meta || 'Listing'}</em>
        <span className="seller-listing-qty">Qty {qty}</span>
      </span>
      <span className="seller-listing-price">{price || '—'}</span>
    </Link>
  );
}

/**
 * Presentational seller dashboard. Data is passed in so preview/tests can
 * render dense layouts without Firebase.
 */
export function SellerDashboardView({
  ownedCards,
  physicalOwned,
  nftOwned,
  uniqueItems,
  pknBalance = 0,
  listed,
  listingRows = [],
  movers = [],
  loading,
  error,
  collectionHref,
  inventoryHref,
  marketplaceHref,
  onRetry,
  listingHrefFor,
  previewBanner = false,
}) {
  const empty = !loading && !error
    && ownedCards === 0
    && !(listed?.cards > 0);

  const physicalQty = Math.max(0, Number(physicalOwned) || 0);
  const nftQty = Math.max(0, Number(nftOwned) || 0);
  const owned = Math.max(0, Number(ownedCards) || 0);
  const balance = Math.max(0, Number(pknBalance) || 0);
  const listedCards = Math.max(0, Number(listed?.cards) || 0);
  const mixBase = physicalQty + nftQty;
  const physicalPct = mixBase > 0 ? (physicalQty / mixBase) * 100 : 0;
  const nftPct = mixBase > 0 ? (nftQty / mixBase) * 100 : 0;
  const listedPct = owned > 0 ? Math.min(100, (listedCards / owned) * 100) : 0;
  const unique = Math.max(0, Number(uniqueItems) || 0);

  return (
    <div className="page desk seller-home" data-testid="seller-home">
      {previewBanner ? (
        <p className="seller-preview-banner" role="status">
          Layout preview — fixture data, not your live collection.
        </p>
      ) : null}
      <PageHead title="Dashboard" />

      <div className="seller-home-grid">
        <section className="seller-tile seller-tile-portfolio" aria-labelledby="seller-portfolio-title">
          <header className="seller-tile-head">
            <h2 id="seller-portfolio-title">Portfolio</h2>
            <p className="seller-tile-sub">Your collection</p>
          </header>

          {loading ? (
            <div className="seller-tile-body" aria-busy="true" aria-label="Loading collection">
              <div className="seller-metrics">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="seller-metric">
                    <div className="skeleton-line" />
                    <div className="skeleton-line short" />
                  </div>
                ))}
              </div>
              <div className="skeleton-line seller-history-skel" />
            </div>
          ) : null}

          {error ? (
            <div className="seller-tile-body">
              <Alert>{error}</Alert>
              <div className="seller-tile-actions">
                <button type="button" className="btn ghost" onClick={onRetry} data-testid="portfolio-retry">
                  Retry
                </button>
                <a className="btn ghost" href={collectionHref} data-testid="portfolio-view-collection">
                  View collection
                </a>
              </div>
            </div>
          ) : null}

          {!loading && !error ? (
            <div className={`seller-tile-body${empty ? ' is-empty' : ''}`}>
              <div className="seller-metrics" data-testid="portfolio-metrics">
                <div className="seller-metric">
                  <strong>{owned.toLocaleString('en-US')}</strong>
                  <span>{owned === 1 ? 'Card owned' : 'Cards owned'}</span>
                </div>
                <div className="seller-metric">
                  <strong>{listed?.failed ? '—' : listedCards.toLocaleString('en-US')}</strong>
                  <span>Listed for sale</span>
                </div>
                <div className="seller-metric" data-testid="currency-availability">
                  <strong>{formatPknNumber(balance)} PKN</strong>
                  <span>Currency availability</span>
                </div>
                <div className="seller-metric">
                  <strong>{nftQty.toLocaleString('en-US')}</strong>
                  <span>Digital / NFT</span>
                </div>
              </div>

              {listed && !listed.failed && listed.listedPkn > 0 ? (
                <p className="seller-asking" data-testid="total-asking-value">
                  <span>Total asking value</span>
                  <strong>{formatPkn(listed.listedPkn)}</strong>
                </p>
              ) : null}

              <CollectionHistoryPanel currencyPkn={balance} />

              <div className="seller-tile-actions">
                {empty ? (
                  <Link className="btn" to="/scan" data-testid="portfolio-empty-scan">
                    Scan cards
                  </Link>
                ) : null}
                <a className="btn ghost" href={collectionHref} data-testid="portfolio-view-collection">
                  View collection
                </a>
              </div>
            </div>
          ) : null}
        </section>

        <section className="seller-tile seller-tile-list" aria-labelledby="seller-list-title">
          <header className="seller-tile-head">
            <h2 id="seller-list-title">Add Cards</h2>
            <p className="seller-tile-sub">
              Scan cards to add them to your collection or list them for sale.
            </p>
          </header>
          <div className="seller-tile-body seller-tile-cta">
            <AddCardsArt />
            <Link className="btn" to="/scan" data-testid="list-cards-scan">
              Scan cards
            </Link>
          </div>
        </section>
      </div>

      <section className="seller-panel seller-movers-panel" aria-labelledby="seller-movers-title">
        <header className="seller-panel-head">
          <h2 id="seller-movers-title">Trending on Pokoin</h2>
          <a className="seller-panel-link" href={marketplaceHref}>
            Marketplace →
          </a>
        </header>
        {movers.length ? (
          <div className="seller-movers-rail" data-testid="marketplace-movers">
            {movers.map((card) => (
              <MoverCard key={card.id} card={card} />
            ))}
          </div>
        ) : (
          <p className="seller-panel-empty">
            {loading ? 'Loading marketplace…' : 'Marketplace trending rail is unavailable right now.'}
          </p>
        )}
      </section>

      <div className="seller-secondary-grid">
        <section className="seller-panel" aria-labelledby="seller-listings-title">
          <header className="seller-panel-head">
            <h2 id="seller-listings-title">Your listings</h2>
            <a className="seller-panel-link" href={inventoryHref}>View inventory →</a>
          </header>
          {listed?.failed ? (
            <p className="seller-panel-empty">Listings unavailable.</p>
          ) : null}
          {!listed?.failed && listingRows.length ? (
            <div className="seller-listing-list" data-testid="your-listings">
              {listingRows.map((row) => (
                <ListingPreviewRow
                  key={row.id || `${row.cardId}-${row.pricePkn}`}
                  row={row}
                  formatPrice={formatPkn}
                  href={listingHrefFor?.(row) || inventoryHref}
                />
              ))}
            </div>
          ) : null}
          {!listed?.failed && !listingRows.length && !loading ? (
            <EmptyDesk nested title="No cards listed yet" lede="Scan a pile and list what you want to sell.">
              <Link className="btn" to="/scan">Scan cards</Link>
            </EmptyDesk>
          ) : null}
        </section>

        <section className="seller-panel" aria-labelledby="seller-insights-title">
          <header className="seller-panel-head">
            <h2 id="seller-insights-title">Collection insights</h2>
          </header>
          {!loading && !error && owned > 0 ? (
            <div className="seller-insights" data-testid="collection-insights">
              <p className="seller-insight-line">
                <strong>{unique.toLocaleString('en-US')}</strong>
                {' '}
                unique
                {unique === 1 ? ' card' : ' cards'}
                {' · '}
                <strong>{owned.toLocaleString('en-US')}</strong>
                {' '}
                total quantity
              </p>
              <h3 className="seller-insight-h">Collection mix</h3>
              <MixBar label="Physical" pct={physicalPct} tone="gold" />
              <MixBar label="Digital / NFT" pct={nftPct} tone="blue" />
              <MixBar label="Listed of owned" pct={listedPct} tone="green" />
            </div>
          ) : (
            <p className="seller-panel-empty">
              {loading ? 'Loading…' : 'Insights appear once you own cards.'}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

export { AddCardsArt };
