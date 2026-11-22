import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CARDMARKET_OFFERS_SOURCE,
  CM_OFFER_FLOORS,
  cmOfferFacet,
  fetchCardPriceHistory,
  graphGapDays,
  priceHistoryRange,
  priceSourceSeries,
  POKOIN_SOURCE,
  PRICE_SOURCES,
  PRICE_SOURCE_RANGES,
} from './price-history.js';
import { soldGraphGapSegments, soldGraphHoverRows, soldGraphTailBridge } from './sold-graph.js';

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

/** One product's offer day: a series per floor the window has days for, best first. */
const OFFERS = {
  source: 'cardmarket_offers',
  currency: 'PKN',
  metric: 'lowestOffer',
  status: 'available',
  idProduct: 279646,
  language: 'EN',
  conditionIsFloor: true,
  series: [
    {
      condition: 'NM',
      days: [
        { day: '2026-11-16', lowestPkn: 2200, sellerType: 'private', asked: true },
        { day: '2026-11-09', lowestPkn: 1840, sellerType: 'pro', asked: true },
      ],
    },
    { condition: 'SP', days: [{ day: '2026-11-09', lowestPkn: 2000, sellerType: 'pro', asked: true }] },
  ],
};

test('the Cardmarket floor line is the asked floor, in the words of the ask', () => {
  const history = { ...HISTORY, cardmarketOffers: OFFERS };
  const rows = priceSourceSeries(history, { cmCondition: 'NM', cmLanguage: 'EN' });
  // Drawn beside the trend it belongs to, which is now named for what it is.
  assert.deepEqual(rows.map((row) => row.key), ['tcgplayer', 'cardmarket', 'cardmarket_offers', 'cardtrader_ask']);
  const offers = rows.find((row) => row.key === 'cardmarket_offers');
  assert.deepEqual(
    {
      label: offers.label,
      short: offers.short,
      color: offers.color,
      dashed: offers.dashed,
      gapDays: offers.gapDays,
      carry: offers.carry,
    },
    {
      label: 'Cardmarket · NM · EN',
      short: 'CM·NM',
      color: CARDMARKET_OFFERS_SOURCE.color,
      dashed: false,
      gapDays: 2,
      carry: 'none',
    },
  );
  assert.notEqual(offers.color, rows.find((row) => row.key === 'cardmarket').color, 'not the trend’s colour');
  // The asked series, oldest first, without the facets the line does not plot.
  assert.deepEqual(offers.days, [{ day: '2026-11-09', pkn: 1840 }, { day: '2026-11-16', pkn: 2200 }]);
  // Another floor of the same answer: its own days and its own words.
  const sp = priceSourceSeries(history, { cmCondition: 'SP' }).find((row) => row.key === 'cardmarket_offers');
  assert.deepEqual(sp.days, [{ day: '2026-11-09', pkn: 2000 }]);
  assert.deepEqual({ label: sp.label, short: sp.short }, { label: 'Cardmarket · SP · EN', short: 'CM·SP' });
  // A floor the answer has no series for is no line, and the rest reads on.
  assert.deepEqual(
    priceSourceSeries(history, { cmCondition: 'MP' }).map((row) => row.key),
    ['tcgplayer', 'cardmarket', 'cardtrader_ask'],
  );
});

test('an answer without the Cardmarket offers block is simply one line less', () => {
  assert.deepEqual(
    priceSourceSeries(HISTORY, { cmCondition: 'NM' }).map((row) => row.key),
    ['tcgplayer', 'cardmarket', 'cardtrader_ask'],
  );
  for (const status of ['empty', 'unavailable', 'unsupported_game']) {
    const history = { ...HISTORY, cardmarketOffers: { status, series: [] } };
    assert.deepEqual(
      priceSourceSeries(history).map((row) => row.key),
      ['tcgplayer', 'cardmarket', 'cardtrader_ask'],
      status,
    );
  }
  // The other lines are untouched by the block, and read it or not they are the same.
  assert.deepEqual(
    priceSourceSeries({ ...HISTORY, cardmarketOffers: OFFERS })[0].days,
    priceSourceSeries(HISTORY)[0].days,
  );
});

