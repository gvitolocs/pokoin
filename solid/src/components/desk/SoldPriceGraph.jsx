import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js';
import { formatPkn } from '@market/api.js';
import { POKOIN_NOW_SOURCE, PRICE_SOURCE_RANGES } from '@market/price-history.js';
import {
  activeSoldIndex,
  formatSoldAxisTick,
  formatSoldDayWithYear,
  formatSoldSampleCount,
  isSoldGraphClick,
  nearestSoldIndex,
  SOLD_GRAPH_PAD,
  soldConditionLabel,
  soldDateLocale,
  soldFilterShowsAll,
  soldFilterValue,
  soldGraphDateWindow,
  soldGraphGapSegments,
  soldGraphHoverRows,
  soldGraphRangeBounds,
  soldGraphRangeDays,
  soldGraphScale,
  soldGraphSpansYears,
  soldGraphTipMods,
  soldGraphTone,
  soldGraphY,
  soldLanguageLabel,
  soldUnitCount,
} from '@market/sold-graph.js';

function stopSoldPointer(event) {
  event.stopPropagation();
}

/** Where this browser remembers which source keys are turned off. */
const SOURCE_STATE_KEY = 'pokoin.graph.sources';

function readSourceState() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SOURCE_STATE_KEY) || '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch (_) {
    return {};
  }
}

