/**
 * Bounded decode cache for the search popup.
 * Thumbs are `_homepage.webp` (same URL as left mini + right crop).
 * Hover leftover JPEGs are not cached — CardArt loads the one scan on enter.
 */

export const SUGGEST_THUMB_CACHE = 128;
export const SUGGEST_PRELOAD_INFLIGHT = 4;
export const SUGGEST_THUMB_EAGER = 8;
export const SUGGEST_THUMB_HIGH = 4;

const thumbs = new Map();
const queued = [];
const inflight = new Set();

export function resetSuggestImages() {
  thumbs.clear();
  queued.length = 0;
  inflight.clear();
}

function touch(url) {
  if (thumbs.has(url)) {
    thumbs.delete(url);
  }
  while (thumbs.size >= SUGGEST_THUMB_CACHE) {
    thumbs.delete(thumbs.keys().next().value);
  }
  thumbs.set(url, true);
}

function trimQueue(keepHead) {
  if (queued.length <= SUGGEST_THUMB_CACHE) {
    return;
  }
  if (keepHead) {
    queued.length = SUGGEST_THUMB_CACHE;
    return;
  }
  queued.splice(0, queued.length - SUGGEST_THUMB_CACHE);
}

function pumpThumbs() {
  while (inflight.size < SUGGEST_PRELOAD_INFLIGHT && queued.length) {
    const url = queued.shift();
    if (!url || thumbs.has(url) || inflight.has(url)) {
      continue;
    }
    inflight.add(url);
    const img = new Image();
    img.decoding = 'async';
    img.fetchPriority = 'low';
    const done = () => {
      inflight.delete(url);
      touch(url);
      pumpThumbs();
    };
    img.onload = done;
    img.onerror = done;
    img.src = url;
  }
}

function settleWithoutImage() {
  while (queued.length) {
    const url = queued.shift();
    if (url) {
      touch(url);
    }
  }
}

export function collectPrintingThumbUrls(groups, thumbSrc) {
  const urls = [];
  const seen = new Set();
  for (const group of groups || []) {
    for (const printing of group.printings || []) {
      const url = String(thumbSrc?.(printing) || '').trim();
      if (!url || seen.has(url)) {
        continue;
      }
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

export function preloadSuggestThumbs(urls, { first = false } = {}) {
  let added = 0;
  const incoming = [];
  const seen = new Set();
  for (const raw of urls || []) {
    const url = String(raw || '').trim();
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    if (thumbs.has(url)) {
      touch(url);
      continue;
    }
    if (inflight.has(url) || queued.includes(url) || incoming.includes(url)) {
      continue;
    }
    incoming.push(url);
    added += 1;
  }
  if (first) {
    queued.unshift(...incoming);
  } else {
    queued.push(...incoming);
  }
  trimQueue(first);
  if (typeof Image === 'undefined') {
    settleWithoutImage();
  } else {
    pumpThumbs();
  }
  return { queued: added, cached: thumbs.size };
}

export function suggestThumbCached(url) {
  return thumbs.has(String(url || '').trim());
}

export function suggestImageStats() {
  return {
    thumbs: thumbs.size,
    queued: queued.length,
    inflight: inflight.size,
  };
}
