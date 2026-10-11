import { onCleanup } from 'solid-js';
import { viewportPreload } from '@solidjs/router';
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
import { relatedFromPage } from '@market/related-cards.js';
import { peekHandoffCard } from './card-handoff.js';
import { createPrefetchQueue, linkTarget, prefetchBlocked } from './prefetch-queue.js';

/**
 * Prefetch what the user is about to open into the local store
 * (market/src/local-read.js), so the click paints from memory.
 *
 * - Intent: one set of delegated document listeners (pointer resting 60 ms,
 *   touchstart, focus) for card desks, version pages, set pages and artist
 *   pages. It replaces the router's intentPreload: route code still warms
 *   through the router, page data comes from here.
 * - Viewport: the first few visible card / set tiles of each page, at idle.
 * - Desk: after a card desk loads, its related cards and its set.
 * Loads run at idle with `priority: 'low'`, at most 4 at once, newest intent
 * first; a click elsewhere or Back aborts the rest. Nothing on Save-Data / 2g.
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

/**
 * Router `preloadLinks` strategy: hover (resting `delay` ms), touch and focus
 * on a link warm its route code through the router and its page data here.
 * Other links (search, …) keep the router's own data preload.
 */
export function localIntentPreload({ delay = 60 } = {}) {
  return (ctx) => {
    let timer = 0;
    let hovered = null;
    const intend = ([, url]) => {
      const target = targetOf(url);
      ctx.preload(url, !target);
      queue.add(target, { intent: true });
    };
    const onOver = (evt) => {
      const res = ctx.anchor(evt);
      if (!res || res[0] === hovered) return;
      clearTimeout(timer);
      hovered = res[0];
      timer = setTimeout(() => intend(res), delay);
    };
    const onOut = (evt) => {
      if (hovered && !hovered.contains(evt.relatedTarget)) {
        clearTimeout(timer);
        hovered = null;
      }
    };
    const onNow = (evt) => {
      const res = ctx.anchor(evt);
      if (res) intend(res);
    };
    // Capture: before the router (and yield-nav) start the navigation.
    const onClick = (evt) => {
      const res = ctx.anchor(evt);
      if (res) queue.abort(targetOf(res[1])?.key || '');
    };
    const onBack = () => queue.abort();
    const passive = { passive: true };
    document.addEventListener('pointerover', onOver, passive);
    document.addEventListener('pointerout', onOut, passive);
    document.addEventListener('touchstart', onNow, passive);
    document.addEventListener('focusin', onNow, passive);
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onBack);
    onCleanup(() => {
      clearTimeout(timer);
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('touchstart', onNow);
      document.removeEventListener('focusin', onNow);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onBack);
    });
  };
}

/**
 * Router `preloadLinks` strategy: the router's viewport observer (a link
 * visible for 100 ms, flushed at idle) feeding the first VIEWPORT_PER_PAGE
 * card desks and set pages of each page into the queue. Data only.
 */
export function localViewportPreload({ perPage = VIEWPORT_PER_PAGE } = {}) {
  const observe = viewportPreload({ all: true });
  let page = '';
  let count = 0;
  return (ctx) => observe({
    ...ctx,
    preload(url) {
      const target = targetOf(url);
      if (!target || (target.kind !== 'card' && target.kind !== 'set')) return;
      if (location.pathname !== page) {
        page = location.pathname;
        count = 0;
      }
      if (count < perPage && queue.add(target)) count += 1;
    },
  });
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
