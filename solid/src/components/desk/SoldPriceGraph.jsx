import { createMemo, createSignal, For, onSettled, Show } from 'solid-js';
import { formatPkn } from '@market/api.js';
import {
  activeSoldIndex,
  formatSoldAxisTick,
  formatSoldDay,
  formatSoldSampleCount,
  isSoldGraphClick,
  nearestSoldIndex,
  SOLD_GRAPH_PAD,
  soldConditionLabel,
  soldDateLocale,
  soldFilterShowsAll,
  soldFilterValue,
  soldGraphScale,
  soldGraphTipMods,
  soldGraphTone,
  soldGraphY,
  soldLanguageLabel,
  soldUnitCount,
} from '@market/sold-graph.js';

function stopSoldPointer(event) {
  event.stopPropagation();
}

function SoldGraphFilter(props) {
  const encode = (opt) => (props.encode ? props.encode(opt) : opt);
  const label = (opt) => (props.optionLabel ? props.optionLabel(opt) : opt);
  const showAll = () => soldFilterShowsAll(props.options);
  const value = () => soldFilterValue(props.options, props.value, encode);
  return (
    <Show when={props.options.length}>
      <select
        aria-label={props.label}
        class={showAll() ? undefined : 'is-solo'}
        value={value()}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        <Show when={showAll()}><option value="" selected={value() === ''}>{props.allLabel}</option></Show>
        <For each={props.options}>
          {(opt) => <option value={encode(opt)} selected={encode(opt) === value()}>{label(opt)}</option>}
        </For>
      </select>
    </Show>
  );
}

function SoldGraphToggle(props) {
  return (
    <button
      type="button"
      class={props.pressed ? 'on' : undefined}
      aria-pressed={props.pressed ? 'true' : 'false'}
      onClick={() => props.onToggle(!props.pressed)}
    >
      {props.label}
    </button>
  );
}

function SoldGraphFilters(props) {
  // A foil chip plots nothing when the printing never sold that variant, so it
  // only renders when the flagged variant exists in the sold slices.
  const any = () => props.conditions.length || props.languages.length
    || props.chips.reverse || props.chips.firstEdition || props.chips.graded;
  return (
    <Show when={any()}>
      <div
        class="sold-graph-filters"
        onPointerDown={stopSoldPointer}
        onPointerMove={stopSoldPointer}
        onPointerUp={stopSoldPointer}
      >
        <Show when={props.chips.reverse}>
          <SoldGraphToggle label="Reverse" pressed={props.reverse} onToggle={props.onReverse} />
        </Show>
        <Show when={props.chips.firstEdition}>
          <SoldGraphToggle label="1st Ed." pressed={props.firstEdition} onToggle={props.onFirstEdition} />
        </Show>
        <Show when={props.chips.graded}>
          <SoldGraphToggle label="Graded" pressed={props.graded} onToggle={props.onGraded} />
        </Show>
        <SoldGraphFilter
          label="Sold condition"
          allLabel="All conditions"
          options={props.conditions}
          value={props.condition}
          onChange={props.onCondition}
          optionLabel={soldConditionLabel}
        />
        <SoldGraphFilter
          label="Sold language"
          allLabel="All languages"
          options={props.languages}
          value={props.language}
          onChange={props.onLanguage}
          optionLabel={soldLanguageLabel}
        />
        <Show when={props.unitsLabel}><p class="sold-graph-units">{props.unitsLabel}</p></Show>
      </div>
    </Show>
  );
}

/**
 * Daily sold median (market/src/pages/Card.jsx SoldPriceGraph). One section
 * element across the empty, measuring and plotted states; the plot appears
 * once a ResizeObserver has measured it, like the React layout effect.
 */