test('a day the collector did not reach breaks the floor line, and is not priced', () => {
  // What the plot is given: a hover row reads `value`, the line's own days.
  const days = [
    { day: '2026-11-09', value: 1840 },
    { day: '2026-11-11', value: 1900 },
    { day: '2026-11-17', value: 2000 },
  ];
  // Two days is a gap it holds; six is the collector not having reached the card.
  const split = soldGraphGapSegments(days, CARDMARKET_OFFERS_SOURCE.gapDays);
  assert.equal(split.segments.length, 2);
  assert.equal(split.bridges.length, 1);
  const line = {
    key: 'cardmarket_offers', label: 'Cardmarket · NM · EN', kind: 'source', carry: 'none', gapDays: 2, days,
  };
  const missed = soldGraphHoverRows([line], '2026-11-13').rows[0];
  assert.equal(missed.value, null);
  assert.equal(missed.text, 'no data', 'a day it did not quote has no price');
  assert.deepEqual(soldGraphHoverRows([line], '2026-11-11').rows[0].value, 1900);
  // The same series with a carry would have answered the 13th from the 11th.
  const carried = soldGraphHoverRows([{ ...line, carry: 'near' }], '2026-11-13').rows[0];
  assert.equal(carried.value, 1900);
  // A weekly answer moves the gap with the week it is thinned into, like the rest.
  assert.equal(graphGapDays(CARDMARKET_OFFERS_SOURCE, 'day'), 2);
  assert.equal(graphGapDays(CARDMARKET_OFFERS_SOURCE, 'week'), 9);
});

test('the facet asked is a floor and a language Cardmarket keeps', () => {
  // No floor and "any language" are the server's own default facet.
  assert.deepEqual(cmOfferFacet('', ''), { condition: 'NM', language: 'EN' });
  assert.deepEqual(cmOfferFacet(undefined, undefined), { condition: 'NM', language: 'EN' });
  assert.deepEqual(cmOfferFacet('poor', 'de'), { condition: 'Poor', language: 'DE' });
  // A grade that is not one of the five floors, and a language the desk lists
  // but Cardmarket is never collected in, both ask the default rather than a
  // parameter the endpoint would refuse for the whole window.
  assert.deepEqual(cmOfferFacet('EX', 'ID'), { condition: 'NM', language: 'EN' });
  assert.deepEqual(cmOfferFacet('Mint', 'th'), { condition: 'NM', language: 'EN' });
  assert.deepEqual(cmOfferFacet('NM', 'zht'), { condition: 'NM', language: 'ZHT' });
  // The five floors are the desk's grades, "any" left out of them.
  assert.deepEqual(CM_OFFER_FLOORS, ['NM', 'SP', 'MP', 'PL', 'Poor']);
});

test('the graph asks the floor and the language it plots', async () => {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ cardId: '612376', bucket: 'day' }), { status: 200 });
  };
  try {
    await fetchCardPriceHistory('612376', { from: '2026-08-18', to: '2026-11-16' });
    assert.match(urls[0], /[?&]cmCondition=NM(&|$)/);
    assert.match(urls[0], /[?&]cmLanguage=EN(&|$)/);
    await fetchCardPriceHistory('612376', {
      from: '2026-08-18', to: '2026-11-16', reverse: true, cmCondition: 'SP', cmLanguage: 'JP',
    });
    assert.match(urls[1], /[?&]cmCondition=SP(&|$)/);
    assert.match(urls[1], /[?&]cmLanguage=JP(&|$)/);
    assert.match(urls[1], /[?&]reverse=1(&|$)/);
    // Anything the desk picks that the daily table does not keep is asked as
    // the default, never as a word the endpoint answers 400 for.
    await fetchCardPriceHistory('612376', { from: '2026-08-18', to: '2026-11-16', cmCondition: '', cmLanguage: 'ID' });
    assert.match(urls[2], /[?&]cmCondition=NM(&|$)/);
    assert.match(urls[2], /[?&]cmLanguage=EN(&|$)/);
  } finally {
    globalThis.fetch = original;
  }
});

/** One TCGplayer answer whose Holofoil price stopped while the feed went on. */
function stoppedSeries({ priced, tail, withNormal = true }) {
  return {
    tcgplayer: {
      status: 'available',
      currency: 'USD',
      series: [
        {
          productId: '589965',
          subtype: 'Holofoil',
          days: [...priced, ...tail.map((day) => ({ day, marketPrice: null }))],
          ...(tail.length ? {
            lastObservedDay: tail[tail.length - 1],
            lastListing: { day: tail[tail.length - 1], lowPkn: 133.33, low: '0.8000', currency: 'USD' },
          } : {}),
        },
        ...(withNormal ? [{
          productId: '589966',
          subtype: 'Normal',
          days: [{ day: '2026-11-05', marketPkn: 36 }, { day: '2026-11-06', marketPkn: 37 }],
        }] : []),
      ],
    },
  };
}

