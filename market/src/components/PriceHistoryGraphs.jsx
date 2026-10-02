import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fetchCardPriceHistory } from '../api.js';
import { defaultQuoteSource, formatQuote, observedQuoteDays, quoteSegments, quoteSeries, quoteSeriesKey } from '../price-history.js';

const SOURCES = [
  ['cardtrader', 'CardTrader listings'],
  ['tcgplayer', 'TCGplayer market'],
  ['sales', 'Recorded sales'],
];
const dateLabel = (day) => new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${day}T00:00:00Z`));

function QuoteChart({ view, source }) {
  const days = useMemo(() => observedQuoteDays(view.days), [view.days]);
  const [pickedDay, setPickedDay] = useState('');
  const plotRef = useRef(null);
  const [width, setWidth] = useState(720);
  useLayoutEffect(() => {
    const node = plotRef.current;
    if (!node) return undefined;
    const measure = () => setWidth(Math.max(240, Math.round(node.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [days.length]);
  if (!days.length) {
    return <p className="price-history-empty">
      {['unavailable', 'error', 'unconfigured'].includes(view.status)
        ? 'Price history is temporarily unavailable.'
        : `No ${source === 'cardtrader' ? 'listed-price' : 'market-price'} observations for this printing yet.`}
    </p>;
  }
  const active = days.find((row) => row.day === pickedDay) || days.at(-1);
  const height = 220, left = 82, right = 24, top = 18, bottom = 35;
  const minimum = Math.min(...days.map((row) => Number(row.value)));
  const maximum = Math.max(...days.map((row) => Number(row.value)));
  const padding = Math.max(maximum * 0.07, (maximum - minimum) * 0.15, 0.01);
  const low = Math.max(0, minimum - padding), high = maximum + padding;
  const start = Date.parse(`${days[0].day}T00:00:00Z`);
  const end = Date.parse(`${days.at(-1).day}T00:00:00Z`);
  const x = (row) => left + (days.length === 1 ? 0.5
    : (Date.parse(`${row.day}T00:00:00Z`) - start) / Math.max(1, end - start)) * (width - left - right);
  const y = (row) => top + (high - Number(row.value)) / (high - low) * (height - top - bottom);
  return <>
    <div className="price-history-value" aria-live="polite">
      <strong>{formatQuote(active.value, view.currency)}</strong>
      <span>{view.label} · {dateLabel(active.day)}</span>
    </div>
    <svg ref={plotRef} className="price-history-chart" viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={`${view.label}: ${days.length} observed ${days.length === 1 ? 'day' : 'days'}`}>
      <title>{`${view.label}, ${dateLabel(days[0].day)} to ${dateLabel(days.at(-1).day)}`}</title>
      {[0, 0.5, 1].map((fraction) => {
        const value = low + (high - low) * fraction;
        const axisY = top + (1 - fraction) * (height - top - bottom);
        return <g key={fraction}>
          <line className="sold-graph-grid" x1={left} x2={width - right} y1={axisY} y2={axisY} />
          <text className="sold-graph-axis" x={left - 8} y={axisY + 4} textAnchor="end">
            {formatQuote(value, view.currency)}
          </text>
        </g>;
      })}
      {quoteSegments(days).map((segment) => <polyline key={segment[0].day}
        className="sold-graph-line" points={segment.map((row) => `${x(row)},${y(row)}`).join(' ')} />)}
      {days.map((row) => <circle key={row.day} cx={x(row)} cy={y(row)} r={row.day === active.day ? 5 : 3}
        className="sold-graph-dot" onPointerEnter={() => setPickedDay(row.day)}>
        <title>{`${dateLabel(row.day)}: ${formatQuote(row.value, view.currency)}`}</title>
      </circle>)}
      <text className="sold-graph-axis" x={left} y={height - 8}>{dateLabel(days[0].day)}</text>
      {days.length > 1 ? <text className="sold-graph-axis" x={width - right} y={height - 8}
        textAnchor="end">{dateLabel(days.at(-1).day)}</text> : null}
    </svg>
    <label className="price-history-day">Observed day
      <select value={active.day} onChange={(event) => setPickedDay(event.target.value)}>
        {days.map((row) => <option key={row.day} value={row.day}>{dateLabel(row.day)}</option>)}
      </select>
    </label>
    <p className="price-history-detail">
      {source === 'cardtrader' ? `${active.listedQuantity ?? '—'} listed copies · ${active.listingCount ?? '—'} listings · ${active.sellerCount ?? '—'} sellers`
        : `Low ${formatQuote(active.lowPrice, 'USD')} · Mid ${formatQuote(active.midPrice, 'USD')} · High ${formatQuote(active.highPrice, 'USD')}`}
    </p>
    {active.sourceTimestamp ? <p className="price-history-detail">
      {source === 'cardtrader' ? 'Refreshed' : 'Source updated'} {new Date(active.sourceTimestamp).toLocaleString()}
    </p> : null}
    {source === 'cardtrader' && active.dumpDay ? <p className="price-history-detail">
      Dump day {dateLabel(active.dumpDay)}
    </p> : null}
    <p className="price-history-note">
      {source === 'cardtrader'
        ? 'Cheapest listed ask across the printing’s conditions and languages. These prices are not sales.'
        : 'Daily USD market quotes for this printing and variant. Condition is unspecified; missing days stay missing.'}
      {days.length === 1 ? ' One observed day is available.' : ''}
    </p>
  </>;
}

export default function PriceHistoryGraphs({ cardId, children }) {
  const [selection, setSelection] = useState(null);
  const [result, setResult] = useState(null);
  const [failed, setFailed] = useState(false);
  const [seriesKey, setSeriesKey] = useState('');
  const history = result?.cardId === String(cardId) ? result.data : null;
  const source = selection || defaultQuoteSource(history);
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setFailed(false);
    setSelection(null);
    setSeriesKey('');
    fetchCardPriceHistory(cardId).then((data) => {
      if (!cancelled) setResult({ cardId: String(cardId), data });
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [cardId]);
  const view = useMemo(() => quoteSeries(history, source, seriesKey), [history, source, seriesKey]);
  const variants = history?.tcgplayer?.series || [];
  return <div className="price-history">
    <div className="price-history-sources" role="group" aria-label="Price history source">
      {SOURCES.map(([key, label]) => <button type="button" key={key}
        aria-pressed={source === key} className={source === key ? 'on' : ''}
        onClick={() => setSelection(key)}>{label}</button>)}
    </div>
    {source === 'sales' ? children : <section className="panel price-history-panel"
      aria-label={`${source === 'cardtrader' ? 'CardTrader listed' : 'TCGplayer market'} price history`}
      aria-busy={!history && !failed || undefined}>
      {source === 'tcgplayer' && variants.length > 1 ? <label className="price-history-day">Variant
        <select value={view.seriesKey}
          onChange={(event) => setSeriesKey(event.target.value)}>
          {variants.map((row) => <option key={quoteSeriesKey(row)} value={quoteSeriesKey(row)}>
            {row.subtype || 'Standard'} · {row.productId}
          </option>)}
        </select>
      </label> : source === 'tcgplayer' && variants.length === 1 ? <p className="price-history-detail">
        {variants[0].subtype || 'Standard'}
      </p> : null}
      {!history ? <p className="price-history-empty">{failed ? 'Price history is temporarily unavailable.' : 'Loading price history…'}</p>
        : <QuoteChart key={`${cardId}:${source}:${seriesKey}`} view={view} source={source} />}
    </section>}
  </div>;
}
