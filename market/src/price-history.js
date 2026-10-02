export function quoteSeries(history, source, seriesKey = '') {
  if (source === 'cardtrader') {
    const feed = history?.cardtrader;
    return {
      status: feed?.status,
      currency: 'PKN',
      label: 'Cheapest listing',
      days: (feed?.days || []).map((row) => ({ ...row, value: row.lowestAskPkn })),
    };
  }
  const series = history?.tcgplayer?.series || [];
  const selected = series.find((row) => quoteSeriesKey(row) === seriesKey)
    || series.find((row) => observedQuoteDays((row.days || []).map((day) => ({ ...day, value: day.marketPrice }))).length)
    || series[0];
  return {
    status: history?.tcgplayer?.status,
    currency: 'USD',
    label: 'Market price',
    seriesKey: selected ? quoteSeriesKey(selected) : '',
    days: (selected?.days || []).map((row) => ({ ...row, value: row.marketPrice })),
  };
}

export function defaultQuoteSource(history) {
  if (!history) return 'cardtrader';
  if (observedQuoteDays(quoteSeries(history, 'cardtrader').days).length) return 'cardtrader';
  if (observedQuoteDays(quoteSeries(history, 'tcgplayer').days).length) return 'tcgplayer';
  return 'sales';
}

export function quoteSeriesKey(series) {
  return `${series.productId}:${series.subtype || ''}`;
}

export function observedQuoteDays(days) {
  return (Array.isArray(days) ? days : [])
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.day || '')
      && Number.isFinite(Date.parse(`${row.day}T00:00:00Z`))
      && row.value !== null && row.value !== undefined && row.value !== ''
      && Number.isFinite(Number(row.value)) && Number(row.value) > 0)
    .sort((a, b) => a.day.localeCompare(b.day));
}

// A missing daily observation stays a gap, rather than an interpolated price.
export function quoteSegments(days) {
  const segments = [];
  for (const row of days) {
    const current = segments.at(-1);
    const previous = current?.at(-1);
    if (!previous || Date.parse(`${row.day}T00:00:00Z`)
      - Date.parse(`${previous.day}T00:00:00Z`) !== 86400000) {
      segments.push([row]);
    } else {
      current.push(row);
    }
  }
  return segments;
}

export function formatQuote(value, currency) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return '—';
  if (currency === 'PKN') return `${Math.round(Number(value))} PKN`;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4,
  }).format(Number(value));
}
