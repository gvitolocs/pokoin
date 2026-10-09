// Measurement windows and page helpers shared by every journey.
import { performance } from 'node:perf_hooks';
import { API_MATCH, CARD_ID_RE, SELECTORS, TIMING } from '../config.mjs';
import { computeInp, longTaskStats } from './observers.mjs';
import { summarizeNetwork } from './cdp.mjs';

const MB = 1048576;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Node-side monotonic clock (ms). */
export const wallNow = () => performance.now();

function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

/** Page-side performance.now(); 0 when the page has no document yet. */
export async function pageNow(page) {
  try {
    return await page.evaluate(() => performance.now());
  } catch {
    return 0;
  }
}

/** Raw buffers from the init script, filtered to entries starting at or after `since`. */
export async function snapshot(page, since = 0) {
  const snap = await page.evaluate(
    (from) => (window.__benchApi ? window.__benchApi.snapshot({ since: from }) : null),
    since,
  );
  return snap || {
    now: 0, fcp: null, lcp: null, cls: 0, nav: null, longtasks: [], loafs: [], events: [],
    first: {}, supported: {}, scrollY: 0, scrollHeight: 0, innerHeight: 0, url: page.url(),
  };
}

/**
 * Starts a measured window. With newDocument the page-side window starts at 0 of the
 * document that is about to load (cold/warm), otherwise at the current page time.
 */
export async function beginWindow(page, cdp, { newDocument = false } = {}) {
  const t0 = newDocument ? 0 : await pageNow(page);
  const m0 = await cdp.metrics();
  return {
    t0,
    m0,
    netMark: cdp.network.mark(),
    heap: cdp.startHeapSampler(TIMING.heapSampleMs),
    wall0: wallNow(),
  };
}

/** Ends a window: CPU deltas, memory, long tasks, network and (optionally) INP. */
export async function endWindow(page, cdp, handle, { interactive = false } = {}) {
  const heap = await handle.heap.stop();
  const m1 = await cdp.metrics();
  const snap = await snapshot(page, handle.t0);
  const metrics = {};
  // Counters reset if the renderer process was swapped: then the end value is the delta.
  const delta = (key) => {
    const a = handle.m0[key] || 0;
    const b = m1[key] || 0;
    return round1((b >= a ? b - a : b) * 1000);
  };
  metrics['wall.ms'] = round1(wallNow() - handle.wall0);
  metrics['cpu.scriptMs'] = delta('ScriptDuration');
  metrics['cpu.taskMs'] = delta('TaskDuration');
  metrics['cpu.layoutMs'] = delta('LayoutDuration');
  metrics['cpu.recalcStyleMs'] = delta('RecalcStyleDuration');
  metrics['mem.heapEndMB'] = round1((m1.JSHeapUsedSize || 0) / MB);
  metrics['mem.heapPeakMB'] = round1(Math.max(heap.peak, m1.JSHeapUsedSize || 0) / MB);
  metrics['dom.nodes'] = m1.Nodes ?? null;

  const lt = longTaskStats(snap.longtasks, handle.t0);
  metrics['lt.count'] = lt.count;
  metrics['lt.totalMs'] = lt.totalMs;
  metrics['lt.maxMs'] = lt.maxMs;
  metrics['lt.blockingMs'] = lt.blockingMs;
  if (snap.supported['long-animation-frame']) {
    metrics['loaf.count'] = snap.loafs.length;
    metrics['loaf.blockingMs'] = round1(snap.loafs.reduce((sum, f) => sum + (f.blocking || 0), 0));
  }

  const net = summarizeNetwork(cdp.network.since(handle.netMark), API_MATCH);
  metrics['net.requests'] = net.requests;
  metrics['net.downloads'] = net.downloads;
  metrics['net.cached'] = net.cached;
  metrics['net.failed'] = net.failed;
  metrics['net.canceled'] = net.canceled;
  metrics['net.redirects'] = net.redirects;
  metrics['net.bytes'] = net.bytes;
  metrics['net.apiCalls'] = net.apiCalls;
  metrics['net.imageDownloads'] = net.imageDownloads;
  metrics['net.imageBytes'] = net.imageBytes;
  metrics['net.duplicateDownloads'] = net.duplicateDownloads;
  metrics['net.wsFrames'] = cdp.network.wsFramesSince(handle.netMark);
  for (const [type, bytes] of Object.entries(net.bytesByType)) {
    metrics[`net.bytes.${type}`] = bytes;
  }

  const detail = {
    apiByPath: net.apiByPath,
    bytesByType: net.bytesByType,
    downloadsByType: net.downloadsByType,
    duplicateUrls: net.duplicateUrls,
    redirectSamples: net.redirectSamples,
  };

  if (interactive) {
    const inp = computeInp(snap.events);
    metrics.inp = inp.inp;
    metrics['inp.inputDelay'] = inp.inputDelay;
    metrics['inp.processing'] = inp.processing;
    metrics['inp.presentation'] = inp.presentation;
    metrics['inp.interactions'] = inp.interactions;
    metrics['inp.all'] = inp.all;
    detail.worstInteraction = inp.name
      ? { name: inp.name, duration: inp.inp, inputDelay: inp.inputDelay, processing: inp.processing, presentation: inp.presentation }
      : null;
  }
  return { metrics, detail, snap };
}

