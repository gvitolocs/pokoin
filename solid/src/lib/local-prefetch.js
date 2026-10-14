import { onCleanup } from 'solid-js';
import { intentPreload } from '@solidjs/router';
import {
  EXPANSION_PAGE,
  fetchArtist,
  fetchCard,
  fetchExpansion,
  fetchVersionSet,
  prefetchCardDesk,
  setSlug,
} from '@market/api.js';
import { realPublicCardId } from '@market/card-stub.js';
import { gameBasename } from '@market/game.js';
import { afterHero } from '@market/hero-gate.js';
import { relatedFromPage } from '@market/related-cards.js';
import { peekHandoffCard } from './card-handoff.js';
import { createPrefetchQueue, linkTarget, prefetchBlocked } from './prefetch-queue.js';

/**
 * Prefetch what the user is about to open into the local store
 * (market/src/local-read.js), so the click paints from memory.
 *
 * - Intent: the router's own delegated intent listener (pointer resting
 *   60 ms, touchstart, focus) is the only one; for card desks, version, set
 *   and artist pages it warms the route code and queues the page data here.
 * - Viewport: after each navigation, the first few visible card / set tiles.
 * - Desk: once a card desk loads, its related cards and its set.
 * Loads run at idle with `priority: 'low'`, at most 4 at once, newest intent
 * first; a click elsewhere or Back aborts the rest. Nothing on Save-Data / 2g.
 * No edge logic: freshness is the API's Cache-Control / ETag, read through
 * the browser HTTP cache.
 */
const VIEWPORT_PER_PAGE = 6;

const blocked = () => prefetchBlocked(typeof navigator === 'undefined' ? null : navigator.connection);

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
    case 'versions':
      return Promise.all([
        fetchVersionSet(target.id, { prefetch: true, signal }),
        fetchCard(target.id, { lang: target.lang, slug: target.slug, prefetch: true, signal }),
      ]);
    case 'set':
      return fetchExpansion({ slug: target.slug, limit: EXPANSION_PAGE, offset: 0, prefetch: true, signal });
    default:
      return fetchArtist(target.slug, { limit: 5000, prefetch: true, signal });
  }
}

const queue = createPrefetchQueue({ load, idle, blocked });

const targetOf = (url) => linkTarget(url.pathname, { base: gameBasename(), cardId: realPublicCardId });

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
