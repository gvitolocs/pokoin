import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from 'solid-js';
import { moverDaysForPreset } from '@market/portfolio-movers.js';
import {
  DEFAULT_HISTORY_PRESET,
  availableHistoryPresets,
  daySpan,
  formatDayLabel,
  formatHistoryAmount,
  formatHistoryDelta,
  formatHistoryTip,
  historyAxis,
  historyCountValue,
  historyDateTicks,
  historyDayAt,
  historyDrawProgress,
  historyLabelAnchor,
  historyPresetWindow,
  historyTimeline,
  historyWindowChange,
  HISTORY_DRAW_MS,
  HISTORY_PRESETS,
  liquidityBandRatio,
  sliceHistorySeries,
  smoothHistoryPath,
  smoothHistoryPointAt,
  stepHistoryPath,
  timelineDay,
  timelineRatio,
  withLiveToday,
} from '@market/portfolio-history.js';

const CHART_W = 640;
const CHART_H = 220;
// Inner padding so a line at the top or on zero never sits on the frame edge.
const PLOT_TOP = 12;
const PLOT_BOTTOM = 8;
// Today is the right edge; the rule sits a little inside it so the stroke is
// never clipped by the frame.
const TODAY_X = CHART_W - 2;
// The liquidity sub-pane under the baseline. The plot stretches its y, so this
// is viewBox units: about 30 CSS px at the panel's usual frame height.
const BAND_H = 34;
const BAND_GAP = 6;
const BAND_INSET = 3;
// The hover label floats this many CSS pixels above the curve at that day.
const LABEL_GAP = 14;
// The draw-in: a clip rect widens across the plot and the head dot rides its
// edge. The clip rests at the full plot width, so only a running draw hides.
const REVEAL_CLIP = 'collection-history-reveal';
const SHOW_LIQUIDITY_KEY = 'pokoin.dashboard.showLiquidity';

/** Off by default; a browser that refuses storage simply starts from off. */
function readShowLiquidity() {
  try {
    return localStorage.getItem(SHOW_LIQUIDITY_KEY) === '1';
  } catch {
    return false;
  }
}

function writeShowLiquidity(on) {
  try {
    localStorage.setItem(SHOW_LIQUIDITY_KEY, on ? '1' : '0');
  } catch {
    /* private mode or a disabled store: the choice just is not remembered */
  }
}

/** Everything the chart draws for one window (React rendered this inline). */
function layoutChart(points, timeline, showBand) {
  const axis = historyAxis(points.map((day) => day.totalPkn));
  const bandBottom = CHART_H - PLOT_BOTTOM;
  const bandTop = bandBottom - BAND_H;
  const hasLine = points.length >= 2;
  const band = showBand && hasLine;
  // The sub-pane takes its height off the plot, so the baseline lifts when it
  // is on; the curve keeps its own scale either way.
  const baseY = band ? bandTop - BAND_GAP : bandBottom;
  const xOf = (date) => timelineRatio(timeline, date) * CHART_W;
  const yOf = (value) => {
    const span = Math.max(1e-9, axis.yMax - axis.yMin);
    const clamped = Math.min(axis.yMax, Math.max(axis.yMin, Number(value) || 0));
    const t = (clamped - axis.yMin) / span;
    return baseY - t * (baseY - PLOT_TOP);
  };
  const hasData = points.length > 0;
  const out = {
    xOf, yOf, baseY, hasLine, hasData,
    hasPoint: points.length === 1,
    totalLine: '', stepLine: '', liquidityLine: '', liquidityPeak: 0,
    curve: [], endDot: null,
    ticks: historyDateTicks(timeline),
    live: Boolean(timeline?.live),
  };
  if (hasData) {
    const coords = points.map((day) => ({ x: xOf(day.date), day }));
    const totalTop = coords.map((c) => ({ x: c.x, y: yOf(c.day.totalPkn) }));
    if (hasLine) {
      // The curve is the picture; the steps under it say which day the value
      // actually moved, which the smoothing alone would hide.
      out.curve = totalTop;
      out.stepLine = stepHistoryPath(totalTop);
      out.totalLine = smoothHistoryPath(totalTop);
    }
    const last = coords[coords.length - 1];
    out.endDot = { x: last.x, y: yOf(last.day.totalPkn) };
    if (band) {
      const peak = points.reduce((high, day) => Math.max(high, Number(day.assets.currencyPkn) || 0), 0);
      const floor = bandBottom - BAND_INSET;
      const reach = floor - (bandTop + BAND_INSET);
      out.liquidityPeak = peak;
      out.liquidityLine = smoothHistoryPath(coords.map((c) => ({
        x: c.x,
        y: floor - liquidityBandRatio(c.day.assets.currencyPkn, peak) * reach,
      })));
    }
  }
  return out;
}

