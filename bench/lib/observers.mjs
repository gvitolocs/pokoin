// In-page instrumentation (installed with context.addInitScript) and the node-side
// reducers for what it records.
import { percentile } from './stats.mjs';

/**
 * Browser-side init script. Must stay self-contained: Playwright serialises it with
 * Function.prototype.toString, so it cannot reference anything outside its body.
 * Creates window.__bench (raw buffers) and window.__benchApi (watchers, snapshots).
 */
export function installBenchObservers(opts) {
  if (window.top !== window || window.__bench) return;
  const options = opts || {};
  const MAX_EVENTS = 20000;
  const B = {
    fcp: null,
    lcp: null,
    lcpSize: null,
    lcpTag: null,
    cls: 0,
    clsCount: 0,
    longtasks: [],
    loafs: [],
    events: [],
    first: {},
    supported: {},
    frames: null,
  };
  window.__bench = B;

  const describe = (el) => {
    if (!el || !el.tagName) return null;
    const cls = typeof el.className === 'string' && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '';
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}`;
  };

  const observe = (type, onEntry, extra) => {
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) onEntry(entry);
      });
      po.observe({ type, buffered: true, ...(extra || {}) });
      B.supported[type] = true;
    } catch {
      B.supported[type] = false;
    }
  };

  observe('paint', (e) => {
    if (e.name === 'first-contentful-paint') B.fcp = e.startTime;
  });
  observe('largest-contentful-paint', (e) => {
    B.lcp = e.startTime;
    B.lcpSize = e.size;
    B.lcpTag = describe(e.element);
  });
  observe('layout-shift', (e) => {
    if (e.hadRecentInput) return;
    B.cls += e.value;
    B.clsCount += 1;
  });
  observe('longtask', (e) => {
    B.longtasks.push({ start: e.startTime, duration: e.duration });
  });
  observe('long-animation-frame', (e) => {
    B.loafs.push({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration || 0 });
  });
  observe('event', (e) => {
    if (B.events.length >= MAX_EVENTS) return;
    B.events.push({
      name: e.name,
      start: e.startTime,
      duration: e.duration,
      interactionId: e.interactionId || 0,
      inputDelay: e.processingStart - e.startTime,
      processing: e.processingEnd - e.processingStart,
      presentation: e.startTime + e.duration - e.processingEnd,
    });
  }, { durationThreshold: 16 });

  // First time each configured selector exists in the DOM (vitals.firstTileMs etc.).
  const firstSelectors = { ...(options.firstSelectors || {}) };
  const firstTimeoutMs = options.firstTimeoutMs || 20000;
  const checkFirst = () => {
    const now = performance.now();
    for (const [key, sel] of Object.entries(firstSelectors)) {
      if (document.querySelector(sel)) {
        B.first[key] = now;
        delete firstSelectors[key];
      }
    }
    return Object.keys(firstSelectors).length === 0 || now > firstTimeoutMs;
  };
  if (Object.keys(firstSelectors).length) {
    const mo = new MutationObserver(() => {
      if (checkFirst()) mo.disconnect();
    });
    mo.observe(document, { childList: true, subtree: true });
  }

  // ---- watchers: start event (or "now") -> condition met on a rendered frame ----
  const START_TYPES = ['keydown', 'pointerdown', 'mousedown', 'touchstart'];
  const watchers = new Map();
  let nextId = 1;
  let loopOn = false;

  const finish = (w) => {
    if (w.done) return;
    w.done = true;
    const result = w.result();
    for (const resolve of w.waiters) resolve(result);
    w.waiters = [];
  };

  const tick = () => {
    const now = performance.now();
    let pending = false;
    for (const w of watchers.values()) {
      if (w.done) continue;
      try {
        if (w.startAt == null) {
          if (now - w.armedAt > w.noStartMs) {
            w.noStart = true;
            finish(w);
          }
        } else {
          w.check(now);
          if (!w.done && now - w.startAt > w.timeoutMs) {
            w.timedOut = true;
            finish(w);
          }
        }
      } catch (err) {
        w.error = String(err && err.message ? err.message : err);
        finish(w);
      }
      if (!w.done) pending = true;
    }
    if (pending) requestAnimationFrame(tick);
    else loopOn = false;
  };

  const ensureLoop = () => {
    if (loopOn) return;
    loopOn = true;
    requestAnimationFrame(tick);
  };

  for (const type of START_TYPES) {
    window.addEventListener(type, (ev) => {
      if (!ev.isTrusted) return;
      // Exclusive watchers: the oldest unstarted one claims the event. Shared watchers
      // see every event without consuming it, and may skip the first `skipEvents`.
      let claimed = false;
      for (const w of watchers.values()) {
        if (w.done || w.startAt != null || !w.startEvents.includes(ev.type)) continue;
        if (!w.shared && claimed) continue;
        if (w.shared && w.skipEvents > 0) {
          w.skipEvents -= 1;
          continue;
        }
        w.startAt = ev.timeStamp;
        w.startEvent = ev.type;
        if (w.onStart) w.onStart();
        if (!w.shared) claimed = true;
      }
    }, { capture: true, passive: true });
  }

  const register = (w, args) => {
    w.id = nextId;
    nextId += 1;
    w.armedAt = performance.now();
    w.startEvents = args.startEvents || ['pointerdown', 'mousedown', 'touchstart'];
    w.timeoutMs = args.timeoutMs || 5000;
    w.noStartMs = args.noStartMs || 5000;
    w.shared = Boolean(args.shared);
    w.skipEvents = args.skipEvents || 0;
    w.startAt = args.startNow ? w.armedAt : null;
    w.startEvent = args.startNow ? 'now' : null;
    w.timedOut = false;
    w.noStart = false;
    w.error = null;
    w.done = false;
    w.waiters = [];
    watchers.set(w.id, w);
    ensureLoop();
    return w.id;
  };

  const since = (w, at) => (at == null || w.startAt == null ? null : at - w.startAt);

  const rowsSignature = ({ selector, idAttr }) => {
    const els = document.querySelectorAll(selector);
    let sig = '';
    for (const el of els) {
      sig += `${(idAttr && el.getAttribute(idAttr)) || el.textContent.trim().slice(0, 80)}|`;
    }
    return { sig, count: els.length };
  };

  /** Rows watcher: first frame after the start event whose non-empty row list differs. */
  const armRows = (args) => {
    const w = {
      kind: 'rows',
      baseline: rowsSignature(args),
      changedAt: null,
      rows: null,
    };
    w.onStart = () => {
      w.baseline = rowsSignature(args);
    };
    w.check = (now) => {
      const cur = rowsSignature(args);
      if (cur.count > 0 && cur.sig !== w.baseline.sig) {
        w.changedAt = now;
        w.rows = cur.count;
        finish(w);
      }
    };
    w.result = () => ({
      id: w.id,
      kind: w.kind,
      startEvent: w.startEvent,
      ms: since(w, w.changedAt),
      rows: w.rows,
      baselineRows: w.baseline.count,
      timedOut: w.timedOut,
      noStart: w.noStart,
      error: w.error,
    });
    return register(w, args);
  };

  /** Card desk watcher: URL shows the card id -> heading painted -> main image decoded. */
  const armDesk = (args) => {
    const headingNow = document.querySelector(args.headingSel);
    const w = {
      kind: 'desk',
      expectId: String(args.expectId),
      prevHeading: headingNow ? headingNow.textContent.trim() : '',
      urlAt: null,
      headingAt: null,
      imageAt: null,
      imagePending: false,
      headingText: null,
    };
    const findFrame = () => {
      const frames = document.querySelectorAll(args.artFrameSel);
      let anyId = false;
      for (const frame of frames) {
        const id = frame.getAttribute('data-card-id');
        if (id) anyId = true;
        if (id === w.expectId) return frame;
      }
      return !anyId && frames.length ? frames[0] : null;
    };
    w.check = (now) => {
      if (w.urlAt == null && location.pathname.includes(`/cards/${w.expectId}`)) w.urlAt = now;
      if (w.urlAt == null) return;
      const frame = findFrame();
      if (w.headingAt == null) {
        const h = document.querySelector(args.headingSel);
        if (h && !h.querySelector(args.skeletonSel)) {
          const text = h.textContent.trim();
          if (text && (frame || !w.prevHeading || text !== w.prevHeading)) {
            w.headingAt = now;
            w.headingText = text.slice(0, 120);
          }
        }
      }
      if (w.headingAt != null && w.imageAt == null && !w.imagePending && frame) {
        const img = frame.querySelector('img');
        if (img && img.complete && img.naturalWidth > 0) {
          w.imagePending = true;
          const done = () => {
            if (w.imageAt == null) w.imageAt = performance.now();
            if (args.until !== 'heading') finish(w);
          };
          if (typeof img.decode === 'function') img.decode().then(done, done);
          else done();
        }
      }
      if (args.until === 'heading' && w.headingAt != null) finish(w);
    };
    w.result = () => ({
      id: w.id,
      kind: w.kind,
      startEvent: w.startEvent,
      urlMs: since(w, w.urlAt),
      headingMs: since(w, w.headingAt),
      imageMs: since(w, w.imageAt),
      heading: w.headingText,
      path: location.pathname,
      timedOut: w.timedOut,
      noStart: w.noStart,
      error: w.error,
    });
    return register(w, args);
  };

  /** Page watcher: path matches (exactPath / pathPrefix), readySel count >= minCount, absentSel gone. */
  const armPage = (args) => {
    const w = { kind: 'page', readyAt: null, scrollY: null, count: null };
    w.check = (now) => {
      if (args.exactPath && location.pathname.replace(/\/+$/, '') !== args.exactPath) return;
      if (args.pathPrefix && !location.pathname.startsWith(args.pathPrefix)) return;
      if (args.absentSel && document.querySelector(args.absentSel)) return;
      const count = document.querySelectorAll(args.readySel).length;
      if (count >= (args.minCount || 1)) {
        w.readyAt = now;
        w.count = count;
        w.scrollY = window.scrollY;
        finish(w);
      }
    };
    w.result = () => ({
      id: w.id,
      kind: w.kind,
      startEvent: w.startEvent,
      ms: since(w, w.readyAt),
      count: w.count,
      scrollY: w.scrollY,
      path: location.pathname,
      timedOut: w.timedOut,
      noStart: w.noStart,
      error: w.error,
    });
    return register(w, args);
  };

  const awaitWatcher = (id) => {
    const w = watchers.get(id);
    if (!w) return Promise.resolve({ id, error: 'unknown watcher (document replaced?)' });
    if (w.done) return Promise.resolve(w.result());
    return new Promise((resolve) => w.waiters.push(resolve));
  };

  const startFrames = () => {
    const state = { gaps: [], last: null, on: true };
    B.frames = state;
    const frame = (t) => {
      if (!state.on) return;
      if (state.last != null) state.gaps.push(Math.round((t - state.last) * 10) / 10);
      state.last = t;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    return true;
  };

  const stopFrames = () => {
    if (!B.frames) return [];
    B.frames.on = false;
    return B.frames.gaps;
  };

  const snapshot = (args) => {
    const from = (args && args.since) || 0;
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      now: performance.now(),
      fcp: B.fcp,
      lcp: B.lcp,
      lcpSize: B.lcpSize,
      lcpTag: B.lcpTag,
      cls: B.cls,
      clsCount: B.clsCount,
      nav: nav ? {
        ttfb: nav.responseStart,
        dcl: nav.domContentLoadedEventEnd,
        load: nav.loadEventEnd,
        type: nav.type,
        transferSize: nav.transferSize,
      } : null,
      longtasks: B.longtasks.filter((t) => t.start >= from),
      loafs: B.loafs.filter((t) => t.start >= from),
      events: B.events.filter((e) => e.start >= from),
      first: { ...B.first },
      supported: { ...B.supported },
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      url: location.href,
    };
  };

  window.__benchApi = {
    now: () => performance.now(),
    snapshot,
    rowsSignature,
    armRows,
    armDesk,
    armPage,
    awaitWatcher,
    startFrames,
    stopFrames,
  };
}

/** Worst interaction (INP for one journey) from recorded event-timing entries. */
export function computeInp(events) {
  const worst = new Map();
  for (const e of events || []) {
    if (!e.interactionId) continue;
    const cur = worst.get(e.interactionId);
    if (!cur || e.duration > cur.duration) worst.set(e.interactionId, e);
  }
  if (!worst.size) {
    return { inp: 0, inputDelay: null, processing: null, presentation: null, interactions: 0, name: null, all: [] };
  }
  let top = null;
  for (const e of worst.values()) {
    if (!top || e.duration > top.duration) top = e;
  }
  return {
    inp: top.duration,
    inputDelay: round1(top.inputDelay),
    processing: round1(top.processing),
    presentation: round1(top.presentation),
    interactions: worst.size,
    name: top.name,
    all: [...worst.values()].map((e) => e.duration),
  };
}

/** Long tasks starting inside [fromMs, toMs]. */
export function longTaskStats(tasks, fromMs = -Infinity, toMs = Infinity) {
  let count = 0;
  let totalMs = 0;
  let maxMs = 0;
  let blockingMs = 0;
  for (const t of tasks || []) {
    if (t.start < fromMs || t.start > toMs) continue;
    count += 1;
    totalMs += t.duration;
    maxMs = Math.max(maxMs, t.duration);
    blockingMs += Math.max(0, t.duration - 50);
  }
  return { count, totalMs: round1(totalMs), maxMs: round1(maxMs), blockingMs: round1(blockingMs) };
}

/** rAF gap statistics (ms between consecutive frames). */
export function frameStats(gaps) {
  const list = (gaps || []).filter((g) => Number.isFinite(g));
  const sorted = [...list].sort((a, b) => a - b);
  return {
    frames: list.length,
    over33: list.filter((g) => g > 33).length,
    over50: list.filter((g) => g > 50).length,
    maxGapMs: sorted.length ? sorted[sorted.length - 1] : null,
    p95GapMs: sorted.length ? round1(percentile(sorted, 95)) : null,
    meanGapMs: sorted.length ? round1(list.reduce((a, b) => a + b, 0) / list.length) : null,
  };
}

function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}
