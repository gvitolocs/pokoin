// Recover from a missing /market/s/* chunk after a release.
//
// Every build renames the hashed chunks. Deploys carry the last two releases'
// chunks (scripts/carry-web-release-chunks.mjs), so open tabs and the old shell
// some edges serve for a minute after a deploy keep working. This covers what
// is still missing: a dynamic import, the entry module, or a stylesheet fails,
// and the page would stay blank. Refetch the failed file, and every
// /market/s/* file Resource Timing reports as failed, past the HTTP cache (a
// 404 under /market/s/* carries the year-long immutable header, so the
// browser would keep it), then reload once they are all reachable or a newer
// shell is live. sessionStorage allows one reload a minute, so a broken
// release ends on the route error instead of a reload loop.
//
// A classic script in <head>, ahead of the module entry: it must run even
// when the entry chunk itself 404s.
var CHUNK_RELOAD_KEY = "pokoin:chunk-reload-at";
var CHUNK_RELOAD_GUARD_MS = 60000;
var CHUNK_RELOAD_RETRY_MS = 10000;
var CHUNK_RELOAD_TRIES = 6;
var CHUNK_URL_RE = /(?:https?:\/\/[^\s"'`()]+)?\/market\/s\/[^\s"'`()?#]+/;
var CHUNK_ERROR_RE = /dynamically imported module|Importing a module script failed|Unable to preload CSS|Failed to load module script/i;

/** The /market/s/* path a failure names, or "". */
function chunkPath(value) {
  var text = typeof value === "string" ? value : String((value && (value.message || value.payload)) || value || "");
  var match = text.match(CHUNK_URL_RE);
  if (!match) return "";
  var at = match[0].indexOf("/market/s/");
  return match[0].slice(at);
}

/** Whether an error or rejection reason is a failed chunk load. */
function isChunkLoadError(value) {
  var text = typeof value === "string" ? value : String((value && value.message) || value || "");
  return CHUNK_ERROR_RE.test(text) || Boolean(chunkPath(text));
}

function installChunkReload(win) {
  var doc = win.document;
  var busy = false;
  // The default 250-entry buffer fills on image-heavy pages before a late
  // chunk fails, and failedChunks() would not see it.
  try {
    if (win.performance && win.performance.setResourceTimingBufferSize) {
      win.performance.setResourceTimingBufferSize(1000);
    }
  } catch (_) { /* optional */ }

  function reloadedRecently(now) {
    try {
      var at = Number(win.sessionStorage.getItem(CHUNK_RELOAD_KEY)) || 0;
      return at > 0 && now >= at && now - at < CHUNK_RELOAD_GUARD_MS;
    } catch (_) {
      return true; // no storage, no guard: never reload
    }
  }

  function reload() {
    try {
      win.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
    } catch (_) {
      return;
    }
    win.location.reload();
  }

  function entryPath(html) {
    var match = String(html || "").match(/<script\b[^>]*type="module"[^>]*src="([^"]*\/market\/s\/[^"]+)"/);
    return match ? chunkPath(match[1]) : "";
  }

  function ownEntry() {
    var script = doc && doc.querySelector && doc.querySelector('script[type="module"][src*="/market/s/"]');
    return script ? chunkPath(script.getAttribute("src") || script.src || "") : "";
  }

  /**
   * /market/s/* files this page got a failed or unknown answer for. The error
   * names the chunk import() asked for, but the 404 can be a static
   * dependency of it, still cached after the reload. Known failures refetch
   * in full; an unknown status (Safari has no responseStatus, Chrome reports
   * 0 for some cache hits) revalidates, which is a 304 for a good chunk.
   */
  function failedChunks() {
    var perf = win.performance;
    var entries = [];
    try {
      entries = (perf && perf.getEntriesByType && perf.getEntriesByType("resource")) || [];
    } catch (_) {
      entries = [];
    }
    var rows = [];
    for (var i = 0; i < entries.length; i += 1) {
      var path = chunkPath(entries[i].name || "");
      if (!path) continue;
      var status = entries[i].responseStatus;
      var known = typeof status === "number" && status > 0;
      if (known && status >= 200 && status < 400) continue;
      rows.push({ path: path, cache: known ? "reload" : "no-cache" });
    }
    return rows;
  }

  function fetchOk(row) {
    return win.fetch(row.path, { cache: row.cache, credentials: "same-origin" })
      .then(function (res) { return res.ok; }, function () { return false; });
  }

  /** Refetch the failed chunk and every failed file of this page; true when all answer 200. */
  function reachable(path) {
    var rows = path ? [{ path: path, cache: "reload" }] : [];
    var seen = {};
    if (path) seen[path] = true;
    var failed = failedChunks();
    for (var i = 0; i < failed.length; i += 1) {
      if (seen[failed[i].path]) continue;
      seen[failed[i].path] = true;
      rows.push(failed[i]);
    }
    if (!rows.length) return Promise.resolve(false);
    return Promise.all(rows.map(fetchOk)).then(function (oks) {
      for (var j = 0; j < oks.length; j += 1) if (!oks[j]) return false;
      return true;
    });
  }

  function liveEntry() {
    return win.fetch("/market/app", { cache: "no-store", credentials: "same-origin" })
      .then(function (res) { return res.ok ? res.text() : ""; })
      .then(entryPath, function () { return ""; });
  }

  function attempt(path, tries) {
    reachable(path).then(function (ok) {
      if (ok) return reload();
      return liveEntry().then(function (live) {
        if (live && live !== ownEntry()) return reload();
        if (tries + 1 >= CHUNK_RELOAD_TRIES) return reload();
        win.setTimeout(function () { attempt(path, tries + 1); }, CHUNK_RELOAD_RETRY_MS);
      });
    });
  }

  /** Start recovering from a failed chunk. True while a reload is pending. */
  function recover(failure) {
    if (busy) return true;
    if (win.navigator && win.navigator.onLine === false) return false;
    if (reloadedRecently(Date.now())) return false;
    busy = true;
    attempt(chunkPath(failure), 0);
    return true;
  }

  win.__pokoinChunkReload = function (failure) {
    return isChunkLoadError(failure) ? recover(failure) : false;
  };
  // Vite's preload helper: a lazy route or a dependency of it failed.
  win.addEventListener("vite:preloadError", function (event) {
    recover(event.payload || "");
  });
  // The entry module, a modulepreload, or a stylesheet 404d. Prefetches are
  // only hints and do not break the page.
  win.addEventListener("error", function (event) {
    var el = event && event.target;
    if (!el || el === win || !el.tagName) return;
    var tag = String(el.tagName).toUpperCase();
    var rel = String(el.rel || "").toLowerCase();
    if (tag !== "SCRIPT" && !(tag === "LINK" && (rel === "stylesheet" || rel === "modulepreload"))) return;
    var path = chunkPath(el.src || el.href || "");
    if (path) recover(path);
  }, true);
  // A bare import() outside Vite's helper.
  win.addEventListener("unhandledrejection", function (event) {
    if (event && isChunkLoadError(event.reason)) recover(event.reason);
  });
}

if (typeof window !== "undefined" && window.addEventListener) {
  installChunkReload(window);
}
