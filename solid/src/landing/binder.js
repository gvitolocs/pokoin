import { readAuthSession } from '@market/auth-session.js';
import {
  BINDER_SLOTS,
  MISSING_CARD,
  binderCount,
  binderFill,
  clearBinderCache,
  readBinderCache,
  samePage,
} from '@market/landing-binder.js';

/**
 * The hero binder. Signed out (or an empty collection) it keeps the static
 * demo cards. Signed in it becomes the first page of the visitor's own
 * collection: the stored page paints at once, the network read
 * (binder-sync.js, which may load Firebase for a token) runs once the binder
 * is on screen or the page goes idle, whichever comes first. Pictures are swapped in place once they have loaded, into the
 * same nine slots, so the slot-in, scan-line and chip animations stay.
 *
 * landing-boot.js marks `html.binder-mine` when a stored page for this uid
 * exists; home.css then holds the demo cards back for 3 s, so a warm visit
 * never shows Snorlax first.
 */

const LOAD_WAIT_MS = 2500;

function unmark() {
  document.documentElement.classList.remove('binder-mine');
}

/** Resolves with the URL that loaded (src, then full, then the missing-card scan). */
function loadPicture(card) {
  const tries = [card.src, card.full, MISSING_CARD].filter(Boolean);
  return new Promise((resolve) => {
    const next = () => {
      const url = tries.shift();
      if (!url) {
        resolve(MISSING_CARD);
        return;
      }
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(() => resolve(url));
      img.onerror = next;
      img.src = url;
    };
    next();
  });
}

function slotFor(card, index, url) {
  const slot = document.createElement(card.href ? 'a' : 'span');
  slot.className = index === 0 ? 'binder-slot is-scanning' : 'binder-slot';
  if (card.href) {
    slot.href = card.href;
    slot.setAttribute('aria-label', card.name);
  }
  const img = document.createElement('img');
  img.src = url;
  img.width = 280;
  img.height = 392;
  img.alt = card.href ? '' : card.name;
  img.decoding = 'async';
  img.addEventListener('error', () => {
    if (!img.src.endsWith(MISSING_CARD)) img.src = MISSING_CARD;
  }, { once: true });
  slot.append(img);
  if (index === 0) {
    const line = document.createElement('span');
    line.className = 'scan-line';
    slot.append(line);
  }
  return slot;
}

function emptySlot() {
  const slot = document.createElement('span');
  slot.className = 'binder-slot is-empty';
  return slot;
}

function parts(binder) {
  return {
    title: binder.querySelector('.binder-head strong'),
    subtitle: binder.querySelector('.binder-head div > span'),
    count: binder.querySelector('.binder-count'),
    fill: binder.querySelector('.binder-progress span'),
    grid: binder.querySelector('.binder-grid'),
  };
}

/** What the static demo looked like, to put back if the visitor turns out empty or signed out. */
function snapshot(binder) {
  const p = parts(binder);
  return {
    title: p.title?.textContent || '',
    subtitle: p.subtitle?.textContent || '',
    count: p.count?.textContent || '',
    slots: [...(p.grid?.children || [])].map((node) => node.cloneNode(true)),
  };
}

/** Paint `page` into the binder once its pictures have loaded (or after LOAD_WAIT_MS). */
async function paint(binder, page, isCurrent) {
  const loads = page.cards.map((card) => loadPicture(card));
  let timer;
  const ready = await Promise.race([
    Promise.all(loads),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), LOAD_WAIT_MS); }),
  ]);
  clearTimeout(timer);
  if (!isCurrent()) return;
  const urls = ready || page.cards.map((card) => card.src);
  const p = parts(binder);
  if (!p.grid) return;
  const slots = [];
  for (let index = 0; index < BINDER_SLOTS; index += 1) {
    const card = page.cards[index];
    slots.push(card ? slotFor(card, index, urls[index]) : emptySlot());
  }
  p.grid.replaceChildren(...slots);
  if (p.title) p.title.textContent = 'My collection';
  if (p.subtitle) p.subtitle.textContent = 'First page';
  if (p.count) {
    p.count.textContent = binderCount(page);
    p.count.title = `${page.cards.length} of ${page.total} cards in your collection`;
  }
  if (p.fill) p.fill.style.width = binderFill(page);
  binder.classList.add('is-own');
  unmark();
}

function restore(binder, demo) {
  const p = parts(binder);
  p.grid?.replaceChildren(...demo.slots.map((node) => node.cloneNode(true)));
  if (p.title) p.title.textContent = demo.title;
  if (p.subtitle) p.subtitle.textContent = demo.subtitle;
  if (p.count) {
    p.count.textContent = demo.count;
    p.count.removeAttribute('title');
  }
  if (p.fill) p.fill.style.removeProperty('width');
  binder.classList.remove('is-own');
}

/**
 * Mount on the hero binder. `whenIdle(fn)` schedules the network read;
 * `sync(uid)` (tests) replaces the binder-sync.js import.
 */
export function mountBinder(binder, { whenIdle, sync } = {}) {
  const session = readAuthSession();
  if (!session) {
    // Signed out: the demo stays, and no stored page outlives the session.
    clearBinderCache();
    unmark();
    return;
  }
  const demo = snapshot(binder);
  let shown = null;
  let generation = 0;
  let painting = Promise.resolve();
  const show = (page) => {
    shown = page;
    const mine = ++generation;
    painting = paint(binder, page, () => mine === generation);
    return painting;
  };

  const cached = readBinderCache(session.uid);
  if (cached) show(cached);
  else unmark();

  const read = sync || ((uid) => import('./binder-sync.js').then((mod) => mod.syncBinder(uid)));
  let started = false;
  const revalidate = () => {
    if (started) return;
    started = true;
    read(session.uid)
      .then((result) => {
        if (result?.kind === 'page') {
          if (!samePage(shown, result.page)) return show(result.page);
          return undefined;
        }
        if (result?.kind === 'empty' || result?.kind === 'signed-out') {
          // Empty collection, or Firebase says nobody is signed in here: the demo.
          generation += 1;
          painting = Promise.resolve();
          if (shown) restore(binder, demo);
          shown = null;
        }
        // 'error': keep whatever is painted.
        return undefined;
      })
      .catch(() => {})
      // The demo hold ends once the stored page is in (never while it is still loading).
      .finally(() => painting.then(unmark, unmark));
  };
  (whenIdle || ((fn) => setTimeout(fn, 1200)))(revalidate);
  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      revalidate();
    });
    observer.observe(binder);
  }
}
