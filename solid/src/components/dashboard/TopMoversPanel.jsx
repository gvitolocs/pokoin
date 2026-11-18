import { createMemo, createSignal, For, Show } from 'solid-js';
import {
  MOVER_LIMIT,
  formatMoverChange,
  formatMoverValue,
  moverChips,
  moverSpark,
  moverSparkHover,
  moverSparkTipPlacement,
  moverTileLine,
  moverTitle,
  moverTone,
} from '@market/portfolio-movers.js';
import MiniCardTile from '../MiniCardTile.jsx';

const SIDES = [
  { id: 'gainers', label: 'Gainers' },
  { id: 'losers', label: 'Losers' },
];

/** The sparkline box; MOVER_SPARK is the viewBox the CSS scales fluidly. */
const SPARK = { width: 120, height: 34 };

const pct = (value, of) => `${(value / of) * 100}%`;

function MoverTile(props) {
  const mover = () => props.mover;
  const spark = createMemo(() => moverSpark(mover(), SPARK));
  const value = () => formatMoverValue(mover(), props.currency);
  const chips = createMemo(() => moverChips(mover()));
  // The sparkline day under the pointer, or null. Hover only: the tile itself
  // stays a plain link, so nothing here cancels or stops a click.
  const [sparkPoint, setSparkPoint] = createSignal(null);
  // The tip lives inside the spark box: anchored to the hovered day,
  // clamped to the box edges, on the vertical side away from the point, so
  // it never covers the tile's text above the sparkline.
  const sparkTipStyle = () => moverSparkTipPlacement(sparkPoint(), spark());

  function trackSpark(event) {
    const box = event.currentTarget.getBoundingClientRect();
    if (!(box.width > 0)) return;
    setSparkPoint(moverSparkHover(spark(), (event.clientX - box.left) / box.width, props.currency));
  }

  const hideSpark = () => setSparkPoint(null);
  const body = () => (
    <>
      <MiniCardTile
        cardId={mover().cardId}
        imageUrl={mover().imageUrl}
        name={mover().name || 'Card'}
        badge={mover().quantity > 1 ? `×${mover().quantity}` : ''}
      />
      <div class="mover-tile-copy">
        <p class="mover-tile-name">{mover().name || 'Card'}</p>
        <Show when={moverTileLine(mover())}>
          <p class="mover-tile-set">{moverTileLine(mover())}</p>
        </Show>
        <Show when={chips().length}>
          <p class="mover-tile-chips">
            <For each={chips()}>{(chip) => <span class="mover-chip">{chip}</span>}</For>
          </p>
        </Show>
        <p class="mover-tile-value">
          <Show when={value()} fallback={<span class="mover-tile-never">never sold</span>}>
            <strong>{value()}</strong>
          </Show>
        </p>
        <p class={['mover-tile-change', moverTone(mover())]}>{formatMoverChange(mover(), props.currency)}</p>
        <Show when={spark().line}>
          <span
            class="mover-spark-wrap"
            onPointerMove={trackSpark}
            onPointerDown={trackSpark}
            onPointerLeave={hideSpark}
            onPointerCancel={hideSpark}
          >
            <svg
              class="mover-spark"
              viewBox={`0 0 ${SPARK.width} ${SPARK.height}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path class="mover-spark-area" d={spark().area} />
              <path class="mover-spark-line" d={spark().line} fill="none" vector-effect="non-scaling-stroke" />
            </svg>
            {/* A CSS circle in %, like the chart above: an SVG circle stretches
                under preserveAspectRatio=none. */}
            <Show when={sparkPoint()}>
              {(dot) => (
                <span
                  class="mover-spark-dot"
                  aria-hidden="true"
                  style={{ left: pct(dot().x, SPARK.width), top: pct(dot().y, SPARK.height) }}
                />
              )}
            </Show>
            <Show when={sparkPoint()}>
              {(dot) => (
                <span
                  class="mover-spark-tip"
                  aria-hidden="true"
                  style={sparkTipStyle()}
                >
                  <span class="mover-spark-tip-day">{dot().dateLabel}</span>
                  <strong>{dot().valueLabel}</strong>
                </span>
              )}
            </Show>
          </span>
        </Show>
      </div>
    </>
  );
  return (
    <li class="mover-tile">
      <Show
        when={props.href}
        fallback={<div class="mover-tile-body">{body()}</div>}
      >
        <a class="mover-tile-link" href={props.href} aria-label={moverTitle(mover(), props.currency)}>
          {body()}
        </a>
      </Show>
    </li>
  );
}

/**
 * Top movers under the portfolio graph: the seller's own printings whose last
 * sold median moved most inside the window the chart is showing. One slice per
 * tile, so a Condition A and a Condition B copy of the same card can both list.
 * Amounts print in `currency` (the seller's display currency); the endpoint
 * keeps answering in PKN and only the labels convert.
 */
export default function TopMoversPanel(props) {
  const [side, setSide] = createSignal('gainers');
  const limit = () => (Number(props.limit) > 0 ? Number(props.limit) : MOVER_LIMIT);
  const currency = () => String(props.currency || 'PKN').trim().toUpperCase() || 'PKN';
  const rows = () => {
    const list = (side() === 'gainers' ? props.movers?.gainers : props.movers?.losers) || [];
    return list.slice(0, limit());
  };
  // A tile is an amount, so it waits for the currency: `pending` alone still
  // lets a window switch keep the painted rows, never a PKN-then-DKK swap.
  const pending = () => Boolean(props.currencyPending) || (Boolean(props.pending) && !rows().length);
  const hrefFor = (mover) => (props.hrefFor ? props.hrefFor(mover) : '');

  return (
    <section class="seller-panel seller-top-movers" aria-labelledby="top-movers-title">
      <header class="seller-panel-head">
        <h2 id="top-movers-title">Top movers</h2>
        <Show when={props.windowLabel}>
          <span class="seller-top-movers-window">{props.windowLabel}</span>
        </Show>
        <div class="seller-top-movers-switch" role="group" aria-label="Gainers or losers">
          <For each={SIDES}>
            {(option) => (
              <button
                type="button"
                data-testid={`movers-${option.id}`}
                aria-pressed={String(side() === option.id)}
                onClick={() => setSide(option.id)}
              >
                {option.label}
              </button>
            )}
          </For>
        </div>
      </header>
      <Show when={pending()}>
        <ul class="seller-movers-grid is-loading" data-testid="top-movers-loading" aria-hidden="true">
          <For each={Array.from({ length: 3 })}>
            {() => (
              <li class="mover-tile is-skeleton">
                <span class="mover-skeleton-art" />
                <span class="mover-skeleton-copy">
                  <span class="mover-skeleton-line" />
                  <span class="mover-skeleton-line is-short" />
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={!pending() && !rows().length}>
        <p class="seller-panel-empty" data-testid="top-movers-empty">No price movement yet</p>
      </Show>
      <Show when={!pending() && rows().length}>
        <ul class="seller-movers-grid" data-testid="top-movers-grid">
          <For each={rows()}>{(mover) => <MoverTile mover={mover} currency={currency()} href={hrefFor(mover)} />}</For>
        </ul>
      </Show>
    </section>
  );
}