/** Navigation vitals of the current document plus TBT over [FCP, load + coldTailMs]. */
export async function loadMetrics(page) {
  const snap = await snapshot(page, 0);
  const nav = snap.nav || {};
  const loadEnd = nav.load || snap.now;
  const tbt = longTaskStats(snap.longtasks, snap.fcp ?? 0, loadEnd + TIMING.coldTailMs);
  return {
    metrics: {
      'vitals.ttfb': round1(nav.ttfb),
      'vitals.fcp': round1(snap.fcp),
      'vitals.lcp': round1(snap.lcp),
      'vitals.cls': Number.isFinite(snap.cls) ? Math.round(snap.cls * 10000) / 10000 : null,
      'vitals.dcl': round1(nav.dcl),
      'vitals.load': round1(nav.load),
      'vitals.firstTileMs': round1(snap.first.tile),
      'vitals.appReadyMs': round1(snap.first.appReady),
      tbt: tbt.blockingMs,
    },
    detail: {
      lcpElement: snap.lcpTag,
      lcpSize: snap.lcpSize,
      navType: nav.type || null,
      documentTransferSize: nav.transferSize ?? null,
      observersSupported: snap.supported,
    },
  };
}

/** Waits until `tailMs` after the document's load event (page clock). */
export async function waitLoadTail(page, tailMs) {
  const t = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    return { now: performance.now(), load: nav ? nav.loadEventEnd : 0 };
  });
  const remaining = (t.load || t.now) + tailMs - t.now;
  if (remaining > 0) await sleep(remaining);
}

export async function settle(page, ms) {
  await page.waitForTimeout(ms);
}

/** page.goto with the suite's defaults. */
export async function gotoPath(env, page, path) {
  await page.goto(`${env.base}${path}`, { waitUntil: 'load', timeout: TIMING.gotoTimeoutMs });
}

/** Resolves when at least `min` elements match `selector`. */
export async function waitForCount(page, selector, min, timeout = TIMING.readyTimeoutMs) {
  await page.waitForFunction(
    ({ sel, n }) => document.querySelectorAll(sel).length >= n,
    { sel: selector, n: min },
    { timeout, polling: 100 },
  );
}

/** Card id from a tile href or desk URL. */
export function cardIdFromHref(href) {
  const match = String(href || '').match(CARD_ID_RE);
  return match ? decodeURIComponent(match[1]) : null;
}

// ---- watcher wrappers (see installBenchObservers) ----

