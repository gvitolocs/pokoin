// Chrome DevTools Protocol helpers: throttling, Performance.getMetrics, heap sampling
// and a network tracker that tells real downloads apart from cache hits.

/** Opens a CDP session on the page and applies CPU / network emulation. */
export async function openCdp(page, { cpuThrottle = 1, net = null } = {}) {
  const session = await page.context().newCDPSession(page);
  const network = createNetworkTracker(session);
  await session.send('Network.enable');
  await session.send('Performance.enable', { timeDomain: 'timeTicks' });
  if (cpuThrottle > 1) {
    await session.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
  }
  if (net) {
    await session.send('Network.emulateNetworkConditions', net);
  }

  async function metrics() {
    const { metrics: list } = await session.send('Performance.getMetrics');
    return Object.fromEntries(list.map((m) => [m.name, m.value]));
  }

  /** Samples JSHeapUsedSize every intervalMs; stop() resolves to { peak } in bytes. */
  function startHeapSampler(intervalMs = 500) {
    let peak = 0;
    let inFlight = null;
    const sample = async () => {
      try {
        const m = await metrics();
        peak = Math.max(peak, m.JSHeapUsedSize || 0);
      } catch {
        // page closed or navigating: skip this sample
      }
    };
    const timer = setInterval(() => {
      if (!inFlight) inFlight = sample().finally(() => { inFlight = null; });
    }, intervalMs);
    return {
      async stop() {
        clearInterval(timer);
        if (inFlight) await inFlight;
        await sample();
        return { peak };
      },
    };
  }

  async function close() {
    try {
      await session.detach();
    } catch {
      // already gone with its context
    }
  }

  return { session, network, metrics, startHeapSampler, close };
}

/** Records every request the page target makes, in order. */
function createNetworkTracker(session) {
  const records = [];
  const byId = new Map();
  let wsFrames = 0;

  session.on('Network.requestWillBeSent', (e) => {
    const prev = byId.get(e.requestId);
    if (prev && e.redirectResponse) {
      prev.status = e.redirectResponse.status;
      prev.finished = true;
      prev.redirect = true;
      prev.redirectTo = e.request.url;
      prev.encodedBytes = e.redirectResponse.encodedDataLength || 0;
    }
    const rec = {
      id: e.requestId,
      url: e.request.url,
      method: e.request.method,
      type: e.type || 'Other',
      status: null,
      finished: false,
      failed: false,
      canceled: false,
      encodedBytes: 0,
      fromMemoryCache: false,
      fromDiskCache: false,
      fromServiceWorker: false,
      fromPrefetchCache: false,
    };
    records.push(rec);
    byId.set(e.requestId, rec);
  });
  session.on('Network.requestServedFromCache', (e) => {
    const rec = byId.get(e.requestId);
    if (rec) rec.fromMemoryCache = true;
  });
  session.on('Network.responseReceived', (e) => {
    const rec = byId.get(e.requestId);
    if (!rec) return;
    const res = e.response;
    rec.status = res.status;
    rec.type = e.type || rec.type;
    rec.mimeType = res.mimeType;
    if (res.fromDiskCache) rec.fromDiskCache = true;
    if (res.fromServiceWorker) rec.fromServiceWorker = true;
    if (res.fromPrefetchCache) rec.fromPrefetchCache = true;
  });
  session.on('Network.loadingFinished', (e) => {
    const rec = byId.get(e.requestId);
    if (!rec) return;
    rec.finished = true;
    rec.encodedBytes = e.encodedDataLength || 0;
  });
  session.on('Network.loadingFailed', (e) => {
    const rec = byId.get(e.requestId);
    if (!rec) return;
    rec.failed = true;
    rec.canceled = Boolean(e.canceled);
    rec.errorText = e.errorText;
  });
  session.on('Network.webSocketFrameReceived', () => {
    wsFrames += 1;
  });

  return {
    records,
    mark: () => ({ seq: records.length, wsFrames }),
    since: (mark) => records.slice(mark ? mark.seq : 0),
    wsFramesSince: (mark) => wsFrames - (mark ? mark.wsFrames : 0),
  };
}

function isApiUrl(url, apiMatch) {
  if (apiMatch.hosts && apiMatch.hosts.includes(url.hostname)) return true;
  return Boolean(apiMatch.pathPrefix && url.pathname.startsWith(apiMatch.pathPrefix));
}

/** Pure reduction of tracker records (one measured window). */
export function summarizeNetwork(records, apiMatch = { hosts: [], pathPrefix: '/api/' }) {
  const out = {
    requests: 0,
    downloads: 0,
    cached: 0,
    failed: 0,
    canceled: 0,
    pending: 0,
    redirects: 0,
    zeroByte: 0,
    bytes: 0,
    apiCalls: 0,
    imageDownloads: 0,
    imageBytes: 0,
    duplicateDownloads: 0,
    bytesByType: {},
    downloadsByType: {},
    apiByPath: {},
    duplicateUrls: [],
    redirectSamples: [],
  };
  const downloadedUrls = new Map();
  for (const rec of records) {
    if (/^(data|blob|about|chrome-extension):/.test(rec.url)) continue;
    out.requests += 1;
    let url = null;
    try {
      url = new URL(rec.url);
    } catch {
      url = null;
    }
    if (url && isApiUrl(url, apiMatch)) {
      out.apiCalls += 1;
      out.apiByPath[url.pathname] = (out.apiByPath[url.pathname] || 0) + 1;
    }
    if (rec.failed) {
      out.failed += 1;
      if (rec.canceled) out.canceled += 1;
      continue;
    }
    if (rec.redirect) {
      out.redirects += 1;
      if (out.redirectSamples.length < 5) out.redirectSamples.push({ url: rec.url, to: rec.redirectTo, status: rec.status });
      continue;
    }
    if (rec.fromMemoryCache || rec.fromDiskCache || rec.fromServiceWorker || rec.fromPrefetchCache) {
      out.cached += 1;
      continue;
    }
    if (!rec.finished) {
      out.pending += 1;
      continue;
    }
    // Nothing crossed the network (e.g. a redirect target joined an in-flight or cached
    // entry without a cache flag): count it as cached, not as a download.
    if (!(rec.encodedBytes > 0)) {
      out.cached += 1;
      out.zeroByte += 1;
      continue;
    }
    const type = rec.type || 'Other';
    const bytes = rec.encodedBytes || 0;
    out.downloads += 1;
    out.bytes += bytes;
    out.bytesByType[type] = (out.bytesByType[type] || 0) + bytes;
    out.downloadsByType[type] = (out.downloadsByType[type] || 0) + 1;
    if (type === 'Image') {
      out.imageDownloads += 1;
      out.imageBytes += bytes;
    }
    downloadedUrls.set(rec.url, (downloadedUrls.get(rec.url) || 0) + 1);
  }
  for (const [url, count] of downloadedUrls) {
    if (count < 2) continue;
    out.duplicateDownloads += count - 1;
    out.duplicateUrls.push({ url, count });
  }
  out.duplicateUrls.sort((a, b) => b.count - a.count);
  out.duplicateUrls = out.duplicateUrls.slice(0, 20);
  return out;
}
