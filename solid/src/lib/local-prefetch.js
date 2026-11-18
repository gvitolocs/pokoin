import { onCleanup } from 'solid-js';
import { intentPreload } from '@solidjs/router';
import {
  EXPANSION_PAGE,
  fetchArtist,
  fetchCard,
  fetchExpansion,
  fetchSellerSnapshot,
  fetchVersionSet,
  prefetchCardDesk,
  setSlug,
} from '@market/api.js';
import { realPublicCardId } from '@market/card-stub.js';
import { gameBasename } from '@market/game.js';
import { afterHero } from '@market/hero-gate.js';
import { warmCardPriceHistory } from '@market/price-history.js';
import { relatedFromPage } from '@market/related-cards.js';
import { peekHandoffCard } from './card-handoff.js';
import { createPrefetchQueue, linkTarget, prefetchBlocked } from './prefetch-queue.js';

/**
 * Prefetch what the user is about to open into the local store
 * (market/src/local-read.js), so the click paints from memory.
 *
 * - Intent: the router's own delegated intent listener (pointer resting
 *   60 ms, touchstart, focus) is the only one; for card desks, version, set,
 *   artist and seller pages it warms the route code and queues the page data here.
 * - Viewport: after each navigation, the first few visible card / set tiles.
 * - Desk: once a card desk loads, its related cards and its set.
 * - Arrows: the previous and the next card, with everything their desk shows
 *   (`warmDeskNeighbor`, asked once per neighbour per desk).
 * Loads run at idle with `priority: 'low'`, at most 4 at once, newest intent
 * first; a click elsewhere or Back aborts the rest. Nothing on Save-Data / 2g,
 * and nothing while the tab is hidden.
 * No edge logic: freshness is the API's Cache-Control / ETag, read through
 * the browser HTTP cache.
 */
const VIEWPORT_PER_PAGE = 6;

// A hidden tab is not a user about to click: nothing is prefetched behind it.
const blocked = () => prefetchBlocked(typeof navigator === 'undefined' ? null : navigator.connection)
  || (typeof document !== 'undefined' && document.visibilityState === 'hidden');

function idle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 150 });
  else setTimeout(fn, 0);
}

/** One target's page data; `intent` also warms the desk scan and its live listings. */
function load(target, signal, intent) {
  switch (target.kind) {
    case 'card':
      return prefetchCardDesk(target.card || peekHandoffCard(target.id) || { id: target.id }, {
        lang: target.lang, slug: target.slug, art: intent, listings: intent, signal,
      });
    case 'desk': {
      // The whole neighbour desk, every panel the arrow click opens, in the order
      // the desk shows them.
      const page = prefetchCardDesk(target.card || peekHandoffCard(target.id) || { id: target.id }, {
        lang: target.lang,
        slug: target.slug,
        art: true,
        listings: true,
        sales: true,
        versions: true,
        book: true,
        names: true,
        native: true,
        signal,
      });
      // The graph window last, because it is last on the desk and it is a Silver
      // feature: `price` is the account check the desk itself already made, so a
      // warm for anybody else asks nothing and stores nothing.
      return page.then(() => warmCardPriceHistory(target.id, {
        signal,
        silver: () => Boolean(target.price),
      }));
    }
    case 'versions':
      return Promise.all([
        fetchVersionSet(target.id, { prefetch: true, signal }),
        fetchCard(target.id, { lang: target.lang, slug: target.slug, prefetch: true, signal }),
      ]);
    case 'set':
      return fetchExpansion({ slug: target.slug, limit: EXPANSION_PAGE, offset: 0, prefetch: true, signal });
    case 'seller':
      return fetchSellerSnapshot(target.handle, { prefetch: true, signal });
    default:
      return fetchArtist(target.slug, { limit: 5000, prefetch: true, signal });
  }
}

const queue = createPrefetchQueue({ load, idle, blocked });

// Router base is '' — the slug is stripped only for matching. Catalogue hrefs
// are still prefixed, so peel the live game prefix before classifying them.
const targetOf = (url) => linkTarget(url.pathname, { base: gameBasename(), cardId: realPublicCardId });