export function armRows(page, { startEvents = ['keydown'], timeoutMs = TIMING.rowsTimeoutMs } = {}) {
  return page.evaluate((args) => window.__benchApi.armRows(args), {
    selector: SELECTORS.suggestRows,
    idAttr: SELECTORS.suggestRowId,
    startEvents,
    timeoutMs,
  });
}

/**
 * Arms `count` rows watchers in one round trip, before any key is sent, so typing
 * never waits on page.evaluate. Each keydown claims the oldest unstarted watcher.
 */
export function armRowsMany(page, count, { timeoutMs = TIMING.rowsTimeoutMs } = {}) {
  return page.evaluate(({ n, args }) => Array.from({ length: n }, () => window.__benchApi.armRows(args)), {
    n: count,
    args: {
      selector: SELECTORS.suggestRows,
      idAttr: SELECTORS.suggestRowId,
      startEvents: ['keydown'],
      timeoutMs,
      noStartMs: 120000,
    },
  });
}

/**
 * Shared rows watchers for a typed burst of `count` keys: first keydown -> first rows
 * change, and last keydown -> rows change, both with a long budget (not capped at 1.5 s).
 */
export function armBurstRows(page, count, { timeoutMs = 10000 } = {}) {
  const base = {
    selector: SELECTORS.suggestRows,
    idAttr: SELECTORS.suggestRowId,
    startEvents: ['keydown'],
    timeoutMs,
    noStartMs: 120000,
    shared: true,
  };
  return page.evaluate(({ args, skip }) => ({
    first: window.__benchApi.armRows(args),
    last: window.__benchApi.armRows({ ...args, skipEvents: skip }),
  }), { args: base, skip: Math.max(0, count - 1) });
}

/** Page watcher started "now" followed by history.back() in the same task. */
export async function historyBack(page, args) {
  try {
    const id = await page.evaluate((a) => {
      const wid = window.__benchApi.armPage({ ...a, startNow: true });
      window.history.back();
      return wid;
    }, { timeoutMs: TIMING.navTimeoutMs, ...args });
    return await awaitWatcher(page, id);
  } catch (err) {
    return { ms: null, error: `history.back left the document: ${err.message}` };
  }
}

/** Page watcher started by the next pointer/touch/key event. */
export function armPage(page, args) {
  return page.evaluate((a) => window.__benchApi.armPage(a), {
    timeoutMs: TIMING.navTimeoutMs,
    startEvents: ['pointerdown', 'mousedown', 'touchstart', 'keydown'],
    ...args,
  });
}

export function armDesk(page, expectId,{ until = 'image', startNow = false, timeoutMs = TIMING.navTimeoutMs } = {}) {
  return page.evaluate((args) => window.__benchApi.armDesk(args), {
    expectId,
    until,
    startNow,
    timeoutMs,
    startEvents: ['pointerdown', 'mousedown', 'touchstart'],
    headingSel: SELECTORS.deskHeading,
    skeletonSel: SELECTORS.deskSkeleton,
    artFrameSel: SELECTORS.deskArtFrame,
  });
}

export function awaitWatcher(page, id) {
  return page.evaluate((wid) => window.__benchApi.awaitWatcher(wid), id);
}

/** Current suggestion rows: { sig, count }. */
export function rowsSignature(page) {
  return page.evaluate(
    (args) => window.__benchApi.rowsSignature(args),
    { selector: SELECTORS.suggestRows, idAttr: SELECTORS.suggestRowId },
  );
}

/** Waits until the suggestion rows are non-empty and unchanged for stableMs. */
export async function waitRowsStable(page, stableMs = TIMING.rowsStableMs, maxMs = 10000) {
  const start = wallNow();
  let last = null;
  let since = wallNow();
  while (wallNow() - start < maxMs) {
    const cur = await rowsSignature(page);
    if (!last || cur.sig !== last.sig) {
      last = cur;
      since = wallNow();
    } else if (cur.count > 0 && wallNow() - since >= stableMs) {
      return cur;
    }
    await sleep(100);
  }
  return last;
}