function writeSourceState(state) {
  try {
    window.localStorage.setItem(SOURCE_STATE_KEY, JSON.stringify(state));
  } catch (_) {
    /* No storage (private mode, or a browser that refused it): the choice
       still works for this visit, it just is not kept. */
  }
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
        <Show when={props.chips.firstEdition && !props.linkedLabel}>
          <SoldGraphToggle label="1st Ed." pressed={props.firstEdition} onToggle={props.onFirstEdition} />
        </Show>
        <Show when={props.chips.graded && !props.linkedLabel}>
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
  let legendEl;
  let touchPointerActive = false;
  let pointerStart = null;
  const [size, setSize] = createSignal(null);
  const [hover, setHover] = createSignal(null);
  const [sourceState, setSourceState] = createSignal(readSourceState());
  const days = createMemo(() => (Array.isArray(props.series?.days) ? props.series.days : []));
  // Linked to the desk chips (Reverse, 1st Ed. and Graded included), nothing sits
  // above the plot: it starts at the top and the unit count moves to the foot.
  const bare = () => Boolean(props.linkedLabel);
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
  // props.onRemoveOverlay(key) takes one off, props.color paints the current one.
  const overlays = () => (Array.isArray(props.overlays) ? props.overlays : []).filter((row) => Array.isArray(row?.days) && row.days.length);
  // props.sources = [{ key, label, short, color, dashed, gapDays, carry, days }]:
  // one line per other price source. props.nowPoint is the cheapest live Pokoin
  // listing today, props.range the window the history was read for, and
  // props.onRange(key) asks for another one. Without them the chart is the one
  // that has always been here: the sold median and its overlays.
  const bounds = createMemo(() => soldGraphRangeBounds(props.range));
  const plotDays = createMemo(() => soldGraphRangeDays(days(), bounds()));
  const narrow = createMemo(() => (size()?.w || 0) < 560);
  const nowValue = createMemo(() => (Number(props.nowPoint) > 0 ? Number(props.nowPoint) : 0));
  const sourceLines = createMemo(() => (Array.isArray(props.sources) ? props.sources : [])
    .filter((row) => row && row.key && Array.isArray(row.days))
    .map((row) => ({
      key: String(row.key),
      label: String(row.label || row.key),
      short: String(row.short || row.label || row.key),
      color: row.color || '',
      dashed: Boolean(row.dashed),
      gapDays: Number(row.gapDays) || 0,
      carry: row.carry === 'onOrBefore' ? 'onOrBefore' : 'near',
      isSource: true,
      days: soldGraphRangeDays(row.days, bounds())
        .map((day) => ({ day: String(day.day), value: Number(day.pkn ?? day.value) || 0 }))
        .filter((day) => day.value > 0),
    })));
  // Pokoin now is the fourth key: no history, one value, drawn as a dot today.
  const nowLine = createMemo(() => (nowValue()
    ? { ...POKOIN_NOW_SOURCE, days: [], isNow: true, hasData: true }
    : null));
  const sourceKeys = createMemo(() => [...sourceLines(), ...(nowLine() ? [nowLine()] : [])]
    .map((row) => ({ ...row, hasData: row.isNow ? true : row.days.length > 0 })));
  const shown = (key) => sourceState()[key] !== false;
  const toggleSource = (key) => {
    const next = { ...sourceState(), [key]: !shown(key) };
    setSourceState(next);
    writeSourceState(next);
  };
  const facetLines = createMemo(() => overlays()
    .map((row) => ({ ...row, isSource: false, days: soldGraphRangeDays(row.days, bounds()) }))
    .filter((row) => row.days.length));
  // What is drawn under the picked line: source lines first, then the other
  // picked facets. A turned-off key and an empty series draw nothing at all.
  const underLines = createMemo(() => [
    ...sourceLines().filter((row) => row.days.length && shown(row.key)),
    ...facetLines(),
  ]);
  const nowOn = createMemo(() => Boolean(nowLine()) && shown(POKOIN_NOW_SOURCE.key));
  // The keys and range buttons take the plot's top line whenever they are there.
  const legendLine = createMemo(() => Boolean(overlays().length || sourceKeys().length || props.onRange));
  // A keys row that still overflows (overlay keys joined in) fades at its right
  // edge so it reads as scrollable. Read when the keys or the panel change,
  // never on a pointer move: scrollWidth forces a layout.
  const [keysOverflow, setKeysOverflow] = createSignal(false);
  createEffect(
    () => [sourceKeys(), overlays(), plot(), narrow()],
    ([, , , isNarrow]) => {
      // legendEl is untracked: the keys' change that re-runs this effect is also
      // what has just rendered it.
      setKeysOverflow(Boolean(legendEl) && isNarrow && legendEl.scrollWidth > legendEl.clientWidth);
    },
  );
  // Several lines on one plot: the hover lists them all instead of one price.
  const compareLines = createMemo(() => Boolean(underLines().length || nowOn()));
  const hasLines = createMemo(() => Boolean(plotDays().length || underLines().length));
  // The line colour drives its fill and its hover guide.
  const lineStyle = () => (props.color
    ? {
      '--sold-line': props.color,
      '--sold-fill': `color-mix(in srgb, ${props.color} 16%, transparent)`,
      '--sold-guide': `color-mix(in srgb, ${props.color} 45%, transparent)`,
    }
    : undefined);

  const plot = createMemo(() => {
    const rows = plotDays();
    const others = underLines();
    const box = size();
    // Sold days and source days together: every series shares one scale and one
    // date range, so the lines can be read against each other.
    const every = [...rows, ...others.flatMap((row) => row.days)];
    if (!every.length || !box) return null;
    const width = box.w;
    const height = box.h;
    // The default top padding clears a row of menus. Linked to the desk chips
    // there is only one small caption line, so the plot starts right under it.
    // The keys and range buttons take that line whenever they are shown.
    const pad = bare()
      ? { ...SOLD_GRAPH_PAD, t: legendLine() ? 30 : 12 }
      : (props.linkedLabel ? { ...SOLD_GRAPH_PAD, t: 36 } : SOLD_GRAPH_PAD);
    // The axis is drawn in the unit the tooltip already uses: `axisFactor` units
    // of the visitor's currency per PKN (1, or absent, keeps a PKN axis).
    const factor = Number(props.axisFactor) > 0 ? Number(props.axisFactor) : 1;
    // A sold day prices in `medianPkn`, a source day in `value`.
    const price = (row) => Number(row.value ?? row.medianPkn) || 0;
    const dayMs = (row) => Date.parse(`${row.day}T00:00:00Z`);
    const values = every.map((row) => price(row) * factor);
    const scale = soldGraphScale(Math.max(0, ...values), { minStep: factor === 1 ? 10 : 0.01 });
    // The selected range, clipped to the first and last day anything has.
    const window = soldGraphDateWindow(every, bounds());
    if (!window) return null;
    const start = window.start;
    const end = window.end;
    // A long window reads its dates with the year: past 300 days, or across New Year.
    const withYear = soldGraphSpansYears(start, end);
    const range = Math.max(1, end - start);
    const plotW = width - pad.l - pad.r;
    const plotH = height - pad.t - pad.b;
    const dateLocale = soldDateLocale();
    const single = every.length === 1 || range <= 1;
    const place = (row) => [
      pad.l + (single ? plotW / 2 : ((dayMs(row) - start) / range) * plotW),
      soldGraphY(price(row) * factor, scale.max, pad.t, plotH),
    ];
    const join = (pts) => pts.map(([x, y]) => `${x},${y}`).join(' ');
    // A sold series only has a point on a day it sold. Between two sales the line
    // runs straight; after its last one the price is carried flat to the edge of
    // the range (dashed, because it is not a sale), so no line stops in the
    // middle of the chart. Before its first sale that carry is drawn only while
    // no source line is on: with two years of history it would read flat.
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
    const hasSourceLine = others.some((row) => row.isSource);
    const lead = hasSourceLine ? '' : ends.lead;
    const tail = ends.tail;
    const firstDay = every.reduce((a, b) => (dayMs(a) <= dayMs(b) ? a : b));
    const lastDay = every.reduce((a, b) => (dayMs(a) >= dayMs(b) ? a : b));
    const left = lead ? pad.l : (points.length ? points[0][0] : pad.l);
    const right = tail ? pad.l + plotW : (points.length ? points[points.length - 1][0] : pad.l + plotW);
    // The days the guide can snap to, and, for each of them, the point of every
    // series that has a value that day.
    const marks = every.reduce((list, row) => {
      const day = String(row.day);
      if (!list.some((mark) => mark.day === day)) list.push({ day, x: place(row)[0] });
      return list;
    }, []).sort((a, b) => a.x - b.x);
    const atDay = others.reduce((map, row) => {
      const marksOfRow = new Map();
      row.days.forEach((day) => {
        const [x, y] = place(day);
        const list = marksOfRow.get(String(day.day)) || [];
        list.push({ day: String(day.day), x, y, color: row.color || '', dashed: Boolean(row.dashed), isSource: Boolean(row.isSource) });
        marksOfRow.set(String(day.day), list);
      });
      marksOfRow.forEach((list, day) => map.set(day, (map.get(day) || []).concat(list)));
      return map;
    }, new Map());
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
      lead,
      tail,
      marks,
      atDay,
      others: others.map((row) => {
        if (row.isSource) {
          // A source starts at its own first day and ends at its own last one.
          // Where its quotes are further apart than its gap the line breaks and a
          // faint dotted segment bridges the hole.
          const split = soldGraphGapSegments(row.days, row.gapDays);
          return {
            key: row.key,
            color: row.color,
            dashed: Boolean(row.dashed),
            isSource: true,
            segments: split.segments.map((run) => join(run.map(place))),
            bridges: split.bridges.map((pair) => join(pair.map(place))),
          };
        }
        const pts = row.days.map(place);
        const endsOf = carry(pts);
        return { key: row.key, color: row.color, dashed: Boolean(row.dashed), isSource: false, line: join(pts), lead: hasSourceLine ? '' : endsOf.lead, tail: endsOf.tail, solo: pts.length === 1 ? pts[0] : null };
      }),
      // Pokoin now has no history: one dot at the right edge, a stub pointing at it.
      now: nowOn() ? { x: pad.l + plotW, y: soldGraphY(nowValue() * factor, scale.max, pad.t, plotH) } : null,
      // The fill follows the line across the whole range it is drawn for.
      area: `${left},${pad.t + plotH} ${lead ? `${pad.l},${points[0][1]} ` : ''}${line}${tail ? ` ${pad.l + plotW},${points[points.length - 1][1]}` : ''} ${right},${pad.t + plotH}`,
      withYear,
      firstLabel: formatSoldDayWithYear(firstDay.day, dateLocale, withYear),
      lastLabel: formatSoldDayWithYear(lastDay.day, dateLocale, withYear),
    };
  });

  // The hover is a day, not a row of one series: several lines rarely quote on
  // the same day, and the guide has to stand where all of them can be read.
  const hoverMark = () => {
    const geo = plot();
    const index = hover();
    if (!geo || index == null || index < 0 || index >= geo.marks.length) return null;
    return geo.marks[index];
  };
  const hoverDay = () => (hoverMark() ? hoverMark().day : null);
  const hoverIndex = () => {
    const day = hoverDay();
    if (!day) return null;
    const rows = plotDays();
    return activeSoldIndex(rows.findIndex((row) => String(row.day) === day), rows.length);
  };
  const active = () => (hoverIndex() == null ? null : plotDays()[hoverIndex()]);
  const activePt = () => (hoverIndex() == null || !plot() ? null : plot().points[hoverIndex()]);
  const guideX = () => (hoverMark() ? hoverMark().x : null);
  const hoverDots = () => {
    const geo = plot();
    const day = hoverDay();
    return geo && day ? (geo.atDay.get(day) || []) : [];
  };
  const tipMods = () => (activePt() ? soldGraphTipMods(activePt()[0], activePt()[1], plot().width, plot().pad) : []);
  const tipSide = () => {
    const geo = plot();
    const mark = hoverMark();
    return geo && mark && mark.x > geo.width / 2 ? 'is-end' : 'is-start';
  };
  const formatValue = (pkn) => ((props.formatPrice ? props.formatPrice(pkn) : formatPkn(pkn)) || '0 PKN');
  // The rows can round the PKN amount themselves (props.formatRowPrice); the
  // visitor-currency part is whatever the desk's own formatter says.
  const rowValue = (pkn) => (props.formatRowPrice ? props.formatRowPrice(pkn) || formatValue(pkn) : formatValue(pkn));
  const price = () => (active() ? formatValue(active().medianPkn) : '');
  // The last day of the drawn range: where the Pokoin-now row can appear.
  const tipEndDay = createMemo(() => {
    const marks = plot()?.marks;
    return marks?.length ? marks[marks.length - 1].day : '';
  });
  // One row per visible line, in this order: the picked facet, the other price
  // sources, then the other picked facets.
  const tipLines = createMemo(() => {
    const sold = {
      key: 'picked',
      label: String(props.pickedLabel || 'Sold'),
      kind: 'sold',
      picked: true,
      color: props.color || '',
      dashed: Boolean(props.dashed),
      days: plotDays().map((row) => ({ day: String(row.day), value: Number(row.medianPkn) || 0 })),
    };
    const sources = underLines()
      .filter((row) => row.isSource)
      .map((row) => ({ key: row.key, label: row.label, kind: 'source', color: row.color, dashed: row.dashed, gapDays: row.gapDays, carry: row.carry, days: row.days }));
    // Pokoin now is one value, today: its row is in the list only when the
    // guide stands on the last day of the range, and is left out before that.
    const now = nowOn() && hoverDay() && String(hoverDay()) === String(tipEndDay())
      ? [{ ...POKOIN_NOW_SOURCE, kind: 'now', value: nowValue() }]
      : [];
    const facets = underLines()
      .filter((row) => !row.isSource)
      .map((row) => ({
        key: row.key,
        label: row.label,
        kind: 'sold',
        color: row.color,
        dashed: Boolean(row.dashed),
        days: row.days.map((day) => ({ day: String(day.day), value: Number(day.medianPkn) || 0 })),
      }));
    return [sold, ...sources, ...now, ...facets];
  });
  const tipRows = createMemo(() => {
    const geo = plot();
    return soldGraphHoverRows(tipLines(), hoverDay(), {
      formatValue: rowValue,
      formatDay: (iso) => formatSoldDayWithYear(iso, soldDateLocale(), geo?.withYear),
      endDay: tipEndDay(),
    });
  });

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
    // The guide stands on a day, and a day belongs to the hover only if some
    // visible series has a value for it: the sold days and the source days together.
    return nearestSoldIndex(geo.marks.map((mark) => mark.x), x);
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
    const day = index == null ? '' : plot()?.marks[index]?.day;
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
      class={['panel sold-graph', `is-${tone()}`, { 'is-dashed-line': props.dashed, 'is-narrow': narrow() }]}
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
      <Show when={!hasLines() && props.series != null}>
        <p class="sold-graph-empty">{props.emptyLabel || 'No sold-card analytics yet for this printing.'}</p>
      </Show>
      {/* One line inside the panel: which line is which in the lines' own colours,
          and which window of days is drawn. Each key comes off on its own, each
          range button asks for another window. Nothing here starts a hover. */}
      <Show when={legendLine()}>
        <div
          class="sold-graph-topline"
          onPointerDown={stopSoldPointer}
          onPointerMove={stopSoldPointer}
          onPointerUp={stopSoldPointer}
        >
          <div
            ref={(el) => { legendEl = el; }}
            class={['sold-graph-legend', { 'is-overflow': keysOverflow() }]}
          >
            <Show when={plot()}>
              {/* On a phone the desk chips right above already say which condition
                  and language is plotted: the picked key only stays when there are
                  overlay keys to tell apart. */}
              <Show when={!narrow() || overlays().length}>
                <span class={['sold-graph-key is-picked', { 'is-dashed': props.dashed }]}>{props.pickedLabel}</span>
              </Show>
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
            </Show>
            <For each={sourceKeys()}>
              {(row) => (
                <button
                  type="button"
                  class={[
                    'sold-graph-key',
                    'is-source',
                    { 'is-dashed': row.dashed, 'is-off': !shown(row.key), 'is-empty': !row.hasData },
                  ]}
                  style={{ '--key-line': row.color }}
                  aria-pressed={String(Boolean(shown(row.key) && row.hasData))}
                  disabled={!row.hasData}
                  title={row.hasData ? row.label : `No ${row.label} data in this range`}
                  aria-label={row.hasData ? row.label : `No ${row.label} data in this range`}
                  onClick={() => toggleSource(row.key)}
                >
                  {narrow() ? row.short : row.label}
                </button>
              )}
            </For>
          </div>
          <Show when={props.onRange}>
            <div class="sold-graph-ranges">
              <For each={PRICE_SOURCE_RANGES}>
                {(row) => (
                  <button
                    type="button"
                    class="sold-graph-range"
                    aria-pressed={String(String(bounds()?.key || '') === row.key)}
                    onClick={() => props.onRange(row.key)}
                  >
                    {row.label}
                  </button>
                )}
              </For>
            </div>
          </Show>
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
              {/* The other series first, so the current one is drawn over them. A price
                  source breaks where it stopped quoting and bridges the hole dotted; a
                  sold facet is carried flat to the edges instead. */}
              <For each={geo().others}>
                {(row) => (
                  <g class={['sold-graph-under', { 'is-dashed': row.dashed, 'is-source': row.isSource }]} style={{ '--under-line': row.color }}>
                    <Show when={row.isSource}>
                      <For each={row.segments}>
                        {(points) => <polyline points={points} />}
                      </For>
                      <For each={row.bridges}>
                        {(points) => <polyline points={points} class="sold-graph-gap" />}
                      </For>
                    </Show>
                    <Show when={!row.isSource}>
                      <Show when={row.lead}><polyline points={row.lead} class="sold-graph-carry" /></Show>
                      <polyline points={row.line} />
                      <Show when={row.tail}><polyline points={row.tail} class="sold-graph-carry" /></Show>
                      <Show when={row.solo}><circle cx={row.solo[0]} cy={row.solo[1]} r="3" class="sold-graph-under-dot" /></Show>
                    </Show>
                  </g>
                )}
              </For>
              {/* Overlaid series are compared as lines: the fill under one of them would sit over the others. */}
              <Show when={!geo().others.length}>
                <polygon points={geo().area} class="sold-graph-fill" />
              </Show>
              <Show when={geo().lead}><polyline points={geo().lead} class="sold-graph-line sold-graph-carry" /></Show>
              <polyline points={geo().line} class="sold-graph-line" />
              <Show when={geo().tail}><polyline points={geo().tail} class="sold-graph-line sold-graph-carry" /></Show>
              <Show when={geo().now}>
                {(now) => (
                  <>
                    <line x1={now().x - 44} x2={now().x} y1={now().y} y2={now().y} class="sold-graph-now-stub" />
                    <circle cx={now().x} cy={now().y} r="4" class="sold-graph-now-dot" />
                  </>
                )}
              </Show>
              <Show when={guideX() != null}>
                <line
                  x1={guideX()}
                  x2={guideX()}
                  y1={geo().pad.t}
                  y2={geo().pad.t + geo().plotH}
                  class="sold-graph-guide"
                />
              </Show>
              {/* Where the guide stands, every other visible line gets a dot for that day. */}
              <For each={hoverDots()}>
                {(dot) => (
                  <circle cx={dot.x} cy={dot.y} r="2.6" class="sold-graph-hover-dot" style={{ '--dot-fill': dot.color }} />
                )}
              </For>
              <For each={geo().points} keyed={false}>
                {(point, index) => (
                  <circle
                    cx={point()[0]}
                    cy={point()[1]}
                    r={index === hoverIndex() ? 4.4 : (geo().points.length === 1 ? 3.5 : 2.4)}
                    class={index === hoverIndex() ? 'sold-graph-dot is-active' : 'sold-graph-dot'}
                  />
                )}
              </For>
              <text x={geo().pad.l} y={geo().height - 7} class="sold-graph-axis">{geo().firstLabel}</text>
              <text x={geo().width - 8} y={geo().height - 7} text-anchor="end" class="sold-graph-axis">{geo().lastLabel}</text>
              <rect x="0" y="0" width={geo().width} height={geo().height} class="sold-graph-hit" />
            </svg>
            {/* One line and no other source: the one price card it has always been. */}
            <Show when={!compareLines()}>
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
                  <span>{formatSoldDayWithYear(active()?.day, geo().dateLocale, geo().withYear)}</span>
                  <Show when={!props.hideUnits && Number(active()?.soldQty || active()?.sampleCount) > 0}>
                    <span>{formatSoldSampleCount(active()?.soldQty || active()?.sampleCount)}</span>
                  </Show>
                  <Show when={active()?.comments?.[0]}><em>{active()?.comments?.[0]}</em></Show>
                </div>
              </Show>
            </Show>
            {/* Several lines: the day, and one row for each of them. The box sits at
                the top of the plot, on the free side of the guide. */}
            <Show when={compareLines() && hoverDay()}>
              {(day) => (
                <div
                  class={['sold-graph-tip', 'is-rows', tipSide()]}
                  style={{
                    left: `${((guideX() || 0) / geo().width) * 100}%`,
                    top: `${(geo().pad.t / geo().height) * 100}%`,
                  }}
                  role="status"
                >
                  <strong>{formatSoldDayWithYear(day(), geo().dateLocale, geo().withYear)}</strong>
                  <For each={tipRows().rows}>
                    {(row) => (
                      <span class={['sold-graph-tip-row', { 'is-picked': row.picked }]} style={{ '--row-line': row.color }}>
                        <i class={['sold-graph-tip-swatch', { 'is-dashed': row.dashed }]} />
                        <span class="sold-graph-tip-label">{row.label}</span>
                        <em class={['sold-graph-tip-value', { 'is-none': row.value == null }]}>{row.text}</em>
                      </span>
                    )}
                  </For>
                  <Show when={tipRows().more > 0}>
                    <span class="sold-graph-tip-more">+{tipRows().more} more</span>
                  </Show>
                </div>
              )}
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
