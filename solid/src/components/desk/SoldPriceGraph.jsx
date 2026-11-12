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
        class={['sold-graph-filters', { 'is-bare': props.bare }]}
        onPointerDown={stopSoldPointer}
        onPointerMove={stopSoldPointer}
        onPointerUp={stopSoldPointer}
      >
        {/* Linked to the desk chips: the chips right above already show what is
            plotted, so the scope is said to screen readers only and the graph has
            no condition, language or reverse control of its own. */}
        <Show when={props.linkedLabel}>
          <p class="sr-only">{props.linkedLabel}</p>
        </Show>
        <Show when={props.chips.reverse && !props.linkedLabel}>
          <SoldGraphToggle label={props.reverseLabel || 'Reverse'} pressed={props.reverse} onToggle={props.onReverse} />
        </Show>
        <Show when={props.chips.firstEdition}>
          <SoldGraphToggle label="1st Ed." pressed={props.firstEdition} onToggle={props.onFirstEdition} />
        </Show>
        <Show when={props.chips.graded}>
          <SoldGraphToggle label="Graded" pressed={props.graded} onToggle={props.onGraded} />
        </Show>
        <Show when={!props.linkedLabel}>
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
        </Show>
        <Show when={props.unitsLabel}><p class="sold-graph-units">{props.unitsLabel}</p></Show>
      </div>
    </Show>
  );
}

