import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchCardPriceHistory,
  graphGapDays,
  priceHistoryRange,
  priceSourceSeries,
  POKOIN_SOURCE,
  PRICE_SOURCES,
  PRICE_SOURCE_RANGES,
} from './price-history.js';
import { soldGraphGapSegments } from './sold-graph.js';

test('a range button is its own window ending today', () => {
  const today = '2026-11-16';
  assert.deepEqual(priceHistoryRange('1m', today), { key: '1m', from: '2026-10-17', to: today });
  assert.deepEqual(priceHistoryRange('3m', today), { key: '3m', from: '2026-08-18', to: today });
  assert.deepEqual(priceHistoryRange('1y', today), { key: '1y', from: '2025-11-16', to: today });
  assert.deepEqual(priceHistoryRange('all', today), { key: 'all', from: '2024-02-08', to: today });
  assert.deepEqual(PRICE_SOURCE_RANGES.map((row) => row.key), ['1m', '3m', '1y', 'all']);
});

test('an unknown range key and a missing today fall back, never a bad window', () => {
  const fallback = priceHistoryRange('forever', '2026-11-16');
  assert.equal(fallback.key, '3m');
  assert.equal(fallback.from, '2026-08-18');
  const live = priceHistoryRange('1m');
  assert.match(live.to, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(live.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(live.from < live.to);
});

const HISTORY = {
  cardId: '612376',
  from: '2026-08-18',
  to: '2026-11-16',
  cardtrader: {
    status: 'available',
    days: [
      { day: '2026-09-11', lowestAskPkn: 278 },
      { day: '2026-09-12', lowestAskPkn: 265 },
    ],
  },
  tcgplayer: {
    status: 'available',
    series: [
      {
        productId: '589965',
        subtype: 'Reverse Holofoil',
        days: [
          { day: '2026-11-14', marketPrice: '1.0000', marketPkn: 182 },
          { day: '2026-11-13', marketPrice: '1.0000', marketPkn: 180 },
          { day: '2026-11-12', marketPrice: '1.0000', marketPkn: 179 },
        ],
      },
      {
        productId: '589965',
        subtype: 'Holofoil',
        days: [
          { day: '2026-11-14', marketPrice: '0.8500', marketPkn: 154.35 },
          { day: '2026-11-01', marketPrice: '0.8000', marketPkn: 145 },
        ],
      },
      {
        productId: '589966',
        subtype: 'Normal',
        days: [{ day: '2026-11-14', marketPrice: '0.2000', marketPkn: 36 }],
      },
    ],
  },
  cardmarket: {
    status: 'available',
    products: [
      {
        productId: '794461',
        days: [
          { day: '2026-11-09', trend: 0.71, trendPkn: 142, trendFoilPkn: null },
          { day: '2026-11-16', trend: 0.71, trendPkn: 145, trendFoilPkn: 168 },
        ],
      },
      { productId: '794462', days: [{ day: '2026-11-16', trendPkn: 999 }] },
    ],
  },
  fx: { base: 'EUR', quote: 'USD', firstDay: '2026-08-10', lastDay: '2026-11-16' },
};

test('every source that answered in PKN becomes a line, in legend order', () => {
  const rows = priceSourceSeries(HISTORY, { reverse: false });
  assert.deepEqual(rows.map((row) => row.key), ['tcgplayer', 'cardmarket', 'cardtrader_ask']);
  const [tcg, cm, ask] = rows;
  assert.deepEqual(
    { label: tcg.label, short: tcg.short, color: tcg.color, dashed: tcg.dashed, gapDays: tcg.gapDays },
    { label: 'TCGplayer', short: 'TP', color: '#8ab4ff', dashed: false, gapDays: 10 },
  );
  // Not the reverse series, and inside the non-reverse group the one with most days.
  assert.deepEqual(tcg.days, [{ day: '2026-11-01', pkn: 145 }, { day: '2026-11-14', pkn: 154.35 }]);
  // Only products[0], oldest first.
  assert.deepEqual(cm.days, [{ day: '2026-11-09', pkn: 142 }, { day: '2026-11-16', pkn: 145 }]);
  assert.deepEqual(ask.days, [{ day: '2026-09-11', pkn: 278 }, { day: '2026-09-12', pkn: 265 }]);
  assert.deepEqual(PRICE_SOURCES.map((row) => row.key), ['tcgplayer', 'cardmarket', 'cardtrader_ask', 'pokoin']);
  // Pokoin is one of the lines now, in the desk's own yellow, and last in the legend.
  assert.deepEqual(
    {
      label: POKOIN_SOURCE.label,
      short: POKOIN_SOURCE.short,
      color: POKOIN_SOURCE.color,
      dashed: POKOIN_SOURCE.dashed,
      gapDays: POKOIN_SOURCE.gapDays,
      carry: POKOIN_SOURCE.carry,
    },
    { label: 'Pokoin', short: 'PK', color: 'var(--yellow)', dashed: false, gapDays: 3, carry: 'near' },
  );
});

test('Pokoin is a line of its own, from pokoin.days', () => {
  const history = {
    ...HISTORY,
    pokoin: {
      source: 'pokoin_listings',
      currency: 'PKN',
      metric: 'lowestAsk',
      status: 'available',
      days: [
        { day: '2026-11-16', lowestAskPkn: 240, listingCount: 3 },
        { day: '2026-11-10', lowestAskPkn: 255, listingCount: 2 },
        { day: '2026-11-09', lowestAskPkn: 0, listingCount: 0 },
      ],
    },
  };
  const rows = priceSourceSeries(history);
  assert.deepEqual(rows.map((row) => row.key), ['tcgplayer', 'cardmarket', 'cardtrader_ask', 'pokoin']);
  const pokoin = rows[rows.length - 1];
  // Oldest first, the unpriced day left out; the day is read without its listing count.
  assert.deepEqual(pokoin.days, [{ day: '2026-11-10', pkn: 255 }, { day: '2026-11-16', pkn: 240 }]);
  // The same answer without a Pokoin block — an empty or unavailable leg — draws no line.
  assert.equal(history.pokoin.status, 'available');
  const none = { ...history, pokoin: { status: 'empty', days: [] } };
  assert.deepEqual(priceSourceSeries(none).map((row) => row.key), ['tcgplayer', 'cardmarket', 'cardtrader_ask']);
  // The sold lines and the other sources read the full answer the same way either way.
  assert.deepEqual(priceSourceSeries(none)[0].days, priceSourceSeries(HISTORY)[0].days);
});

test('a weekly answer moves each gap with the week it is thinned into', () => {
  assert.equal(graphGapDays({ gapDays: 3 }, 'day'), 3);
  assert.equal(graphGapDays({ gapDays: 3 }, 'week'), 10);
  assert.equal(graphGapDays({ gapDays: 99 }, 'week'), 106);
  assert.equal(graphGapDays({ gapDays: 3 }, undefined), 3);
  const history = {
    bucket: 'week',
    cardtrader: { status: 'available', days: [{ day: '2026-09-11', lowestAskPkn: 278 }, { day: '2026-09-18', lowestAskPkn: 270 }] },
    pokoin: { status: 'available', days: [{ day: '2026-11-08', lowestAskPkn: 255 }, { day: '2026-11-15', lowestAskPkn: 240 }] },
  };
  // Seven days apart is one thinning step, not a hole: the line stays unbroken.
  const [ask, pokoin] = priceSourceSeries(history);
  assert.equal(ask.gapDays, 10);
  assert.equal(pokoin.gapDays, 10);
  // A skipped week is still a hole, and the nearest-day hover reads a week away.
  assert.equal(soldGraphGapSegments(pokoin.days, pokoin.gapDays).segments.length, 1);
  const withAHole = { days: [...pokoin.days, { day: '2026-12-01', pkn: 200 }] };
  const split = soldGraphGapSegments(withAHole.days, pokoin.gapDays);
  assert.equal(split.segments.length, 2);
  assert.equal(split.bridges.length, 1);
});

test('reverse picks the reverse-holo series and the Cardmarket foil trend', () => {
  const [tcg, cm] = priceSourceSeries(HISTORY, { reverse: true });
  assert.deepEqual(tcg.days, [
    { day: '2026-11-12', pkn: 179 },
    { day: '2026-11-13', pkn: 180 },
    { day: '2026-11-14', pkn: 182 },
  ]);
  // trendFoilPkn only where it has one; the day without a foil keeps the trend.
  assert.deepEqual(cm.days, [{ day: '2026-11-09', pkn: 142 }, { day: '2026-11-16', pkn: 168 }]);
});

test('a source that has not grown the PKN fields yet is simply left out', () => {
  // Today's live payload: tcgplayer without marketPkn, no cardmarket at all.
  const live = {
    cardtrader: { status: 'available', days: [{ day: '2026-09-11', lowestAskPkn: 278 }] },
    tcgplayer: { status: 'available', series: [{ subtype: 'Holofoil', days: [{ day: '2026-11-14', marketPrice: '0.8500' }] }] },
  };
  assert.deepEqual(priceSourceSeries(live).map((row) => row.key), ['cardtrader_ask']);
  assert.deepEqual(priceSourceSeries({}), []);
  assert.deepEqual(priceSourceSeries(null), []);
});

test('zero, negative and unpriced days never make a line', () => {
  const history = {
    cardtrader: {
      status: 'available',
      days: [
        { day: '2026-11-04', lowestAskPkn: 0 },
        { day: '2026-11-05', lowestAskPkn: -5 },
        { day: '2026-11-06', lowestAskPkn: null },
        { day: '', lowestAskPkn: 20 },
        { day: '2026-11-07', lowestAskPkn: 20 },
      ],
    },
  };
  const rows = priceSourceSeries(history);
  assert.deepEqual(rows.map((row) => row.key), ['cardtrader_ask']);
  assert.deepEqual(rows[0].days, [{ day: '2026-11-07', pkn: 20 }]);
  // A source that is all zeros is not a source.
  const allZero = { cardtrader: { days: [{ day: '2026-11-07', lowestAskPkn: 0 }] } };
  assert.deepEqual(priceSourceSeries(allZero), []);
});

test('the requested card id is the only thing that reaches the API', async () => {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ cardId: '612376' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const data = await fetchCardPriceHistory('612376', { from: '2026-08-18', to: '2026-11-16' });
    assert.equal(data?.cardId, '612376');
    assert.match(urls[0], /\/api\/marketplace-card-price-history\?cardId=612376&from=2026-08-18&to=2026-11-16/);
  } finally {
    globalThis.fetch = original;
  }
});

test('the graph asks for the small answer, and for the facet it plots', async () => {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ cardId: '612376', bucket: 'day' }), { status: 200 });
  };
  try {
    await fetchCardPriceHistory('612376', { from: '2026-08-18', to: '2026-11-16' });
    assert.match(urls[0], /[?&]fields=graph(&|$)/);
    assert.ok(!/[?&]reverse=/.test(urls[0]), 'no reverse flag while the desk plots the normal one');
    await fetchCardPriceHistory('612376', { from: '2026-08-18', to: '2026-11-16', reverse: true });
    assert.match(urls[1], /[?&]fields=graph(&|$)/);
    assert.match(urls[1], /[?&]reverse=1(&|$)/);
    // The window is still asked for, so a long one comes back thinned by the server.
    assert.match(urls[1], /from=2026-08-18/);
    assert.match(urls[1], /to=2026-11-16/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a card id that is not a number and a failed request both resolve null', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('offline');
  };
  try {
    assert.equal(await fetchCardPriceHistory(''), null);
    assert.equal(await fetchCardPriceHistory('612376a'), null);
    assert.equal(await fetchCardPriceHistory({ id: 'x' }), null);
    assert.equal(calls, 0, 'a non-numeric id never asks the API');
    assert.equal(await fetchCardPriceHistory('612376', { from: '2026-08-18', to: '2026-11-16' }), null);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
