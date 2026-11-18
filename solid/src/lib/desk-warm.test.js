import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// PH-R034 P5, the solid half: the previous and the next card are warmed by one
// warmer, through the queue every other prefetch already uses, once per neighbour
// per desk, behind the desk's own reads, never behind a hidden tab — and the graph
// window, which is a Silver feature, is asked for Silver accounts only.
// `market/src/card-desk-warm.test.js` proves what the warm itself puts on the
// wire; what is pinned here is who schedules it and under what policy, which is
// the part the queue and the desk decide.
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const warm = read('./local-prefetch.js');
const desk = read('../pages/Card.jsx');
const api = read('../../../market/src/api.js');
const graph = read('../../../market/src/price-history.js');

const deskCase = () => warm.slice(warm.indexOf("case 'desk': {"), warm.indexOf("case 'versions':"));

test('one warmer for the arrows, and it is the queue', () => {
  // `warmDeskNeighbor` is the only entry point, and it hands its target to the
  // same queue the hover and the viewport scan use: at most four loads at a time,
  // started at browser idle, `priority: low`, and aborted by a click or Back.
  assert.match(warm, /export function warmDeskNeighbor\(card, \{ lang = 'en', slug = '', price = false \} = \{\}\)/);
  assert.match(warm, /return queue\.add\(\{\s*\n\s*kind: 'desk', key: `desk:\$\{lang\}:\$\{id\}`/);
  // A desk target is its own key, so it never silences the `card:` target a hover
  // queued for the same card, nor is silenced by it — and the hover stays light:
  // page, scan and listings, not the whole desk.
  assert.match(warm, /key: `desk:\$\{lang\}:\$\{id\}`/);
  assert.match(warm, /case 'card':[\s\S]*?art: intent, listings: intent, signal,/);
  // It asks every panel the neighbour desk shows, in one shot.
  for (const flag of ['listings', 'sales', 'versions', 'book', 'names', 'native']) {
    assert.match(deskCase(), new RegExp(`${flag}: true`), `the desk warm asks ${flag}`);
  }
  assert.match(deskCase(), /prefetchCardDesk\(/);
  // And nothing else does: the old second warmer is gone from both sides, so a
  // neighbour has exactly one schedule.
  assert.equal(api.includes('warmupNeighbors'), false, 'api.js has one desk warmer');
  assert.equal(desk.includes('warmupNeighbors'), false, 'the desk has one desk warmer');
});

test('the warm waits for the idle after this page, once per neighbour', () => {
  // Behind the hero (the neighbour's scan must not compete with this card's) and
  // behind this page's own reads, which were scheduled at mount.
  assert.match(desk, /afterHero\(\(\) => whenIdle\(\(\) => warmDeskNeighbor\(row, \{/);
  assert.match(desk, /\}\), NEIGHBOR_WARM_IDLE_MS\)\);/);
  assert.match(desk, /const NEIGHBOR_WARM_IDLE_MS = \d+;/);
  // Once per neighbour per desk: the arrows answer more than once as the page
  // settles, and the desk this step leaves is a fresh one.
  assert.match(desk, /const neighborWarmed = new Set\(\);/);
  assert.match(desk, /if \(!\/\^\\d\+\$\/\.test\(id\) \|\| neighborWarmed\.has\(id\)\) continue;/);
  assert.match(desk, /neighborWarmed\.add\(id\);/);
  // The one call that schedules it, from both mount paths: the cached first paint
  // and the page answer.
  assert.equal((desk.match(/warmNeighbors\(/g) || []).length, 3, 'the definition and the two paths');
});

test('nothing is prefetched behind a hidden tab, on the queue’s own policy', () => {
  // The connection rule is not re-invented here: it is `prefetchBlocked` — the one
  // the prefetch already used — plus the tab nobody is looking at.
  assert.match(warm, /const blocked = \(\) => prefetchBlocked\(/);
  assert.match(warm, /document\.visibilityState === 'hidden'/);
  // Every path into the queue goes through it, so the desk warm cannot slip past.
  assert.match(warm, /createPrefetchQueue\(\{ load, idle, blocked \}\)/);
  assert.match(read('./prefetch-queue.js'), /if \(!target \|\| blocked\(\)\) return false;/);
});

test('the graph window of a neighbour is Silver only', () => {
  // The desk decides (it owns the account), the warm carries it, and the ask
  // re-checks it: a non-Silver warm cannot reach price history from either end.
  assert.match(desk, /price: untrack\(accountSilver\),/);
  assert.match(warm, /silver: \(\) => Boolean\(target\.price\)/);
  assert.match(deskCase(), /page\.then\(\(\) => warmCardPriceHistory\(/, 'the window is asked last');
  assert.match(graph, /if \(!silver\(\)\) return null;/);
  assert.match(graph, /saveCardPriceHistory\(cardId, range, entry\)/);
  // The desk itself never asks for a non-Silver account, warm or not.
  assert.match(desk, /if \(!untrack\(accountSilver\)\) return;/);
});
