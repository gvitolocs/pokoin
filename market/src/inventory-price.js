import { formatPknNumber } from './pkn.js';

function positive(value) {
  const number = Number(value);
  return value != null && Number.isFinite(number) && number > 0 ? number : null;
}

export function inventoryMarketValue(prices, row, source) {
  const entry = prices[String(row?.cardId || row?.card_id || '')];
  if (!entry) return null;
  if (source === 'tcgplayer') {
    const quotes = (entry.tcgplayer || []).filter((quote) => positive(quote.marketPrice) != null);
    if (!quotes.length) return null;
    const values = quotes.map((quote) => Number(quote.marketPrice));
    return {
      currency: 'USD', low: Math.min(...values), high: Math.max(...values),
      title: quotes.map((quote) => `${quote.subtype || 'Standard'}: $${quote.marketPrice} (${quote.sourceTimestamp || 'date unavailable'})`).join('\n')
        + '\nTCGplayer aggregate market quotes in USD; condition is unspecified. Variants remain separate; no conversion to PKN.',
    };
  }
  if (source === 'cardtrader') {
    const history = (entry.cardtraderListed?.days || [])
      .filter((day) => positive(day.lowestAskPkn) != null)
      .sort((a, b) => String(a.day).localeCompare(String(b.day)));
    const matched = positive(entry.ctMatchedPkn);
    const overall = positive(entry.ctCheapestPkn);
    const latest = history.at(-1);
    const value = matched ?? overall ?? positive(latest?.lowestAskPkn);
    if (value == null) return null;
    const label = matched != null ? 'Current CardTrader ask matching condition and language.'
      : overall != null ? 'Current cheapest CardTrader ask across conditions and languages.'
        : 'Latest stored daily cheapest CardTrader ask across conditions and languages.';
    return {
      currency: 'PKN', value,
      title: [label, ...history.map((day) =>
        `${day.day}: ${formatPknNumber(day.lowestAskPkn)} PKN (refreshed ${day.sourceTimestamp || 'date unavailable'})`),
      'Daily dump values are listing asks, not sold prices.'].join('\n'),
    };
  }
  const native = positive(entry.pokoinCheapestPkn);
  const sold = positive(entry.soldMedianPkn);
  const value = native ?? sold;
  return value == null ? null : {
    currency: 'PKN', value,
    title: native != null ? 'Cheapest active Pokoin listing.' : 'CardTrader 30-day inferred-sale median; no active Pokoin listing.',
  };
}

export function inventoryMarketLabel(value) {
  if (!value) return '—';
  if (value.currency === 'USD') {
    const format = (amount) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
    return `${format(value.low)}${value.high !== value.low ? `–${format(value.high)}` : ''} USD`;
  }
  return `${formatPknNumber(value.value, { maximumFractionDigits: 0 })} PKN`;
}
