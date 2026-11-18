import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import { formatPknNumber } from '@market/pkn.js';
import { formatAssetsValue } from '@market/seller-currency.js';
import {
  ALL_LEVEL,
  collectionSeries,
  defaultSegmentLevel,
  formatSegmentChange,
  indexedSeries,
  segmentGroups,
  segmentLevels,
  segmentWindow,
  smoothPath,
  sparkEndPoint,
  sparkPoints,
  versusPaths,
} from '@market/portfolio-segments.js';
import '@market/seller-segments.css';

/** Desktop sparkline box; the phone box is the same height at 72 px. */
const SPARK = { width: 110, height: 26, pad: 2 };
const SPARK_PHONE = { width: 72, height: 26, pad: 2 };
const PHONE_MAX_WIDTH = 520;
/** The opened versus chart: about 150 px of plot, padded so nothing clips. */
const CHART_H = 150;
const CHART_PAD = 10;
const CHART_FALLBACK_W = 320;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-11-03` → `Nov 3`. Only day keys ever reach this desk. */
function dayLabel(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!m) return '';
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

/** A PKN valuation in the seller's display currency, like the movers tiles. */
function amount(pkn, code) {
  const value = Number(pkn) || 0;
  return code === 'PKN' ? `${formatPknNumber(value)} PKN` : formatAssetsValue(value, code);
}

function cards(count) {
  return Math.max(0, Math.trunc(Number(count) || 0)).toLocaleString('en-US');
}

function tone(pct) {
  const value = Number(pct);
  if (!Number.isFinite(value) || value === 0) return 'is-flat';
  return value > 0 ? 'is-up' : 'is-down';
}

/** The last percent a curve was drawn at: the change the legend states. */
function lastPercent(list) {
  for (let i = (list?.length || 0) - 1; i >= 0; i -= 1) {
    if (list[i] != null) return list[i];
  }
  return null;
}

function Label(props) {
  return (
    <span class="segment-label">
      <span class="segment-name">{props.row.label}</span>
      <Show when={props.row.sub}><em class="segment-sub">{props.row.sub}</em></Show>
    </span>
  );
}

function Chevron() {
  return (
    <svg class="segment-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M2.5 4.5 6 8 9.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function SegmentSpark(props) {
  const points = createMemo(() => sparkPoints(
    (props.row.series || []).map((point) => point.valuePkn),
    props.size.width,
    props.size.height,
    props.size.pad,
  ));
  const line = createMemo(() => smoothPath(points()));
  const dot = createMemo(() => sparkEndPoint(points()));
  return (
    <span class="segment-spark" aria-hidden="true">
      <svg width={props.size.width} height={props.size.height} viewBox={`0 0 ${props.size.width} ${props.size.height}`}>
        <Show when={line()}>
          <path class="segment-spark-line" d={line()} fill="none" />
        </Show>
        <Show when={dot()}>
          {(end) => <circle class="segment-spark-dot" cx={end().x} cy={end().y} r="2" />}
        </Show>
      </svg>
    </span>
  );
}

/** A row nothing can be plotted for: held stock with no sale, or none at all. */
function PlainRow(props) {
  const empty = () => props.row.state === 'empty';
  return (
    <div class={['segment-row', 'is-plain', { 'is-empty': empty() }]} data-testid={`segment-row-${props.row.key}`}>
      <Label row={props.row} />
      <span class="segment-cards">{empty() ? '0' : cards(props.row.held)}</span>
      <span class="segment-note">{empty() ? 'None held' : 'No price data yet'}</span>
      <span class="segment-change" />
      <span class="segment-spark" aria-hidden="true" />
    </div>
  );
}

/**
 * One segment against the whole of it: both series as percent change on one
 * shared scale, so the pair answers "is this piece moving better than my book".
 */
function VersusChart(props) {
  const paths = createMemo(() => versusPaths(props.segmentPct, props.collectionPct, props.width, CHART_H, CHART_PAD));
  return (
    <div class="segment-chart-svg" data-testid="segment-chart">
      <svg width={props.width} height={CHART_H} viewBox={`0 0 ${props.width} ${CHART_H}`} aria-hidden="true">
        <line class="segment-zero-line" x1={CHART_PAD} x2={Math.max(CHART_PAD, props.width - CHART_PAD)} y1={paths().zeroY} y2={paths().zeroY} />
        <text class="segment-zero-label" x={2} y={paths().zeroY - 4}>0%</text>
        <Show when={paths().collection}>
          <path class="segment-collection-line" d={paths().collection} fill="none" />
        </Show>
        <Show when={paths().segment}>
          <path class="segment-series-line" d={paths().segment} fill="none" pathLength={1} />
        </Show>
        <Show when={paths().last}>
          {(last) => (
            <>
              <circle class="segment-end-ring" cx={last().x} cy={last().y} r="6" />
              <circle class="segment-end-dot" cx={last().x} cy={last().y} r="2.5" />
            </>
          )}
        </Show>
      </svg>
      <p class="segment-chart-days">
        <span>{dayLabel(props.first)}</span>
        <span>{dayLabel(props.last)}</span>
      </p>
    </div>
  );
}

/**
 * The collection as segments under the value graph: one row per segment with a
 * sparkline, opening into a chart that compares it with the whole collection.
 * Rows come from the portfolio-history answer (DG-R001 adds the per-day
 * `segments` split); the window is the range the main graph is showing.
 */
export default function SegmentTable(props) {
  const model = () => props.model || null;
  const currency = () => String(props.currency || 'PKN').trim().toUpperCase() || 'PKN';
  // An amount is a price, so the rows wait for the display currency rather
  // than painting PKN first and swapping to DKK.
  const skeleton = () => model() == null || Boolean(props.currencyPending);
  // A table with no split and no request for one has nothing to say: not even
  // three skeleton rows that flash and vanish.
  const visible = () => model() != null || Boolean(props.pending);
  const painting = () => model() != null && !skeleton();
  const levels = createMemo(() => segmentLevels(model()));
  const windowRange = createMemo(() => segmentWindow(model(), props.range));

  const [picked, setPicked] = createSignal('');
  const [open, setOpen] = createSignal('');
  const defaultLevel = () => defaultSegmentLevel(model());
  const levelId = () => (levels().some((level) => level.id === picked()) ? picked() : defaultLevel());
  const levelName = () => levels().find((level) => level.id === levelId())?.label || 'All games';

  const groups = createMemo(() => segmentGroups(model(), levelId(), windowRange()));
  const rows = createMemo(() => groups().flatMap((group) => group.rows));
  // Only a row that is on this level and can be plotted holds a chart open:
  // one that leaves the level or loses its prices closes with it, so an open
  // chart never outlives the button that would close it.
  const openRow = createMemo(() => rows().find((row) => row.key === open() && row.state === 'ok') || null);
  const isOpen = (key) => openRow()?.key === key;

  function chooseLevel(id) {
    setPicked(id);
    setOpen('');
  }

  // The compare series: the whole collection on the `all` level, that game's
  // own total on a game level, and the collection again when the row is absent.
  const compareSeries = createMemo(() => {
    const level = levelId();
    const win = windowRange();
    if (level !== ALL_LEVEL) {
      const def = (model()?.defs || []).find((row) => row.group === 'game' && row.game === level);
      if (def) {
        return (model()?.days || [])
          .filter((day) => (!win.from || day.date >= win.from) && (!win.to || day.date <= win.to))
          .map((day) => ({ date: day.date, valuePkn: day.segments?.[def.key]?.valuePkn ?? 0 }));
      }
    }
    return collectionSeries(model(), win);
  });

  const chart = createMemo(() => {
    const row = openRow();
    if (!row) return null;
    const segmentPct = indexedSeries(row.series);
    const collectionPct = indexedSeries(compareSeries());
    return {
      segmentPct,
      collectionPct,
      segmentChange: lastPercent(segmentPct),
      collectionChange: lastPercent(collectionPct),
      first: row.series?.[0]?.date || '',
      last: row.series?.[row.series.length - 1]?.date || '',
    };
  });

  // Both charts are drawn in device pixels, so an end dot never stretches into
  // an ellipse: the widths come from the measured boxes. The disconnect is the
  // effect's own return value — an effect body has no owner here, so an
  // `onCleanup` registered inside it would land nowhere and leak the observer.
  let box;
  const [sparkSize, setSparkSize] = createSignal(SPARK);
  // Past four names the pill row no longer fits the tile beside each other, and
  // on a phone past two: the switch then scrolls sideways inside itself instead
  // of wrapping into lines or widening the table. The width the sparkline is
  // measured at is the width the switch has, so one reading decides both.
  const manyLevels = createMemo(() => levels().length > (sparkSize() === SPARK_PHONE ? 2 : 4));
  let levelsBox;
  // A scrolling switch can hide the very level it is painting, so the active
  // pill is brought back — but only when it is really out of view, because a
  // click on a half-visible pill must not shove the row around. The two boxes
  // are compared where they paint rather than by their offset within the page,
  // since the pill row is not a positioned box, and only the switch's own
  // scroll is touched: the page never moves. A pill reached by Tab scrolls
  // itself in in any engine anyway.
  createEffect(() => (manyLevels() ? levelId() : ''), (active) => {
    const node = levelsBox;
    if (!active || !node) return;
    const button = node.querySelector('[aria-pressed="true"]');
    if (!button) return;
    const boxRect = node.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    if (rect.left < boxRect.left) node.scrollLeft -= boxRect.left - rect.left;
    else if (rect.right > boxRect.right) node.scrollLeft += rect.right - boxRect.right;
  });

  // The section only exists once there is something to draw, so the observer
  // is attached when the gate opens rather than once at mount.
  createEffect(() => (visible() ? 1 : 0), (mounted) => {
    const node = mounted ? box : null;
    if (!node || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width;
      if (width > 0) setSparkSize(width <= PHONE_MAX_WIDTH ? SPARK_PHONE : SPARK);
    });
    observer.observe(node);
    return () => observer.disconnect();
  });

  let chartBox;
  const [chartWidth, setChartWidth] = createSignal(CHART_FALLBACK_W);
  // Keyed on the row that is actually open, so a chart that closes because its
  // row left the level or lost its prices disconnects its observer too.
  createEffect(() => openRow()?.key || '', (key) => {
    const node = key ? chartBox : null;
    if (!node || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width;
      if (width > 0) setChartWidth(Math.round(width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  });

  return (
    <Show when={visible()}>
      <section
        class="segment-table"
        data-testid="segment-table"
        aria-label="Collection segments"
        ref={box}
      >
        <Show when={skeleton()}>
          <div class="segment-rows is-loading" aria-hidden="true">
            <For each={Array.from({ length: 3 })}>
              {() => (
                <div class="segment-row is-skeleton">
                  <span class="skeleton-line" />
                  <span class="skeleton-line short" />
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={painting()}>
          <Show when={levels().length > 1}>
            <div
              class="segment-levels seller-history-presets"
              classList={{ 'is-many': manyLevels() }}
              role="group"
              aria-label="Collection level"
              ref={levelsBox}
            >
              <For each={levels()}>
                {(level) => (
                  <button
                    type="button"
                    data-testid={`segment-level-${level.id}`}
                    aria-pressed={String(level.id === levelId())}
                    onClick={() => chooseLevel(level.id)}
                  >
                    {level.label}
                  </button>
                )}
              </For>
            </div>
          </Show>

          <div class="segment-head" aria-hidden="true">
            <span>Segment</span>
            <span class="segment-col-cards">Cards</span>
            <span class="segment-col-value">Value</span>
            <span class="segment-col-change">Change</span>
            <span class="segment-head-spark" />
          </div>

          <For each={groups()} keyed={(group) => group.title}>
            {(group) => (
              <div class="segment-group">
                <Show when={groups().length > 1}>
                  <h4 class="segment-group-title">{group().title}</h4>
                </Show>
                <div class="segment-rows">
                  <For each={group().rows} keyed={(row) => row.key}>
                    {(row) => (
                      <>
                        <Switch fallback={<PlainRow row={row()} />}>
                          <Match when={row().state === 'ok'}>
                            <button
                              type="button"
                              class={['segment-row', { 'is-open': isOpen(row().key) }]}
                              data-testid={`segment-row-${row().key}`}
                              aria-expanded={String(isOpen(row().key))}
                              aria-controls={isOpen(row().key) ? `segment-chart-${row().key}` : undefined}
                              onClick={() => setOpen((current) => (current === row().key ? '' : row().key))}
                            >
                              <Label row={row()} />
                              <span class="segment-cards">{cards(row().held)}</span>
                              <span class="segment-value">{amount(row().valuePkn, currency())}</span>
                              <span class={['segment-change', 'mover-tile-change', tone(row().changePct)]}>{formatSegmentChange(row().changePct)}</span>
                              <SegmentSpark row={row()} size={sparkSize()} />
                              <Chevron />
                            </button>
                          </Match>
                        </Switch>
                        <Show when={isOpen(row().key) && chart()}>
                          <div class="segment-open" id={`segment-chart-${row().key}`} ref={chartBox}>
                            <p class="segment-legend">
                              <span class="segment-key is-segment" />
                              {row().label}
                              <strong class={['mover-tile-change', tone(chart().segmentChange)]}>{formatSegmentChange(chart().segmentChange)}</strong>
                              <span class="segment-key is-collection" />
                              {levelName()}
                              <strong class={['mover-tile-change', tone(chart().collectionChange)]}>{formatSegmentChange(chart().collectionChange)}</strong>
                            </p>
                            <VersusChart
                              width={chartWidth()}
                              segmentPct={chart().segmentPct}
                              collectionPct={chart().collectionPct}
                              first={chart().first}
                              last={chart().last}
                            />
                          </div>
                        </Show>
                      </>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </Show>
      </section>
    </Show>
  );
}