test('the TCGplayer line is the series with the most priced days, not the most rows', () => {
  // Four Holofoil rows of which one is priced, against two priced Normal rows:
  // the graph has two days to draw out of the Normal series and one out of the
  // other, so the Normal one is the card's TCGplayer line.
  const stopped = stoppedSeries({
    priced: [{ day: '2026-10-20', marketPkn: 154.35 }],
    tail: ['2026-11-10', '2026-11-20', '2026-11-21'],
  });
  const [tp] = priceSourceSeries(stopped);
  assert.deepEqual(tp.days, [{ day: '2026-11-05', pkn: 36 }, { day: '2026-11-06', pkn: 37 }]);
  // Ties still go to the first, and a series of nothing but unpriced rows is
  // chosen only when there is nothing else, exactly as before.
  const tie = {
    tcgplayer: {
      series: [
        { subtype: 'Holofoil', days: [{ day: '2026-11-05', marketPkn: 154.35 }, { day: '2026-11-06' }] },
        { subtype: 'Normal', days: [{ day: '2026-11-05', marketPkn: 36 }] },
      ],
    },
  };
  assert.equal(priceSourceSeries(tie)[0].days[0].pkn, 154.35, 'one priced day each: the series with more rows');
  const only = stoppedSeries({ priced: [], tail: ['2026-11-20', '2026-11-21'], withNormal: false });
  assert.deepEqual(priceSourceSeries(only), [], 'no priced day in the only series is no line');
});

test('the line carries the day the source stopped being priced', () => {
  const stopped = stoppedSeries({
    priced: [{ day: '2026-10-20', marketPkn: 154.35 }],
    tail: ['2026-11-20', '2026-11-21'],
    withNormal: false,
  });
  const [tp] = priceSourceSeries(stopped);
  assert.deepEqual(tp.days, [{ day: '2026-10-20', pkn: 154.35 }], 'the tail is not a price');
  assert.equal(tp.lastObservedDay, '2026-11-21');
  assert.deepEqual(tp.lastListing, { day: '2026-11-21', lowPkn: 133.33, low: '0.8000', currency: 'USD' });
  // A series priced through its last day, and an answer that has no TCGplayer
  // block at all, both have nothing to continue to.
  const healthy = priceSourceSeries(HISTORY)[0];
  assert.equal(healthy.key, 'tcgplayer');
  assert.equal(healthy.lastObservedDay, '');
  assert.equal(healthy.lastListing, null);
  assert.equal(priceSourceSeries({ cardtrader: HISTORY.cardtrader })[0].lastObservedDay, undefined,
    'only the series that reports it carries it');
  // A tail that is not a day, and a listing with no number, are not believed.
  const junk = priceSourceSeries({
    tcgplayer: {
      series: [{
        subtype: 'Holofoil',
        days: [{ day: '2026-10-20', marketPkn: 154.35 }],
        lastObservedDay: 'later',
        lastListing: { day: '2026-11-21', lowPkn: 0 },
      }],
    },
  })[0];
  assert.equal(junk.lastObservedDay, '');
  assert.equal(junk.lastListing, null);
});

test('the stopped line is carried flat to the day the source last answered', () => {
  const days = [{ day: '2026-10-18', value: 150 }, { day: '2026-10-20', value: 154.35 }];
  // The pair a dotted bridge is drawn from: the line's own last point, and that
  // same price on the day the source was last seen. Never the listing price.
  assert.deepEqual(soldGraphTailBridge(days, '2026-11-21'), [
    { day: '2026-10-20', value: 154.35 },
    { day: '2026-11-21', value: 154.35 },
  ]);
  // No tail when there is nothing to continue, when the day is not a day, and
  // when the series is priced through its last observed day or past it.
  assert.equal(soldGraphTailBridge([], '2026-11-21'), null);
  assert.equal(soldGraphTailBridge(days, ''), null);
  assert.equal(soldGraphTailBridge(days, 'later'), null);
  assert.equal(soldGraphTailBridge(days, '2026-10-20'), null);
  assert.equal(soldGraphTailBridge(days, '2026-10-19'), null);
  // Out of the range the graph draws is out of the picture: a `1m` window that
  // ends on 2026-11-16 does not reach a 21 November.
  const range = { key: '1m', from: '2026-10-17', to: '2026-11-16' };
  assert.deepEqual(soldGraphTailBridge(days, '2026-11-10', range), [
    { day: '2026-10-20', value: 154.35 },
    { day: '2026-11-10', value: 154.35 },
  ]);
  assert.equal(soldGraphTailBridge(days, '2026-11-21', range), null);
  assert.equal(soldGraphTailBridge(days, '2026-10-10', range), null);
  // The bridge style is the gap style: what the plot already draws dotted.
  const [from, to] = soldGraphTailBridge(days, '2026-11-21');
  const split = soldGraphGapSegments([from, to], 99);
  assert.equal(split.segments[0].length, 2, 'the pair is one run of two points');
  assert.equal(split.bridges.length, 0);
});