/**
 * Daily sold median. One section
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
  // Linked to the desk chips with no 1st Ed. / Graded toggle to show, nothing
  // sits above the plot: it starts at the top and the unit count moves to the foot.
  const bare = () => Boolean(props.linkedLabel) && !props.chips?.firstEdition && !props.chips?.graded;
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
  // props.overlays = [{ key, days, color, label, dashed }]: every other series
  // the visitor picked, drawn under the current one on the same scale and dates.
  // props.color paints the current series; props.onRemoveOverlay(key) takes one off.
  const overlays = () => (Array.isArray(props.overlays) ? props.overlays : []).filter((row) => Array.isArray(row?.days) && row.days.length);
  // The line colour drives its fill and its hover guide.
  const lineStyle = () => (props.color
    ? {
      '--sold-line': props.color,
      '--sold-fill': `color-mix(in srgb, ${props.color} 16%, transparent)`,
      '--sold-guide': `color-mix(in srgb, ${props.color} 45%, transparent)`,
    }
    : undefined);

  const plot = createMemo(() => {
    const rows = days();
    const box = size();
    if (!rows.length || !box) return null;
    const width = box.w;
    const height = box.h;
    // The default top padding clears a row of menus. Linked to the desk chips
    // there is only one small caption line, so the plot starts right under it.
    // A comparison adds a legend line above the plot, so it needs the room.
    const others = overlays();
    const pad = bare()
      ? { ...SOLD_GRAPH_PAD, t: others.length ? 30 : 12 }
      : (props.linkedLabel ? { ...SOLD_GRAPH_PAD, t: 36 } : SOLD_GRAPH_PAD);
    // The axis is drawn in the unit the tooltip already uses: `axisFactor` units
    // of the visitor's currency per PKN (1, or absent, keeps a PKN axis).
    const factor = Number(props.axisFactor) > 0 ? Number(props.axisFactor) : 1;
    // Every series shares one scale and one date range, so the lines can be
    // read against each other.
    const every = [...rows, ...others.flatMap((row) => row.days)];
    const dayMs = (row) => Date.parse(`${row.day}T00:00:00Z`);
    const values = every.map((row) => (Number(row.medianPkn) || 0) * factor);
    const scale = soldGraphScale(Math.max(0, ...values), { minStep: factor === 1 ? 10 : 0.01 });
    const start = Math.min(...every.map(dayMs));
    const end = Math.max(...every.map(dayMs));
    const range = Math.max(1, end - start);
    const plotW = width - pad.l - pad.r;
    const plotH = height - pad.t - pad.b;
    const dateLocale = soldDateLocale();
    const single = every.length === 1 || range <= 1;
    const place = (row) => [
      pad.l + (single ? plotW / 2 : ((dayMs(row) - start) / range) * plotW),
      soldGraphY((Number(row.medianPkn) || 0) * factor, scale.max, pad.t, plotH),
    ];
    const join = (pts) => pts.map(([x, y]) => `${x},${y}`).join(' ');
    // A series only has a point on a day it sold. Between two sales the line
    // runs straight; before its first sale and after its last one the price is
    // carried flat to the edge of the range (dashed, because it is not a sale),
    // so no line starts or stops in the middle of the chart.
    const carry = (pts) => {
      if (!pts.length || single) return { lead: '', tail: '' };
      const first = pts[0];
      const last = pts[pts.length - 1];
      return {
        lead: first[0] > pad.l + 0.5 ? join([[pad.l, first[1]], first]) : '',
        tail: last[0] < pad.l + plotW - 0.5 ? join([last, [pad.l + plotW, last[1]]]) : '',
      };
    };
    const points = rows.map(place);
    const line = join(points);
    const ends = carry(points);
    const firstDay = every.reduce((a, b) => (dayMs(a) <= dayMs(b) ? a : b));
    const lastDay = every.reduce((a, b) => (dayMs(a) >= dayMs(b) ? a : b));
    const left = ends.lead ? pad.l : points[0][0];
    const right = ends.tail ? pad.l + plotW : points[points.length - 1][0];
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
      lead: ends.lead,
      tail: ends.tail,
      others: others.map((row) => {
        const pts = row.days.map(place);
        return { key: row.key, color: row.color, dashed: Boolean(row.dashed), line: join(pts), ...carry(pts), solo: pts.length === 1 ? pts[0] : null };
      }),
      // The fill follows the line across the whole range it is drawn for.
      area: `${left},${pad.t + plotH} ${ends.lead ? `${pad.l},${points[0][1]} ` : ''}${line}${ends.tail ? ` ${pad.l + plotW},${points[points.length - 1][1]}` : ''} ${right},${pad.t + plotH}`,
      firstLabel: formatSoldDay(firstDay.day, dateLocale),
      lastLabel: formatSoldDay(lastDay.day, dateLocale),
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
      class={['panel sold-graph', `is-${tone()}`, { 'is-dashed-line': props.dashed }]}
      style={lineStyle()}
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
        reverseLabel={props.reverseLabel}
        firstEdition={props.firstEdition}
        graded={props.graded}
        unitsLabel={props.hideUnits ? '' : unitsLabel()}
        linkedLabel={props.linkedLabel}
        bare={bare()}
        onCondition={(value) => props.onCondition(value)}
        onLanguage={(value) => props.onLanguage(value)}
        onReverse={(value) => props.onReverse(value)}
        onFirstEdition={(value) => props.onFirstEdition(value)}
        onGraded={(value) => props.onGraded(value)}
      />
      <Show when={!days().length && props.series != null}>
        <p class="sold-graph-empty">{props.emptyLabel || 'No sold-card analytics yet for this printing.'}</p>
      </Show>
      {/* Which line is which, in the lines' own colours. Each overlay can be taken off on its own. */}
      <Show when={plot() && overlays().length}>
        <div
          class="sold-graph-legend"
          onPointerDown={stopSoldPointer}
          onPointerMove={stopSoldPointer}
          onPointerUp={stopSoldPointer}
        >
          <span class={['sold-graph-key is-picked', { 'is-dashed': props.dashed }]}>{props.pickedLabel}</span>
          <For each={overlays()}>
            {(row) => (
              <span class={['sold-graph-key', { 'is-dashed': row.dashed }]} style={{ '--key-line': row.color }}>
                {row.label}
                <button
                  type="button"
                  class="sold-graph-key-x"
                  aria-label={`Remove ${row.label} from the graph`}
                  title={`Remove ${row.label}`}
                  onClick={() => props.onRemoveOverlay?.(row.key)}
                >
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
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
                    {/* The same scale on the right edge: the newest prices are read there. */}
                    <text
                      x={geo().pad.l + geo().plotW + 5}
                      y={soldGraphY(tick, geo().scale.max, geo().pad.t, geo().plotH) + 3}
                      text-anchor="start"
                      class="sold-graph-axis sold-graph-axis-right"
                    >
                      {formatSoldAxisTick(tick)}
                    </text>
                  </g>
                )}
              </For>
              {/* The other picked series first, so the current one is drawn over them. */}
              <For each={geo().others}>
                {(row) => (
                  <g class={['sold-graph-under', { 'is-dashed': row.dashed }]} style={{ '--under-line': row.color }}>
                    <Show when={row.lead}><polyline points={row.lead} class="sold-graph-carry" /></Show>
                    <polyline points={row.line} />
                    <Show when={row.tail}><polyline points={row.tail} class="sold-graph-carry" /></Show>
                    <Show when={row.solo}><circle cx={row.solo[0]} cy={row.solo[1]} r="3" class="sold-graph-under-dot" /></Show>
                  </g>
                )}
              </For>
              <polygon points={geo().area} class="sold-graph-fill" />
              <Show when={geo().lead}><polyline points={geo().lead} class="sold-graph-line sold-graph-carry" /></Show>
              <polyline points={geo().line} class="sold-graph-line" />
              <Show when={geo().tail}><polyline points={geo().tail} class="sold-graph-line sold-graph-carry" /></Show>
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
                <Show when={!props.hideUnits && Number(active()?.soldQty || active()?.sampleCount) > 0}>
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
