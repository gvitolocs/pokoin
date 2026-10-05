import { Component, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  daySpan,
  formatDayLabel,
  formatHistoryDelta,
  formatHistoryTip,
  formatProjectionTip,
  historyAxis,
  historyDateTicks,
  historyDayAt,
  historyPresetWindow,
  historyTimeline,
  historyWindowChange,
  projectPortfolio,
  sliceHistorySeries,
  stepHistoryPoints,
  timelineDay,
  timelineRatio,
  withLiveToday,
} from '../portfolio-history.js';
import { DASHBOARD_SCAN, marketUrl, goMarket } from '../punchouts.js';
import SellSpreadsheetTile from './SellSpreadsheetTile.jsx';
import '../sell-spreadsheet.css';

const CHART_W = 640;
const CHART_H = 220;
// Inner padding so a line at the top or on zero never sits on the frame edge.
const PLOT_TOP = 12;
const PLOT_BOTTOM = 8;

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

function pointsAttr(coords) {
  return coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
}

/**
 * Collection value chart, laid out like a multi-asset portfolio tracker:
 * cards stacked on liquidity (wallet PKN), one point per day. Cards are worth
 * each printing slice's last sold median, carried across days without a sale
 * (server/pokoin-api/_portfolio_history_core.js). A window that ends today
 * fills two thirds with realized days; the hatched last third is the
 * projection (projectPortfolio) on the same day scale. Opens on the last
 * month; longer windows appear when stored history reaches them.
 */