test('the hover row of a carried day says the price is old, and quotes the listing', () => {
  const line = {
    key: 'tcgplayer',
    label: 'TCGplayer',
    kind: 'source',
    gapDays: 10,
    carry: 'near',
    days: [{ day: '2026-10-18', value: 150 }, { day: '2026-10-20', value: 154.35 }],
    lastObservedDay: '2026-11-21',
    lastListing: { day: '2026-11-15', lowPkn: 133.33, low: '0.8000', currency: 'USD' },
  };
  const row = (day, of = line) => soldGraphHoverRows([of], day, { formatValue: (value) => `${value} PKN` }).rows[0];
  // On a day the line is carried over: the price is old, not missing, and what
  // TCGplayer still has is its cheapest listing. The words follow the sold rows'
  // "NM · JP … no sale", and the listing is the row's own quieter line — of the
  // 15th, which this 16th says because it is not the day it was asked on.
  assert.deepEqual(row('2026-11-16'), {
    key: 'tcgplayer',
    label: 'TCGplayer',
    color: '',
    dashed: false,
    picked: false,
    value: null,
    text: 'no recent sale',
    sub: 'lowest listing 133.33 PKN (2026-11-15)',
  });
  // The last day it was quoted keeps its own price; a day past the carry is the
  // plain no data again, with nothing quoted under it.
  assert.deepEqual({ value: row('2026-10-20').value, text: row('2026-10-20').text, sub: row('2026-10-20').sub }, {
    value: 154.35, text: '154.35 PKN', sub: '',
  });
  assert.deepEqual({ value: row('2026-12-10').value, text: row('2026-12-10').text, sub: row('2026-12-10').sub }, {
    value: null, text: 'no data', sub: '',
  });
  // Before its first day the row reads as it always did.
  assert.equal(row('2026-09-30').text, 'from 2026-10-18');
  // A carried line whose answer has no listing says only that the price is old.
  assert.deepEqual({ text: row('2026-11-16', { ...line, lastListing: null }).text, sub: row('2026-11-16', { ...line, lastListing: null }).sub }, {
    text: 'no recent sale', sub: '',
  });
  // A source that does not report the day is read exactly as before.
  const plain = { key: 'cardtrader_ask', label: 'CT lowest ask', kind: 'source', gapDays: 3, carry: 'near', days: line.days };
  assert.deepEqual({ text: row('2026-11-16', plain).text, sub: row('2026-11-16', plain).sub }, { text: 'no data', sub: '' });
});

test('a listing quote that is not of the hovered day says which day it is of', () => {
  const line = {
    key: 'tcgplayer',
    label: 'TCGplayer',
    kind: 'source',
    gapDays: 30,
    carry: 'near',
    days: [{ day: '2026-11-14', value: 154.35 }],
    lastObservedDay: '2026-11-16',
    lastListing: { day: '2026-11-15', lowPkn: 140.87 },
  };
  const row = (day, of = line) => soldGraphHoverRows([of], day, {
    formatValue: (value) => `${value} PKN`,
    formatDay: (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`,
  }).rows[0];
  // One ask of one day: on that day it needs no date, and the day after it says
  // where the quote came from instead of being read as that day's own.
  assert.equal(row('2026-11-15').sub, 'lowest listing 140.87 PKN');
  assert.equal(row('2026-11-16').sub, 'lowest listing 140.87 PKN (15/11)');
  // A tail day before the quote has none of its own to show: the row says the
  // price is old and stops there, rather than quoting the future.
  const last = { ...line, lastListing: { day: '2026-11-16', lowPkn: 133.33 } };
  assert.deepEqual({ text: row('2026-11-15', last).text, sub: row('2026-11-15', last).sub }, {
    text: 'no recent sale', sub: '',
  });
  // The day it priced is the line's own business, tail or not.
  assert.equal(row('2026-11-14').text, '154.35 PKN');
});

test('a listing quote nobody can date is not carried to the tooltip', () => {
  const series = (lastListing) => priceSourceSeries({
    tcgplayer: {
      series: [{
        subtype: 'Holofoil',
        days: [{ day: '2026-10-20', marketPkn: 154.35 }],
        lastObservedDay: '2026-11-21',
        lastListing,
      }],
    },
  })[0];
  assert.deepEqual(series({ day: '2026-11-20', lowPkn: 140.87 }).lastListing, { day: '2026-11-20', lowPkn: 140.87 });
  assert.equal(series({ lowPkn: 140.87 }).lastListing, null, 'an answer that names no day');
  assert.equal(series({ day: 'later', lowPkn: 140.87 }).lastListing, null, 'an answer whose day is not one');
});
