import { Component, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { cardHref, formatPkn, imageSrc } from '../api.js';
import { cardReference, writeListingDrag } from '../chat-listing.js';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import CardTraderAssetsPanel from './CardTraderAssetsPanel.jsx';
import MiniCardTile from './MiniCardTile.jsx';
import { printingIdentity } from '../identity.js';
import { formatPknNumber, tilePricePkn } from '../pkn.js';
import {
  DEFAULT_HISTORY_PRESET,
  availableHistoryPresets,
  formatHistoryAxisLabel,
  formatHistoryDelta,
  formatHistoryTip,
  historyAxis,
  historyPresetWindow,
  historyPlotX,
  historyPointerDay,
  historyWindowChange,
  historyWindowSplit,
  sliceHistorySeries,
  stepHistoryPoints,
} from '../portfolio-history.js';
import { DASHBOARD_SCAN, marketUrl, goMarket } from '../punchouts.js';

const CHART_W = 640;
const CHART_H = 200;

export class DashboardBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('dashboard render failed', error);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="page desk seller-home" data-testid="seller-home-error">
          <p className="seller-panel-empty">The dashboard hit a drawing error. Reload the page.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

class HistoryBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('collection history render failed', error);
  }

  render() {
    if (this.state.failed) {
      return <p className="seller-panel-empty">Collection history is unavailable.</p>;
    }
    return this.props.children;
  }
}

/**
 * Collection value chart. Opens on the last month. Longer windows appear only
 * when stored history reaches them; a calendar picks any other period.
 * Draws real observations only — never a fake flat from a single balance.
 */