/**
 * Warm the desk an arrow points at (PH-R034 P5) through the queue every other
 * prefetch uses: it starts at browser idle — behind the reads of the page already
 * on screen, which were scheduled first — runs at most four loads at once with
 * `priority: 'low'`, and a click or Back aborts what has not started. Nothing is
 * queued on a hidden tab or a Save-Data connection, because `blocked` is the same
 * check the hover and the viewport scan use.
 *
 * `desk:` is a key of its own, apart from the `card:` a hover queues: one does not
 * cancel the other's need, and the queue's 30 s repeat window is what keeps a
 * neighbour this desk has already seen from being warmed again.
 *
 * `price` is whether the account is Silver — the desk knows, the queue must not
 * ask — and gates only the graph window, the one warm that is not everybody's.
 */
export function warmDeskNeighbor(card, { lang = 'en', slug = '', price = false } = {}) {
  const id = String(card?.id || card || '');
  if (!/^\d+$/.test(id)) return false;
  return queue.add({
    kind: 'desk', key: `desk:${lang}:${id}`, id, lang, slug, price, card,
  });
}

let scanTimers = [];
let scannedPage = '';
let scanned = 0;

/** The first VIEWPORT_PER_PAGE visible card / set links of this page, in document order. */
function scanViewport() {
  if (typeof IntersectionObserver === 'undefined' || blocked()) return;
  if (location.pathname !== scannedPage) {
    scannedPage = location.pathname;
    scanned = 0;
  }
  const targets = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    if (targets.size >= 48 || scanned >= VIEWPORT_PER_PAGE) break;
    const target = a.origin === location.origin && targetOf(a);
    if (target && (target.kind === 'card' || target.kind === 'set')) targets.set(a, target);
  }
  if (!targets.size) return;
  const io = new IntersectionObserver((entries) => {
    io.disconnect();
    for (const entry of entries) {
      if (scanned >= VIEWPORT_PER_PAGE) break;
      if (entry.isIntersecting && queue.add(targets.get(entry.target))) scanned += 1;
    }
  });
  targets.forEach((_, a) => io.observe(a));
}

/** Tiles render after their data: look once soon after a navigation and once more later. */
function scanSoon() {
  scanTimers.forEach(clearTimeout);
  scanTimers = [800, 2500].map((ms) => setTimeout(() => afterHero(() => idle(scanViewport)), ms));
}

/**
 * Router `preloadLinks` strategy. Wraps the router's intentPreload (which
 * also installs the router's link preloader): catalogue links warm route code
 * and queue their data; other links (search, …) keep the router's data preload.
 */
export function localPreload({ delay = 60 } = {}) {
  const intent = intentPreload({ delay, data: false });
  return (ctx) => {
    intent({
      ...ctx,
      preload(url) {
        const target = targetOf(url);
        ctx.preload(url, !target);
        queue.add(target, { intent: true });
      },
    });
    // Capture: before the router (and yield-nav) start the navigation.
    const onClick = (evt) => {
      const res = ctx.anchor(evt);
      if (!res) return;
      queue.abort(targetOf(res[1])?.key || '');
      scanSoon();
    };
    const onBack = () => {
      queue.abort();
      scanSoon();
    };
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onBack);
    scanSoon();
    onCleanup(() => {
      scanTimers.forEach(clearTimeout);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onBack);
    });
  };
}

/** Once a card desk's page has loaded and the browser is idle: its related cards, then its set. */
export function prefetchAfterDesk(page, { lang = 'en' } = {}) {
  if (!page?.card || blocked()) return;
  idle(() => {
    const set = setSlug(page.card.set || page.card.set_name || '');
    if (set) queue.add({ kind: 'set', key: `set:${set}`, slug: set });
    for (const card of relatedFromPage(page).reverse()) {
      const id = String(card.id || '');
      if (id) queue.add({ kind: 'card', key: `card:${lang}:${id}`, id, lang, slug: '', card });
    }
  });
}
