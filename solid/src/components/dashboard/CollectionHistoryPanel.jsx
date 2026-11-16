import { createEffect, createMemo, createSignal, For, Show, untrack } from 'solid-js';
import { formatPknNumber } from '@market/pkn.js';
import { moverDaysForPreset } from '@market/portfolio-movers.js';
import {
  DEFAULT_HISTORY_PRESET,
  availableHistoryPresets,
  daySpan,
  formatDayLabel,
  formatHistoryDelta,
  formatHistoryTip,
  historyAxis,
  historyDateTicks,
  historyDayAt,
  historyPresetWindow,
  historyTimeline,
  historyWindowChange,
  HISTORY_PRESETS,
  sliceHistorySeries,
  smoothHistoryBandPath,
  smoothHistoryPath,
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

/** Everything the chart draws for one window (React rendered this inline). */
function layoutChart(points, timeline) {
  const axis = historyAxis(points.map((day) => day.totalPkn));
  const xOf = (date) => timelineRatio(timeline, date) * CHART_W;
  const yOf = (value) => {
    const span = Math.max(1e-9, axis.yMax - axis.yMin);
    const clamped = Math.min(axis.yMax, Math.max(axis.yMin, Number(value) || 0));
    const t = (clamped - axis.yMin) / span;
    return CHART_H - PLOT_BOTTOM - t * (CHART_H - PLOT_TOP - PLOT_BOTTOM);
  };
  const hasLine = points.length >= 2;
  const hasData = points.length > 0;
  const baseY = CHART_H - PLOT_BOTTOM;
  const out = {
    axis, xOf, yOf, hasLine, hasData,
    hasPoint: points.length === 1,
    totalLine: '', cardsArea: '', liquidityArea: '', endDot: null,
    ticks: historyDateTicks(timeline),
    live: Boolean(timeline?.live),
  };
  if (hasData) {
    const coords = points.map((day) => ({ x: xOf(day.date), day }));
    const totalTop = coords.map((c) => ({ x: c.x, y: yOf(c.day.totalPkn) }));
    const liquidityTop = coords.map((c) => ({ x: c.x, y: yOf(c.day.assets.currencyPkn) }));
    if (hasLine) {
      // The areas share their edges with the line and with each other, so the
      // stack reads as one pile rather than three separately stepped shapes.
      out.totalLine = smoothHistoryPath(totalTop);
      out.cardsArea = smoothHistoryBandPath(totalTop, liquidityTop);
      out.liquidityArea = smoothHistoryBandPath(
        liquidityTop,
        liquidityTop.map((c) => ({ x: c.x, y: baseY })),
      );
    }
    const last = coords[coords.length - 1];
    out.endDot = { x: last.x, y: yOf(last.day.totalPkn) };
  }
  out.widestTick = axis.ticks.reduce((wide, tick) => {
    const text = formatPknNumber(tick);
    return text.length > wide.length ? text : wide;
  }, '0');
  return out;
}

/**
 * Collection value chart (was in the React SellerDashboardView,
 * CollectionHistoryPanel): cards stacked on liquidity (wallet PKN), one point
 * per day across the whole plot; a window that ends today stops at the Today
 * mark. Opens on the last month.
 */
export default function CollectionHistoryPanel(props) {
  const [hover, setHover] = createSignal(null);
  const [preset, setPreset] = createSignal(DEFAULT_HISTORY_PRESET);
  const [custom, setCustom] = createSignal(null);
  let frame;
  let tipNode;
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
  const chart = createMemo(() => layoutChart(points(), timeline()));
  const change = () => historyWindowChange(points(), custom() ? 'custom' : presetId());

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
        if (props.onRange) props.onRange({ id, days, label });
      });
    },
  );

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
    const tip = formatHistoryTip(day);
    if (tip) tip.dateLabel = formatDayLabel(date);
    return { tip, dot: { x: c.xOf(date), y: c.yOf(day?.totalPkn) }, legendDay: day };
  });
  const tipLeftPct = () => (hovered().dot ? (hovered().dot.x / CHART_W) * 100 : 50);
  // The tip sits beside the crosshair so it never covers the point it describes.
  const tipOnRight = () => tipLeftPct() < 55;
  const legendDay = () => hovered().legendDay;
  const legendCards = () => legendDay()?.assets?.cardsValuePkn;

  function onPointer(event) {
    if (!chart().hasData || !timeline()) {
      setHover(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    setHover({ ratio: Math.min(1, Math.max(0, ratio)) });
  }

  // Keep the tip inside the plot on a narrow screen.
  createEffect(hovered, () => {
    if (!frame || !tipNode) return;
    tipNode.style.transform = '';
    const frameBox = frame.getBoundingClientRect();
    const tipBox = tipNode.getBoundingClientRect();
    const pad = 6;
    let nudge = 0;
    if (tipBox.left < frameBox.left + pad) nudge = (frameBox.left + pad) - tipBox.left;
    else if (tipBox.right > frameBox.right - pad) nudge = (frameBox.right - pad) - tipBox.right;
    if (nudge) tipNode.style.transform = `translateX(${nudge}px)`;
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
        + `${formatPknNumber(list[0].totalPkn)} PKN to ${formatPknNumber(list[list.length - 1].totalPkn)} PKN`
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
              <strong>{formatPknNumber(delta().last)} PKN</strong>
              <span class={['seller-history-delta', delta().delta < 0 ? 'is-down' : 'is-up']}>{formatHistoryDelta(delta())}</span>
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
              <strong>{legendCards() != null ? `${formatPknNumber(legendCards())} PKN` : '—'}</strong>
              <Show when={legendDay()?.assets?.cardsHeld}>
                <em>
                  {legendDay().assets.cardsPriced.toLocaleString('en-US')} of {legendDay().assets.cardsHeld.toLocaleString('en-US')} with a sale
                </em>
              </Show>
            </li>
            <li class="is-liquidity">
              <span class="seller-history-key" aria-hidden="true" />
              <span>Liquidity</span>
              <strong>{formatPknNumber(legendDay()?.assets?.currencyPkn || 0)} PKN</strong>
            </li>
          </ul>
        </Show>
      </div>
      <div class="seller-history-chart">
        <div class="seller-history-y" aria-hidden="true">
          <span class="seller-history-y-sizer">{chart().widestTick}</span>
          <div class="seller-history-y-ticks">
            <For each={chart().axis.ticks}>
              {(tick) => <span style={{ top: pct(chart().yOf(tick), CHART_H) }}>{formatPknNumber(tick)}</span>}
            </For>
          </div>
        </div>
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
              <linearGradient id="collection-history-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#ffd33d" stop-opacity="0.24" />
                <stop offset="100%" stop-color="#ffd33d" stop-opacity="0.03" />
              </linearGradient>
            </defs>
            <For each={chart().axis.ticks}>
              {(tick) => <line class="seller-history-rule" x1="0" x2={CHART_W} y1={chart().yOf(tick)} y2={chart().yOf(tick)} />}
            </For>
            <Show when={chart().hasLine}>
              <path class="seller-history-liquidity" d={chart().liquidityArea} />
              <path class="seller-history-fill" d={chart().cardsArea} />
            </Show>
            <Show when={chart().live}>
              <line class="seller-history-today" x1={TODAY_X} x2={TODAY_X} y1="0" y2={CHART_H} />
            </Show>
            <Show when={chart().hasLine}><path class="seller-history-line" d={chart().totalLine} /></Show>
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
        {/* Dots and the tip sit over the frame without its clipping. CSS
            circles, because an SVG circle stretches under preserveAspectRatio=none. */}
        <div class="seller-history-overlay" aria-hidden="true">
          <Show when={chart().endDot}>
            {(dot) => (
              <span class="seller-history-point" data-testid="collection-history-point" style={{ left: pct(dot().x, CHART_W), top: pct(dot().y, CHART_H) }} />
            )}
          </Show>
          <Show when={hovered().dot}>
            {(dot) => (
              <span class="seller-history-point is-hover" style={{ left: pct(dot().x, CHART_W), top: pct(dot().y, CHART_H) }} />
            )}
          </Show>
          <Show when={hovered().tip}>
            {(tip) => (
              <div
                ref={(el) => { tipNode = el; }}
                class="seller-history-tip"
                data-testid="collection-history-tip"
                style={tipOnRight() ? { left: `calc(${tipLeftPct()}% + 14px)` } : { right: `calc(${100 - tipLeftPct()}% + 14px)` }}
              >
                <p class="seller-history-tip-day">{tip().dateLabel}</p>
                <p class="seller-history-tip-total">{tip().totalLabel}</p>
                <Show when={tip().rows.length}>
                  <ul>
                    <For each={tip().rows}>
                      {(row) => (
                        <li class={`is-${row.key}`}>
                          <span>{row.label}</span>
                          <strong>{row.value}</strong>
                          <Show when={row.note}><em>{row.note}</em></Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={tip().footnote}><p class="seller-history-tip-note">{tip().footnote}</p></Show>
              </div>
            )}
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
                  <td>{day.assets.cardsValuePkn != null ? `${formatPknNumber(day.assets.cardsValuePkn)} PKN` : '—'}</td>
                  <td>{formatPknNumber(day.assets.currencyPkn)} PKN</td>
                  <td>{formatPknNumber(day.totalPkn)} PKN</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
}