export function CollectionHistoryPanel({ series = null, pending = false }) {
  const [hover, setHover] = useState(null);
  const [preset, setPreset] = useState(DEFAULT_HISTORY_PRESET);
  const [custom, setCustom] = useState(null);
  const frameRef = useRef(null);
  const tipRef = useRef(null);
  const presets = availableHistoryPresets(series);
  const presetId = custom
    ? ''
    : (presets.some((row) => row.id === preset) ? preset : DEFAULT_HISTORY_PRESET);
  const bounds = custom
    ? { from: custom.from, to: custom.to, preset: 'custom' }
    : historyPresetWindow(presetId || 'MAX');
  const points = sliceHistorySeries(series, bounds);
  const hasLine = points.length >= 2;
  const hasPoint = points.length === 1;
  const hasData = points.length > 0;
  const axis = historyAxis(points);
  const change = historyWindowChange(points, custom ? 'custom' : presetId);
  const split = historyWindowSplit(points);
  const withYear = points.length > 1
    && String(points[0]?.date || '').slice(0, 4) !== String(points[points.length - 1]?.date || '').slice(0, 4);
  const xLabels = points.length
    ? (points[0].date === points[points.length - 1].date ? [points[0]] : [points[0], points[points.length - 1]])
    : [];

  function xOf(date) {
    return historyPlotX(date, {
      from: points[0]?.date,
      to: points[points.length - 1]?.date,
      width: CHART_W,
      split,
    });
  }

  function yOf(total, day) {
    if (axis.zoomed && !day?.assets?.cardsKnown) return CHART_H + 12;
    const span = Math.max(1, axis.yMax - axis.yMin);
    const clamped = Math.min(axis.yMax, Math.max(axis.yMin, Number(total) || 0));
    const t = (clamped - axis.yMin) / span;
    return CHART_H - t * (CHART_H - 28) - 14;
  }

  let polyline = '';
  let area = '';
  let endDot = null;
  if (hasLine) {
    const coords = points.map((day) => ({
      x: xOf(day.date),
      y: yOf(day.totalPkn, day),
      day,
    }));
    const drawn = axis.zoomed ? coords.filter((point) => point.day?.assets?.cardsKnown) : coords;
    const line = drawn.length > 1 ? drawn : coords;
    const stepped = stepHistoryPoints(line);
    polyline = stepped.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
    const originX = line[0].x.toFixed(1);
    const endX = line[line.length - 1].x.toFixed(1);
    area = `${originX},${CHART_H} ${polyline} ${endX},${CHART_H}`;
    endDot = line[line.length - 1];
  } else if (hasPoint) {
    const day = points[0];
    endDot = { x: xOf(day.date), y: yOf(day.totalPkn, day), day };
  }
  const projection = split < 1 && endDot
    ? `${endDot.x.toFixed(1)},${endDot.y.toFixed(1)} ${CHART_W},${endDot.y.toFixed(1)} ${CHART_W},${CHART_H} ${endDot.x.toFixed(1)},${CHART_H}`
    : '';

  const tipDay = hover?.day || null;
  const tip = formatHistoryTip(tipDay, { projection: Boolean(hover?.projection) });
  const tipLeftPct = hover?.xPct
    ?? (endDot ? (endDot.x / CHART_W) * 100 : 50);

  function onMove(event) {
    if (!hasData) {
      setHover(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    const hit = historyPointerDay(points, ratio, { split });
    const xPct = hasPoint && endDot && !hit.projection
      ? (endDot.x / CHART_W) * 100
      : Math.min(96, Math.max(4, hit.xPct));
    setHover({ day: hit.day, xPct, projection: hit.projection });
  }

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const node = tipRef.current;
    if (!frame || !node) return;
    node.style.transform = 'translateX(-50%)';
    const frameBox = frame.getBoundingClientRect();
    const tipBox = node.getBoundingClientRect();
    const pad = 8;
    const room = frameBox.width - pad * 2;
    let nudge = 0;
    if (tipBox.width > room && room > 0) nudge = (frameBox.left + pad) - tipBox.left;
    else if (tipBox.left < frameBox.left + pad) nudge = (frameBox.left + pad) - tipBox.left;
    else if (tipBox.right > frameBox.right - pad) nudge = (frameBox.right - pad) - tipBox.right;
    if (nudge) node.style.transform = `translateX(calc(-50% + ${nudge}px))`;
  });

  function pickDates(nextFrom, nextTo) {
    if (!nextFrom || !nextTo) {
      setCustom(null);
      return;
    }
    setCustom({ from: nextFrom, to: nextTo });
  }

  return (
    <div
      className="seller-history"
      data-testid="collection-history"
      data-history={hasLine ? 'series' : (hasPoint ? 'point' : 'empty')}
      data-range={custom ? 'custom' : presetId}
    >
      <div className="seller-history-head">
        {change ? (
          <div className="seller-history-value">
            <strong>{formatPknNumber(change.last)} PKN</strong>
            <span className={`seller-history-delta${change.delta < 0 ? ' is-down' : ' is-up'}`}>
              {formatHistoryDelta(change)}
            </span>
          </div>
        ) : null}
        {presets.length ? (
          <div className="seller-history-ranges">
            <div className="seller-history-presets" role="group" aria-label="History period">
              {presets.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  aria-pressed={!custom && presetId === row.id}
                  onClick={() => {
                    setPreset(row.id);
                    setCustom(null);
                  }}
                >
                  {row.label}
                </button>
              ))}
            </div>
            <div className="seller-history-dates">
              <input
                type="date"
                aria-label="From"
                value={bounds.from || ''}
                max={bounds.to || undefined}
                onChange={(event) => pickDates(event.target.value, bounds.to)}
              />
              <span aria-hidden="true">–</span>
              <input
                type="date"
                aria-label="To"
                value={bounds.to || ''}
                min={bounds.from || undefined}
                onChange={(event) => pickDates(bounds.from, event.target.value)}
              />
            </div>
          </div>
        ) : null}
      </div>
      <div className="seller-history-chart">
        <div className="seller-history-y" aria-hidden="true">
          {[...axis.ticks].reverse().map((tick) => (
            <span key={tick}>{formatPknNumber(tick)}</span>
          ))}
        </div>
        <div className="seller-history-plot">
          <div
            ref={frameRef}
            className="seller-history-frame"
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            role="img"
            aria-label="Collection value history chart"
          >
            <svg
              className={`seller-history-grid${hasLine || hasPoint ? '' : ' is-empty'}`}
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="collection-history-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ffd33d" stopOpacity="0.28" />
                  <stop offset="100%" stopColor="#ffd33d" stopOpacity="0" />
                </linearGradient>
                <pattern id="collection-history-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(32)">
                  <line x1="0" y1="0" x2="0" y2="7" stroke="#ffd33d" strokeOpacity="0.55" strokeWidth="1.6" />
                </pattern>
              </defs>
              {axis.ticks.map((tick) => (
                <line
                  key={`rule-${tick}`}
                  className="seller-history-rule"
                  x1="0"
                  x2={CHART_W}
                  y1={yOf(tick)}
                  y2={yOf(tick)}
                />
              ))}
              {projection ? <polygon className="seller-history-projection" points={projection} /> : null}
              {hasLine ? (
                <>
                  <polygon className="seller-history-fill" points={area} />
                  <polyline className="seller-history-line" points={polyline} fill="none" />
                </>
              ) : null}
              {hover && (hasLine || hasPoint) ? (
                <line
                  className="seller-history-crosshair"
                  x1={(hover.xPct / 100) * CHART_W}
                  x2={(hover.xPct / 100) * CHART_W}
                  y1="0"
                  y2={CHART_H}
                />
              ) : null}
            </svg>
            {/* CSS circle — SVG circle stretches under preserveAspectRatio=none. */}
            {endDot ? (
              <span
                className="seller-history-point"
                data-testid="collection-history-point"
                style={{
                  left: `${(endDot.x / CHART_W) * 100}%`,
                  top: `${(endDot.y / CHART_H) * 100}%`,
                }}
              />
            ) : null}
            {!hasData && !pending ? (
              <div className="seller-history-empty">
                <p className="seller-history-title">Collection history will appear here</p>
                <p className="seller-history-lede">
                  Scan cards to start building your portfolio.
                </p>
              </div>
            ) : null}
            {tip ? (
              <div
                ref={tipRef}
                className="seller-history-tip"
                data-testid="collection-history-tip"
                style={{ left: `${tipLeftPct}%`, transform: 'translateX(-50%)' }}
              >
                <p className="seller-history-tip-day">{tip.dateLabel}</p>
                <p className="seller-history-tip-total">{tip.totalLabel}</p>
                <ul>
                  {tip.rows.map((row) => (
                    <li key={row.label}>
                      <span>{row.label}</span>
                      <strong>{row.value}</strong>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <div className={`seller-history-x${split < 1 ? ' has-projection' : ''}`} aria-hidden="true">
            {xLabels.map((day, index) => (
              <span
                key={day.date}
                className={split < 1 && index === xLabels.length - 1 && xLabels.length > 1 ? 'is-today' : undefined}
              >
                {formatHistoryAxisLabel(day.date, withYear)}
              </span>
            ))}
            {!xLabels.length ? <span> </span> : null}
          </div>
        </div>
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

function DeskLink({ href, className, children, ...rest }) {
  const target = String(href || '');
  if (target.startsWith('http')) {
    return (
      <a
        className={className}
        href={target}
        onClick={(event) => {
          event.preventDefault();
          goMarket(target);
        }}
        {...rest}
      >
        {children}
      </a>
    );
  }
  return (
    <Link className={className} to={target || '/marketplace'} {...rest}>
      {children}
    </Link>
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
        draggable
        onDragStart={(event) => writeListingDrag(event, cardReference(card))}
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
    <Link className="seller-mover" to={href} draggable onDragStart={(event) => writeListingDrag(event, cardReference(card))}>
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

function ListingPreviewTile({ row, href }) {
  // Your listings sheet: art-only miniatures. Name stays on aria-label; no
  // set / condition / qty / price chrome on the tile itself.
  const name = row.cardName || row.card_name || 'Card';
  return (
    <MiniCardTile
      imageUrl={row.cardImageUrl || row.card_image_url || ''}
      name={name}
      title={name}
      cardId={row.cardId || row.card_id || ''}
      listingId={row.id || row.listingId || ''}
      sellerUid={row.sellerUid || row.seller_uid || ''}
      seller={row.sellerUsername || row.seller_name || ''}
      pricePkn={row.pricePkn || row.price_pkn || 0}
      href={href || ''}
    />
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
  cardTraderAssets = null,
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
  historySeries = [],
  historyPending = false,
}) {
  const oneDayReadyCards = cardTraderAssets?.oneDayReady
    ? Math.max(0, Number(cardTraderAssets.totals?.cards) || 0)
    : 0;
  const empty = !loading && !error
    && ownedCards === 0
    && !(listed?.cards > 0)
    && oneDayReadyCards === 0;

  const physicalQty = Math.max(0, Number(physicalOwned) || 0);
  const nftQty = Math.max(0, Number(nftOwned) || 0);
  const owned = Math.max(0, Number(ownedCards) || 0) + oneDayReadyCards;
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
                <DeskLink className="btn ghost" href={collectionHref} data-testid="portfolio-view-collection">
                  View collection
                </DeskLink>
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

              {oneDayReadyCards > 0 ? (
                <p className="seller-asking" data-testid="cardtrader-1dr-value">
                  <span>CardTrader 1-DR assets · {oneDayReadyCards.toLocaleString('en-US')} cards</span>
                  <strong title="Sold today">
                    {(Number(cardTraderAssets.totals?.valuePkn) || 0) > 0
                      ? formatPkn(cardTraderAssets.totals.valuePkn)
                      : '—'}
                  </strong>
                </p>
              ) : null}

              <HistoryBoundary>
                <CollectionHistoryPanel series={historySeries} pending={historyPending} />
              </HistoryBoundary>

              <div className="seller-tile-actions">
                <DeskLink className="btn ghost" href={collectionHref} data-testid="portfolio-view-collection">
                  View collection
                </DeskLink>
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
            <Link className="btn" to={DASHBOARD_SCAN} data-testid="list-cards-scan">
              Scan cards
            </Link>
          </div>
        </section>
      </div>

      <section className="seller-panel seller-movers-panel" aria-labelledby="seller-movers-title">
        <header className="seller-panel-head">
          <h2 id="seller-movers-title">Trending on Pokoin</h2>
          <DeskLink className="seller-panel-link" href={marketplaceHref}>
            Marketplace →
          </DeskLink>
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

      {/* CardTrader 1-DR sits next to Your listings as the same miniature sheet. */}
      <div className={`seller-secondary-grid${oneDayReadyCards > 0 ? ' has-1dr' : ''}`}>
        <section className="seller-panel" aria-labelledby="seller-listings-title">
          <header className="seller-panel-head">
            <h2 id="seller-listings-title">Your listings</h2>
            <DeskLink className="seller-panel-link" href={inventoryHref}>View inventory →</DeskLink>
          </header>
          {listed?.failed ? (
            <p className="seller-panel-empty">Listings unavailable.</p>
          ) : null}
          {!listed?.failed && listingRows.length ? (
            <div className="seller-listing-list" data-testid="your-listings">
              {listingRows.map((row) => (
                <ListingPreviewTile
                  key={row.id || `${row.cardId}-${row.pricePkn}`}
                  row={row}
                  href={listingHrefFor?.(row) || inventoryHref}
                />
              ))}
            </div>
          ) : null}
          {!listed?.failed && !listingRows.length && !loading ? (
            <EmptyDesk nested title="No cards listed yet" lede="Scan a pile and list what you want to sell.">
              <Link className="btn" to={DASHBOARD_SCAN}>Scan cards</Link>
            </EmptyDesk>
          ) : null}
        </section>

        <CardTraderAssetsPanel assets={cardTraderAssets} />

        <section className="seller-panel seller-insights-panel" aria-labelledby="seller-insights-title">
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