export function CollectionHistoryPanel({ series = null, pending = false, live = undefined }) {
  const [hover, setHover] = useState(null);
  const [preset, setPreset] = useState(DEFAULT_HISTORY_PRESET);
  const [custom, setCustom] = useState(null);
  const frameRef = useRef(null);
  const tipRef = useRef(null);
  const days = useMemo(() => withLiveToday(series, live || {}), [series, live]);
  const presets = availableHistoryPresets(days);
  const presetId = custom
    ? ''
    : (presets.some((row) => row.id === preset) ? preset : DEFAULT_HISTORY_PRESET);
  const bounds = custom
    ? { from: custom.from, to: custom.to, preset: 'custom' }
    : historyPresetWindow(presetId || 'MAX');
  const points = sliceHistorySeries(days, bounds);
  const hasLine = points.length >= 2;
  const hasPoint = points.length === 1;
  const hasData = points.length > 0;
  const timeline = historyTimeline(points);
  const projection = projectPortfolio(points, timeline);
  const axis = historyAxis([
    ...points.map((day) => day.totalPkn),
    ...(projection ? projection.days.flatMap((day) => [day.low, day.high]) : []),
  ]);
  const change = historyWindowChange(points, custom ? 'custom' : presetId);
  const ticks = historyDateTicks(timeline);
  const split = timeline ? timeline.split : 1;

  function xOf(date) {
    return timelineRatio(timeline, date) * CHART_W;
  }

  function yOf(value) {
    const span = Math.max(1e-9, axis.yMax - axis.yMin);
    const clamped = Math.min(axis.yMax, Math.max(axis.yMin, Number(value) || 0));
    const t = (clamped - axis.yMin) / span;
    return CHART_H - PLOT_BOTTOM - t * (CHART_H - PLOT_TOP - PLOT_BOTTOM);
  }

  const baseY = CHART_H - PLOT_BOTTOM;
  let totalLine = '';
  let cardsArea = '';
  let liquidityArea = '';
  let endDot = null;
  if (hasData) {
    const coords = points.map((day) => ({ x: xOf(day.date), day }));
    const totalTop = stepHistoryPoints(coords.map((c) => ({ x: c.x, y: yOf(c.day.totalPkn) })));
    const liquidityTop = stepHistoryPoints(coords.map((c) => ({ x: c.x, y: yOf(c.day.assets.currencyPkn) })));
    if (hasLine) {
      totalLine = pointsAttr(totalTop);
      cardsArea = pointsAttr([...liquidityTop, ...[...totalTop].reverse()]);
      const firstX = liquidityTop[0].x;
      const lastX = liquidityTop[liquidityTop.length - 1].x;
      liquidityArea = pointsAttr([{ x: firstX, y: baseY }, ...liquidityTop, { x: lastX, y: baseY }]);
    }
    const last = coords[coords.length - 1];
    endDot = { x: last.x, y: yOf(last.day.totalPkn) };
  }

  let projectionLine = '';
  let projectionHatch = '';
  let projectionBand = '';
  let projectionLow = '';
  let projectionHigh = '';
  if (projection && endDot) {
    const center = projection.days.map((day) => ({ x: xOf(day.date), y: yOf(day.value) }));
    projectionLine = pointsAttr(center);
    projectionHatch = pointsAttr([
      { x: center[0].x, y: baseY },
      ...center,
      { x: center[center.length - 1].x, y: baseY },
    ]);
    if (projection.band) {
      const high = projection.days.map((day) => ({ x: xOf(day.date), y: yOf(day.high) }));
      const low = projection.days.map((day) => ({ x: xOf(day.date), y: yOf(day.low) }));
      projectionBand = pointsAttr([...high, ...[...low].reverse()]);
      projectionHigh = pointsAttr(high);
      projectionLow = pointsAttr(low);
    }
  }

  // Hover: the day under the pointer, realized or projected.
  let tip = null;
  let hoverDot = null;
  let legendDay = points[points.length - 1] || null;
  if (hover && timeline && hasData) {
    const date = timelineDay(timeline, hover.ratio);
    if (projection && date > timeline.to) {
      const point = projection.days[Math.min(projection.days.length - 1, daySpan(timeline.to, date))];
      tip = formatProjectionTip(point, projection);
      hoverDot = { x: xOf(point.date), y: yOf(point.value), projected: true };
    } else {
      const day = historyDayAt(points, date);
      legendDay = day;
      tip = formatHistoryTip(day);
      if (tip) tip.dateLabel = formatDayLabel(date);
      hoverDot = { x: xOf(date), y: yOf(day?.totalPkn) };
    }
  }
  const tipLeftPct = hoverDot ? (hoverDot.x / CHART_W) * 100 : 50;
  // The tip sits beside the crosshair so it never covers the point it describes.
  const tipOnRight = tipLeftPct < 55;
  const legendCards = legendDay?.assets?.cardsValuePkn;

  function onPointer(event) {
    if (!hasData || !timeline) {
      setHover(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    setHover({ ratio: Math.min(1, Math.max(0, ratio)) });
  }

  // Keep the tip inside the plot on a narrow screen.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const node = tipRef.current;
    if (!frame || !node) return;
    node.style.transform = '';
    const frameBox = frame.getBoundingClientRect();
    const tipBox = node.getBoundingClientRect();
    const pad = 6;
    let nudge = 0;
    if (tipBox.left < frameBox.left + pad) nudge = (frameBox.left + pad) - tipBox.left;
    else if (tipBox.right > frameBox.right - pad) nudge = (frameBox.right - pad) - tipBox.right;
    if (nudge) node.style.transform = `translateX(${nudge}px)`;
  });

  function pickDates(nextFrom, nextTo) {
    if (!nextFrom || !nextTo) {
      setCustom(null);
      return;
    }
    setCustom({ from: nextFrom, to: nextTo });
  }

  const widestTick = axis.ticks.reduce((wide, tick) => {
    const text = formatPknNumber(tick);
    return text.length > wide.length ? text : wide;
  }, '0');
  const summary = hasData
    ? `Collection value from ${formatDayLabel(points[0].date)} to ${formatDayLabel(points[points.length - 1].date)}: `
      + `${formatPknNumber(points[0].totalPkn)} PKN to ${formatPknNumber(points[points.length - 1].totalPkn)} PKN`
      + (projection ? `, projected ${formatPknNumber(projection.end.value)} PKN by ${formatDayLabel(projection.end.date)}` : '')
    : 'Collection value history chart';

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
                value={bounds.from || points[0]?.date || ''}
                max={bounds.to || undefined}
                onChange={(event) => pickDates(event.target.value, bounds.to)}
              />
              <span aria-hidden="true">–</span>
              <input
                type="date"
                aria-label="To"
                value={bounds.to || ''}
                min={bounds.from || undefined}
                onChange={(event) => pickDates(bounds.from || points[0]?.date || '', event.target.value)}
              />
            </div>
          </div>
        ) : null}
        {hasData ? (
          <ul className="seller-history-legend" aria-label="Chart layers">
            <li className="is-cards">
              <span className="seller-history-key" aria-hidden="true" />
              <span>Cards</span>
              <strong>{legendCards != null ? `${formatPknNumber(legendCards)} PKN` : '—'}</strong>
              {legendDay?.assets?.cardsHeld ? (
                <em>
                  {legendDay.assets.cardsPriced.toLocaleString('en-US')} of {legendDay.assets.cardsHeld.toLocaleString('en-US')} with a sale
                </em>
              ) : null}
            </li>
            <li className="is-liquidity">
              <span className="seller-history-key" aria-hidden="true" />
              <span>Liquidity</span>
              <strong>{formatPknNumber(legendDay?.assets?.currencyPkn || 0)} PKN</strong>
            </li>
            {projection ? (
              <li className="is-projection">
                <span className="seller-history-key" aria-hidden="true" />
                <span>Projection</span>
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
      <div className="seller-history-chart">
        <div className="seller-history-y" aria-hidden="true">
          <span className="seller-history-y-sizer">{widestTick}</span>
          <div className="seller-history-y-ticks">
            {axis.ticks.map((tick) => (
              <span key={tick} style={{ top: `${(yOf(tick) / CHART_H) * 100}%` }}>
                {formatPknNumber(tick)}
              </span>
            ))}
          </div>
        </div>
        <div
          ref={frameRef}
          className="seller-history-frame"
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={summary}
        >
          <svg
            className={`seller-history-grid${hasData ? '' : ' is-empty'}`}
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="collection-history-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ffd33d" stopOpacity="0.24" />
                <stop offset="100%" stopColor="#ffd33d" stopOpacity="0.03" />
              </linearGradient>
              <pattern id="collection-history-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="7" stroke="#ffd33d" strokeOpacity="0.32" strokeWidth="1.4" />
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
            {hasLine ? (
              <>
                <polygon className="seller-history-liquidity" points={liquidityArea} />
                <polygon className="seller-history-fill" points={cardsArea} />
              </>
            ) : null}
            {projectionHatch ? <polygon className="seller-history-projection" points={projectionHatch} /> : null}
            {projectionBand ? <polygon className="seller-history-band" points={projectionBand} /> : null}
            {projectionHigh ? <polyline className="seller-history-band-edge" points={projectionHigh} fill="none" /> : null}
            {projectionLow ? <polyline className="seller-history-band-edge" points={projectionLow} fill="none" /> : null}
            {split < 1 ? (
              <line className="seller-history-today" x1={split * CHART_W} x2={split * CHART_W} y1="0" y2={CHART_H} />
            ) : null}
            {projectionLine ? (
              <polyline className="seller-history-forecast" points={projectionLine} fill="none" />
            ) : null}
            {hasLine ? <polyline className="seller-history-line" points={totalLine} fill="none" /> : null}
            {hoverDot ? (
              <line
                className="seller-history-crosshair"
                x1={hoverDot.x}
                x2={hoverDot.x}
                y1="0"
                y2={CHART_H}
              />
            ) : null}
          </svg>
          {!hasData && !pending ? (
            <div className="seller-history-empty">
              <p className="seller-history-title">Collection history will appear here</p>
              <p className="seller-history-lede">
                Scan cards to start building your portfolio.
              </p>
            </div>
          ) : null}
        </div>
        {/* Dots and the tip sit over the frame without its clipping. CSS
            circles, because an SVG circle stretches under preserveAspectRatio=none. */}
        <div className="seller-history-overlay" aria-hidden="true">
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
          {hoverDot ? (
            <span
              className={`seller-history-point is-hover${hoverDot.projected ? ' is-projected' : ''}`}
              style={{
                left: `${(hoverDot.x / CHART_W) * 100}%`,
                top: `${(hoverDot.y / CHART_H) * 100}%`,
              }}
            />
          ) : null}
          {tip ? (
            <div
              ref={tipRef}
              className="seller-history-tip"
              data-testid="collection-history-tip"
              style={tipOnRight
                ? { left: `calc(${tipLeftPct}% + 14px)` }
                : { right: `calc(${100 - tipLeftPct}% + 14px)` }}
            >
              <p className="seller-history-tip-day">{tip.dateLabel}</p>
              <p className="seller-history-tip-total">{tip.totalLabel}</p>
              {tip.rows.length ? (
                <ul>
                  {tip.rows.map((row) => (
                    <li key={row.key} className={`is-${row.key}`}>
                      <span>{row.label}</span>
                      <strong>{row.value}</strong>
                      {row.note ? <em>{row.note}</em> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {tip.footnote ? <p className="seller-history-tip-note">{tip.footnote}</p> : null}
            </div>
          ) : null}
        </div>
        <div className="seller-history-x" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick.date} className={tick.minor ? 'is-minor' : undefined} style={{ left: `${tick.ratio * 100}%` }}>
              {tick.label}
            </span>
          ))}
          {hasData && split < 1 ? (
            <span className="is-today" style={{ left: `${split * 100}%` }}>Today</span>
          ) : null}
          {hasData && split >= 1 ? (
            <span className="is-end" style={{ left: '100%' }}>{formatDayLabel(points[points.length - 1].date)}</span>
          ) : null}
        </div>
      </div>
      {hasData ? (
        <table className="sr-only">
          <caption>Collection value by day</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Cards</th>
              <th scope="col">Liquidity</th>
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {points.filter((day) => !day.carried).map((day) => (
              <tr key={day.date}>
                <th scope="row">{day.date}</th>
                <td>{day.assets.cardsValuePkn != null ? `${formatPknNumber(day.assets.cardsValuePkn)} PKN` : '—'}</td>
                <td>{formatPknNumber(day.assets.currencyPkn)} PKN</td>
                <td>{formatPknNumber(day.totalPkn)} PKN</td>
              </tr>
            ))}
            {projection ? (
              <tr>
                <th scope="row">{projection.end.date} (projection)</th>
                <td>{formatPknNumber(projection.end.cards)} PKN</td>
                <td>{formatPknNumber(projection.end.liquidity)} PKN</td>
                <td>
                  {formatPknNumber(projection.end.value)} PKN
                  {projection.band ? ` (${formatPknNumber(projection.end.low)}–${formatPknNumber(projection.end.high)})` : ''}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : null}
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

// Same 12-by-6 miniature sheet as CardTrader 1-DR.
const LISTING_PREVIEW = 72;

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
  salesHref,
  marketplaceHref,
  onRetry,
  listingHrefFor,
  previewBanner = false,
  historySeries = [],
  historyPending = false,
}) {
  const [showAllListings, setShowAllListings] = useState(false);
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
  const oneDayReadyTotals = cardTraderAssets?.oneDayReady ? cardTraderAssets.totals || null : null;
  const oneDayReadyValue = Math.max(0, Number(oneDayReadyTotals?.valuePkn) || 0);
  const oneDayReadyPriced = Math.max(0, Number(oneDayReadyTotals?.pricedCards) || 0);
  const shownListings = showAllListings ? listingRows : listingRows.slice(0, LISTING_PREVIEW);
  // Today's chart point is the wallet and 1-DR value shown on this tile.
  const historyLive = useMemo(() => ({
    currencyPkn: balance,
    cards: oneDayReadyTotals || undefined,
  }), [balance, oneDayReadyTotals]);

  return (
    <div className="page desk seller-home" data-testid="seller-home">
      {previewBanner ? (
        <p className="seller-preview-banner" role="status">
          Layout preview — fixture data, not your live collection.
        </p>
      ) : null}
      <PageHead title="Dashboard">
        {inventoryHref ? (
          <DeskLink className="btn" href={inventoryHref} data-testid="dashboard-mypokoin">
            MyPokoin
          </DeskLink>
        ) : null}
      </PageHead>

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
                  <span>
                    CardTrader 1-DR assets · {oneDayReadyCards.toLocaleString('en-US')} cards
                    {' · '}
                    {oneDayReadyPriced.toLocaleString('en-US')} with a sale
                  </span>
                  <strong title="Each card at the last sold median of its condition and language. A card that never sold counts 0 PKN.">
                    {oneDayReadyValue > 0 ? formatPkn(oneDayReadyValue) : '0 PKN'}
                  </strong>
                </p>
              ) : null}

              <HistoryBoundary>
                <CollectionHistoryPanel series={historySeries} pending={historyPending} live={historyLive} />
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

      <section className="sell-sheet-hub" aria-labelledby="sell-and-buy-title">
        <h2 id="sell-and-buy-title">Sell and Buy</h2>
        <div className="sell-sheet-hub-grid">
          <SellSpreadsheetTile />
        </div>
      </section>

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
            <span className="seller-panel-links">
              {salesHref ? <DeskLink className="seller-panel-link" href={salesHref}>Sold history →</DeskLink> : null}
              <DeskLink className="seller-panel-link" href={inventoryHref}>View MyPokoin →</DeskLink>
            </span>
          </header>
          {listed?.failed ? (
            <p className="seller-panel-empty">Listings unavailable.</p>
          ) : null}
          {!listed?.failed && listingRows.length ? (
            <div className="seller-listing-list" data-testid="your-listings">
              {shownListings.map((row) => (
                <ListingPreviewTile
                  key={row.id || `${row.cardId}-${row.pricePkn}`}
                  row={row}
                  href={listingHrefFor?.(row) || inventoryHref}
                />
              ))}
            </div>
          ) : null}
          {!listed?.failed && listingRows.length > LISTING_PREVIEW ? (
            <button type="button" className="seller-panel-link ct1dr-more" onClick={() => setShowAllListings((all) => !all)}>
              {showAllListings ? 'Show fewer' : `Show all ${listingRows.length}`}
            </button>
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
