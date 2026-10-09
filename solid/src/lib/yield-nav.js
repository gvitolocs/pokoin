/**
 * In-app navigations paint before the new route renders.
 *
 * Router 2 navigates inside the click, so the frame after a tile click waited
 * for the whole card desk (~150 ms of script, style and layout on a 4x-throttled
 * phone) and that render became the click's INP. Plain same-origin link clicks
 * that change the path are claimed here — after the components' own delegated
 * handlers, before the router's document listener — and navigate one painted
 * frame later. Programmatic navigations from clicks use `afterPaint` directly.
 */
let navigator = null;
let pending = 0;

/** Run `fn` after the next paint; a newer call supersedes an older pending one. */
export function afterPaint(fn) {
  const token = ++pending;
  const run = () => {
    if (token === pending) fn();
  };
  const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  if (visible && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => setTimeout(run, 0));
  } else {
    setTimeout(run, 0);
  }
}

/**
 * The router path for a click this module should claim, or '' to leave it to
 * the router. Same eligibility as the router's own anchor handler, plus: the
 * path must change (hash and query-only links stay synchronous and cheap).
 */
export function claimedPath(event, anchor, here) {
  if (!anchor || event.defaultPrevented || event.button !== 0) return '';
  if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return '';
  if (typeof anchor.href !== 'string' || anchor.target || anchor.hasAttribute('download')) return '';
  if (!anchor.hasAttribute('href')) return '';
  if ((anchor.getAttribute('rel') || '').split(/\s+/).includes('external')) return '';
  let url;
  try {
    url = new URL(anchor.href);
  } catch (_) {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (url.origin !== here.origin || url.pathname === here.pathname) return '';
  return url.pathname + url.search + url.hash;
}

function onClick(event) {
  if (!navigator) return;
  const anchor = event.composedPath().find((el) => el?.nodeName?.toUpperCase?.() === 'A' && !(el instanceof SVGElement));
  const path = claimedPath(event, anchor, window.location);
  if (!path) return;
  event.preventDefault();
  const state = anchor.getAttribute('state');
  const go = navigator;
  afterPaint(() => go(path, {
    resolve: false,
    replace: anchor.hasAttribute('replace'),
    scroll: !anchor.hasAttribute('noscroll'),
    state: state ? JSON.parse(state) : undefined,
  }));
}

/**
 * Call once before the router mounts: listeners on one target run in
 * registration order, so this one sits between Solid's delegated handlers
 * (registered when the component modules load) and the router's.
 */
export function installYieldingLinks() {
  if (typeof document === 'undefined') return;
  document.addEventListener('click', onClick);
}

/** The router's navigate (from the root layout); links are left alone until it is set. */
export function setLinkNavigator(fn) {
  navigator = fn;
}