export default function SoldPriceGraph(props) {
  let wrap;
  let touchPointerActive = false;
  let pointerStart = null;
  const [size, setSize] = createSignal(null);
  const [hover, setHover] = createSignal(null);
  const days = createMemo(() => (Array.isArray(props.series?.days) ? props.series.days : []));
  const unitsLabel = () => {
    const series = props.series;
    const count = Number(series?.soldQty) > 0
      ? Math.trunc(Number(series.soldQty))
      : (Number(series?.sampleCount) > 0 ? Math.trunc(Number(series.sampleCount)) : soldUnitCount(days()));
    return count > 0 ? formatSoldSampleCount(count) : '';
  };
  const conditions = () => (Array.isArray(props.filters?.conditions) ? props.filters.conditions : []);
  const languages = () => (Array.isArray(props.filters?.languages) ? props.filters.languages : []);
  const tone = () => soldGraphTone(soldFilterValue(conditions(), props.condition));

  const plot = createMemo(() => {
    const rows = days();
    const box = size();
    if (!rows.length || !box) return null;
    const width = box.w;
    const height = box.h;
    const pad = SOLD_GRAPH_PAD;
    const values = rows.map((row) => Number(row.medianPkn) || 0);
    const scale = soldGraphScale(Math.max(0, ...values));
    const start = Date.parse(`${rows[0].day}T00:00:00Z`);
    const end = Date.parse(`${rows[rows.length - 1].day}T00:00:00Z`);
    const range = Math.max(1, end - start);
    const plotW = width - pad.l - pad.r;
    const plotH = height - pad.t - pad.b;
    const dateLocale = soldDateLocale();
    const points = rows.map((row) => {
      const x = pad.l + (rows.length === 1 || range <= 1
        ? plotW / 2
        : ((Date.parse(`${row.day}T00:00:00Z`) - start) / range) * plotW);
      return [x, soldGraphY(row.medianPkn, scale.max, pad.t, plotH)];
    });
    const line = points.map(([x, y]) => `${x},${y}`).join(' ');
    return {
      width,
      height,
      pad,
      scale,
      plotW,
      plotH,
      dateLocale,
      points,
      line,
      area: `${pad.l},${pad.t + plotH} ${line} ${pad.l + plotW},${pad.t + plotH}`,
      firstLabel: formatSoldDay(rows[0].day, dateLocale),
      lastLabel: formatSoldDay(rows[rows.length - 1].day, dateLocale),
    };
  });

  const hoverIndex = () => activeSoldIndex(hover(), days().length);
  const active = () => (hoverIndex() == null ? null : days()[hoverIndex()]);
  const activePt = () => (hoverIndex() == null || !plot() ? null : plot().points[hoverIndex()]);
  const tipMods = () => (activePt() ? soldGraphTipMods(activePt()[0], activePt()[1], plot().width, plot().pad) : []);
  const price = () => {
    const row = active();
    if (!row) return '';
    return (props.formatPrice ? props.formatPrice(row.medianPkn) : formatPkn(row.medianPkn)) || '0 PKN';
  };

  onSettled(() => {
    if (!wrap) return undefined;
    const apply = (width, height) => {
      const w = Math.max(240, Math.round(width));
      const h = Math.max(120, Math.round(height));
      setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    // No clientWidth read here: it forced a layout of the whole new desk inside
    // the click task. The observer's first callback runs after layout, before paint.
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) apply(rect.width, rect.height);
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  });

  function indexAt(event) {
    const geo = plot();
    const rect = wrap?.getBoundingClientRect();
    if (!geo || !rect?.width) return null;
    const x = ((event.clientX - rect.left) / rect.width) * geo.width;
    return nearestSoldIndex(geo.points.map(([px]) => px), x);
  }

  function hoverFromPointer(event) {
    const index = indexAt(event);
    if (index != null) setHover(index);
  }

  function beginHover(event) {
    if (!plot()) return;
    pointerStart = { x: event.clientX, y: event.clientY };
    if (event.pointerType === 'touch') {
      touchPointerActive = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    hoverFromPointer(event);
  }

  function pickDayFromPointer(event) {
    if (!props.onPickDay || !isSoldGraphClick(pointerStart, event)) return;
    const index = indexAt(event);
    const day = index == null ? '' : days()[index]?.day;
    if (day) props.onPickDay(day);
  }

  function moveHover(event) {
    if (!plot()) return;
    if (event.pointerType === 'touch' && !touchPointerActive) return;
    hoverFromPointer(event);
  }

  function clearHover(event) {
    pointerStart = null;
    if (!event || event.pointerType === 'touch') touchPointerActive = false;
    setHover(null);
  }

  return (
    <section
      ref={(el) => { wrap = el; }}
      class={['panel sold-graph', `is-${tone()}`]}
      aria-label="Daily sold median"
      aria-busy={!days().length && props.series == null ? 'true' : undefined}
      onPointerMove={moveHover}
      onPointerDown={beginHover}
      onPointerUp={(event) => {
        if (!plot()) return;
        pickDayFromPointer(event);
        pointerStart = null;
        if (event.pointerType === 'touch') clearHover(event);
      }}
      onPointerLeave={clearHover}
      onPointerCancel={clearHover}
    >
      <SoldGraphFilters
        conditions={conditions()}
        languages={languages()}
        chips={props.chips || {}}
        condition={props.condition}
        language={props.language}
        reverse={props.reverse}
        firstEdition={props.firstEdition}
        graded={props.graded}
        unitsLabel={unitsLabel()}
        onCondition={(value) => props.onCondition(value)}
        onLanguage={(value) => props.onLanguage(value)}
        onReverse={(value) => props.onReverse(value)}
        onFirstEdition={(value) => props.onFirstEdition(value)}
        onGraded={(value) => props.onGraded(value)}
      />
      <Show when={!days().length && props.series != null}>
        <p class="sold-graph-empty">No sold-card analytics yet for this printing.</p>
      </Show>
      <Show when={plot()}>
        {(geo) => (
          <>
            <svg viewBox={`0 0 ${geo().width} ${geo().height}`} aria-hidden="true">
              <For each={geo().scale.ticks}>
                {(tick) => (
                  <g>
                    <line
                      x1={geo().pad.l}
                      x2={geo().pad.l + geo().plotW}
                      y1={soldGraphY(tick, geo().scale.max, geo().pad.t, geo().plotH)}
                      y2={soldGraphY(tick, geo().scale.max, geo().pad.t, geo().plotH)}
                      class="sold-graph-grid"
                    />
                    <text
                      x={geo().pad.l - 4}
                      y={soldGraphY(tick, geo().scale.max, geo().pad.t, geo().plotH) + 3}
                      text-anchor="end"
                      class="sold-graph-axis"
                    >
                      {formatSoldAxisTick(tick)}
                    </text>
                  </g>
                )}
              </For>
              <polygon points={geo().area} class="sold-graph-fill" />
              <polyline points={geo().line} class="sold-graph-line" />
              <Show when={activePt()}>
                <line
                  x1={activePt()?.[0]}
                  x2={activePt()?.[0]}
                  y1={geo().pad.t}
                  y2={geo().pad.t + geo().plotH}
                  class="sold-graph-guide"
                />
              </Show>
              <For each={geo().points} keyed={false}>
                {(point, index) => (
                  <circle
                    cx={point()[0]}
                    cy={point()[1]}
                    r={index === hoverIndex() ? 4.4 : (days().length === 1 ? 3.5 : 2.4)}
                    class={index === hoverIndex() ? 'sold-graph-dot is-active' : 'sold-graph-dot'}
                  />
                )}
              </For>
              <text x={geo().pad.l} y={geo().height - 7} class="sold-graph-axis">{geo().firstLabel}</text>
              <text x={geo().width - 8} y={geo().height - 7} text-anchor="end" class="sold-graph-axis">{geo().lastLabel}</text>
              <rect x="0" y="0" width={geo().width} height={geo().height} class="sold-graph-hit" />
            </svg>
            <Show when={activePt() && active()}>
              <div
                class={['sold-graph-tip', ...tipMods()]}
                style={{
                  left: `${((activePt()?.[0] || 0) / geo().width) * 100}%`,
                  top: `${((activePt()?.[1] || 0) / geo().height) * 100}%`,
                }}
                role="status"
              >
                <strong>{price()}</strong>
                <span>{formatSoldDay(active()?.day, geo().dateLocale)}</span>
                <Show when={Number(active()?.soldQty || active()?.sampleCount) > 0}>
                  <span>{formatSoldSampleCount(active()?.soldQty || active()?.sampleCount)}</span>
                </Show>
                <Show when={active()?.comments?.[0]}><em>{active()?.comments?.[0]}</em></Show>
              </div>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