/**
 * Collection value chart (was in the React SellerDashboardView,
 * CollectionHistoryPanel): one smooth curve of the daily total over the true
 * steps of the same days, with the wallet PKN in a sub-pane only when the
 * seller asks for it. One point per day across the whole plot; a window that
 * ends today stops at the Today mark. Opens on the last month.
 */
export default function CollectionHistoryPanel(props) {
  const [hover, setHover] = createSignal(null);
  const [preset, setPreset] = createSignal(DEFAULT_HISTORY_PRESET);
  const [custom, setCustom] = createSignal(null);
  const [band, setBand] = createSignal(readShowLiquidity());
  // null once the draw is over: the headline then renders the real number.
  const [counted, setCounted] = createSignal(null);
  let frame;
  let labelNode;
  let revealRect;
  let endDotNode;
  let pulseNode;
  let revealFrame;
  let playedRange = '';
  const days = createMemo(() => withLiveToday(props.series || null, props.live || {}));
  const presets = createMemo(() => availableHistoryPresets(days()));
  const presetId = () => (custom()
    ? ''
    : (presets().some((row) => row.id === preset()) ? preset() : DEFAULT_HISTORY_PRESET));
  const bounds = createMemo(() => (custom()
    ? { from: custom().from, to: custom().to, preset: 'custom' }
    : historyPresetWindow(presetId() || 'MAX')));
  const points = createMemo(() => sliceHistorySeries(days(), bounds()));
  const timeline = createMemo(() => historyTimeline(points()));
  const chart = createMemo(() => layoutChart(points(), timeline(), band()));
  const change = () => historyWindowChange(points(), custom() ? 'custom' : presetId());

  // Amounts follow the seller's display currency, like the movers tiles and the
  // segment table under this chart (docs/MARKET.md, "Segment graphs"); PKN is
  // only the unit the series itself is stored in.
  const currency = () => String(props.currency || 'PKN').trim().toUpperCase() || 'PKN';

  // The top movers sheet prices the window the graph is drawing, so it reports
  // the range instead of keeping its own switch.
  createEffect(
    () => [custom() ? 'custom' : presetId(), bounds().from, bounds().to],
    ([id, from, to]) => {
      const days = id === 'custom' ? Math.max(1, daySpan(from, to)) : moverDaysForPreset(id);
      const preset = HISTORY_PRESETS.find((row) => row.id === id);
      const label = id === 'MAX' ? 'all time' : (preset?.phrase || `${days} days`);
      // The callback is a prop, not a dependency: a parent re-render must not
      // restart the movers request.
      untrack(() => {
        // A custom pick carries its own two dates: the segment table below
        // reads the window the graph is drawing, and only the pair says which.
        if (props.onRange) {
          props.onRange(id === 'custom' ? { id, days, label, from, to } : { id, days, label });
        }
      });
    },
  );

  // Resting state is always the whole chart: only a running draw hides
  // anything, so a skipped or interrupted one still shows the series, lands
  // the head dot on the last day, and lets the ring pulse again.
  function showWholeChart() {
    if (revealFrame != null) {
      cancelAnimationFrame(revealFrame);
      revealFrame = undefined;
    }
    if (revealRect) revealRect.setAttribute('width', String(CHART_W));
    if (pulseNode) pulseNode.classList.remove('is-drawing');
    const dot = chart().endDot;
    if (endDotNode && dot) {
      endDotNode.style.left = pct(dot.x, CHART_W);
      endDotNode.style.top = pct(dot.y, CHART_H);
    }
    setCounted(null);
  }

  function reducedMotion() {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  }

  function drawIn() {
    if (reducedMotion() || !revealRect) return;
    if (revealFrame != null) cancelAnimationFrame(revealFrame);
    // The ring belongs to the finished chart, so it waits for the draw.
    if (pulseNode) pulseNode.classList.add('is-drawing');
    const target = Number(change()?.last) || 0;
    let started = 0;
    const step = (now) => {
      if (!started) started = now;
      const elapsed = now - started;
      const progress = historyDrawProgress(elapsed, HISTORY_DRAW_MS);
      revealRect.setAttribute('width', (CHART_W * progress).toFixed(2));
      setCounted(historyCountValue(target, progress));
      const tip = smoothHistoryPointAt(chart().curve, CHART_W * progress);
      if (endDotNode && tip) {
        endDotNode.style.left = pct(tip.x, CHART_W);
        endDotNode.style.top = pct(tip.y, CHART_H);
      }
      if (progress >= 1) {
        revealFrame = undefined;
        showWholeChart();
        return;
      }
      revealFrame = requestAnimationFrame(step);
    };
    revealFrame = requestAnimationFrame(step);
  }

  // Only a new range draws in. The same window with fresher numbers, a hover,
  // the liquidity sub-pane, a live today tick or a parent re-render keeps the
  // chart as it is.
  createEffect(
    () => [custom() ? 'custom' : presetId(), bounds().from, bounds().to, chart().hasLine],
    ([id, from, to, hasLine]) => {
      const key = `${id}|${from}|${to}`;
      if (!hasLine || key === playedRange) return;
      playedRange = key;
      drawIn();
    },
  );
  onCleanup(showWholeChart);

  function toggleBand() {
    const next = !band();
    setBand(next);
    writeShowLiquidity(next);
  }

  // Hover: the day under the pointer.
  const hovered = createMemo(() => {
    const at = hover();
    const line = timeline();
    const c = chart();
    const list = points();
    const fallback = { tip: null, dot: null, legendDay: list[list.length - 1] || null };
    if (!at || !line || !c.hasData) return fallback;
    const date = timelineDay(line, at.ratio);
    const day = historyDayAt(list, date);
    const tip = formatHistoryTip(day, currency());
    if (tip) tip.dateLabel = formatDayLabel(date);
    return { tip, dot: { x: c.xOf(date), y: c.yOf(day?.totalPkn) }, legendDay: day };
  });
  const legendDay = () => hovered().legendDay;
  const legendCards = () => legendDay()?.assets?.cardsValuePkn;
  const hoverLabel = () => {
    const tip = hovered().tip;
    return tip ? `${tip.dateLabel} · ${tip.totalLabel}` : '';
  };

  function onPointer(event) {
    if (!chart().hasData || !timeline()) {
      setHover(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    setHover({ ratio: Math.min(1, Math.max(0, ratio)) });
  }

  // Keep the floating label inside the plot: it is only measured once it is
  // in the frame, and the frame stretches, so the anchor is recomputed here.
  createEffect(() => hovered().dot, (dot) => {
    if (!frame || !labelNode || !dot) return;
    const box = frame.getBoundingClientRect();
    const plotWidth = Math.max(1, box.width - 2);
    const plotHeight = Math.max(1, box.height - 2);
    const anchor = historyLabelAnchor({
      x: (dot.x / CHART_W) * plotWidth,
      y: (dot.y / CHART_H) * plotHeight,
      plotWidth,
      plotHeight,
      labelWidth: labelNode.offsetWidth,
      labelHeight: labelNode.offsetHeight,
      gap: LABEL_GAP,
    });
    labelNode.style.left = `${anchor.left}px`;
    labelNode.style.top = `${anchor.top}px`;
  });

  function pickDates(nextFrom, nextTo) {
    if (!nextFrom || !nextTo) {
      setCustom(null);
      return;
    }
    setCustom({ from: nextFrom, to: nextTo });
  }

  const summary = () => {
    const list = points();
    return chart().hasData
      ? `Collection value from ${formatDayLabel(list[0].date)} to ${formatDayLabel(list[list.length - 1].date)}: `
        + `${formatHistoryAmount(list[0].totalPkn, currency())} to ${formatHistoryAmount(list[list.length - 1].totalPkn, currency())}`
      : 'Collection value history chart';
  };
  const pct = (value, of) => `${(value / of) * 100}%`;

  return (
    <div
      class="seller-history"
      data-testid="collection-history"
      data-history={chart().hasLine ? 'series' : (chart().hasPoint ? 'point' : 'empty')}
      data-range={custom() ? 'custom' : presetId()}
    >
      <div class="seller-history-head">
        <Show when={change()}>
          {(delta) => (
            <div class="seller-history-value">
              <strong>{formatHistoryAmount(counted() ?? delta().last, currency())}</strong>
              <span class={['seller-history-delta', delta().delta < 0 ? 'is-down' : 'is-up']}>{formatHistoryDelta(delta(), currency())}</span>
            </div>
          )}
        </Show>
        <Show when={presets().length}>
          <div class="seller-history-ranges">
            <div class="seller-history-presets" role="group" aria-label="History period">
              <For each={presets()}>
                {(row) => (
                  <button
                    type="button"
                    aria-pressed={String(!custom() && presetId() === row.id)}
                    onClick={() => {
                      setPreset(row.id);
                      setCustom(null);
                    }}
                  >
                    {row.label}
                  </button>
                )}
              </For>
            </div>
            <button
              type="button"
              class="seller-history-liquidity-toggle"
              aria-pressed={String(band())}
              onClick={toggleBand}
            >
              Show liquidity
            </button>
            <div class="seller-history-dates">
              <input
                type="date"
                aria-label="From"
                value={bounds().from || points()[0]?.date || ''}
                max={bounds().to || undefined}
                onChange={(event) => pickDates(event.target.value, bounds().to)}
              />
              <span aria-hidden="true">–</span>
              <input
                type="date"
                aria-label="To"
                value={bounds().to || ''}
                min={bounds().from || undefined}
                onChange={(event) => pickDates(bounds().from || points()[0]?.date || '', event.target.value)}
              />
            </div>
          </div>
        </Show>
        <Show when={chart().hasData}>
          <ul class="seller-history-legend" aria-label="Chart layers">
            <li class="is-cards">
              <span class="seller-history-key" aria-hidden="true" />
              <span>Cards</span>
              <strong>{legendCards() != null ? formatHistoryAmount(legendCards(), currency()) : '—'}</strong>
              <Show when={legendDay()?.assets?.cardsHeld}>
                <em>
                  {legendDay().assets.cardsPriced.toLocaleString('en-US')} of {legendDay().assets.cardsHeld.toLocaleString('en-US')} with a sale
                </em>
              </Show>
            </li>
            <li class="is-liquidity">
              <span class="seller-history-key" aria-hidden="true" />
              <span>Liquidity</span>
              <strong>{formatHistoryAmount(legendDay()?.assets?.currencyPkn || 0, currency())}</strong>
            </li>
          </ul>
        </Show>
      </div>
      <div class="seller-history-chart">
        <div
          ref={(el) => { frame = el; }}
          class="seller-history-frame"
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={summary()}
        >
          <svg
            class={['seller-history-grid', { 'is-empty': !chart().hasData }]}
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              {/* The draw-in reveal. It rests at the full plot width, so only a
                  running animation hides the series. */}
              <clipPath id={REVEAL_CLIP}>
                <rect ref={(el) => { revealRect = el; }} x="0" y="0" height={CHART_H} width={CHART_W} />
              </clipPath>
            </defs>
            <line class="seller-history-baseline" x1="0" x2={CHART_W} y1={chart().baseY} y2={chart().baseY} />
            <Show when={chart().liquidityLine}>
              {(path) => <path class="seller-history-liquidity" d={path()} />}
            </Show>
            <g clip-path={`url(#${REVEAL_CLIP})`}>
              <Show when={chart().hasLine}><path class="seller-history-step" d={chart().stepLine} /></Show>
              <Show when={chart().hasLine}><path class="seller-history-line" d={chart().totalLine} /></Show>
            </g>
            <Show when={chart().live}>
              <line class="seller-history-today" x1={TODAY_X} x2={TODAY_X} y1="0" y2={CHART_H} />
            </Show>
            <Show when={hovered().dot}>
              {(dot) => <line class="seller-history-crosshair" x1={dot().x} x2={dot().x} y1="0" y2={CHART_H} />}
            </Show>
          </svg>
          <Show when={!chart().hasData && !props.pending}>
            <div class="seller-history-empty">
              <p class="seller-history-title">Collection history will appear here</p>
              <p class="seller-history-lede">Scan cards to start building your portfolio.</p>
            </div>
          </Show>
        </div>
        {/* Dots and the floating label sit over the frame without its clipping.
            CSS circles, because an SVG circle stretches under
            preserveAspectRatio=none. */}
        <div class="seller-history-overlay" aria-hidden="true">
          {/* One dot only: it is the head of the draw-in and then the last day,
              and the cursor dot replaces it while a hover is active, so a
              hover in the middle of a draw cannot flash it back. */}
          <Show when={chart().endDot}>
            {(dot) => (
              <span
                ref={(el) => { endDotNode = el; }}
                class="seller-history-point"
                data-testid="collection-history-point"
                style={{
                  left: pct(dot().x, CHART_W),
                  top: pct(dot().y, CHART_H),
                  display: hovered().dot ? 'none' : '',
                }}
              >
                <Show when={chart().hasLine}>
                  <span ref={(el) => { pulseNode = el; }} class="seller-history-pulse" />
                </Show>
              </span>
            )}
          </Show>
          <Show when={hovered().dot}>
            {(dot) => (
              <span class="seller-history-point is-hover" style={{ left: pct(dot().x, CHART_W), top: pct(dot().y, CHART_H) }} />
            )}
          </Show>
          <Show when={hovered().tip}>
            <div
              ref={(el) => { labelNode = el; }}
              class="seller-history-tip collection-history-tip"
              data-testid="collection-history-tip"
              style={{
                left: pct(hovered().dot.x, CHART_W),
                top: `calc(${pct(hovered().dot.y, CHART_H)} - ${LABEL_GAP}px)`,
              }}
            >
              {hoverLabel()}
            </div>
          </Show>
          <Show when={chart().liquidityLine}>
            <span class="seller-history-liquidity-label">
              {`Liquidity, own scale (peak ${formatHistoryAmount(chart().liquidityPeak, currency())})`}
            </span>
          </Show>
        </div>
        <div class="seller-history-x" aria-hidden="true">
          <For each={chart().ticks}>
            {(tick) => <span class={tick.minor ? 'is-minor' : undefined} style={{ left: `${tick.ratio * 100}%` }}>{tick.label}</span>}
          </For>
          <Show when={chart().hasData && chart().live}>
            <span class="is-today">Today</span>
          </Show>
          <Show when={chart().hasData && !chart().live}>
            <span class="is-end">{formatDayLabel(points()[points().length - 1].date)}</span>
          </Show>
        </div>
      </div>
      <Show when={chart().hasData}>
        <table class="sr-only">
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
            <For each={points().filter((day) => !day.carried)}>
              {(day) => (
                <tr>
                  <th scope="row">{day.date}</th>
                  <td>{day.assets.cardsValuePkn != null ? formatHistoryAmount(day.assets.cardsValuePkn, currency()) : '—'}</td>
                  <td>{formatHistoryAmount(day.assets.currencyPkn, currency())}</td>
                  <td>{formatHistoryAmount(day.totalPkn, currency())}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
}
