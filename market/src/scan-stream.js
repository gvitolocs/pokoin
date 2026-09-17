// Scan batch change stream over fetch (EventSource cannot send Authorization).
// The server closes every stream after ~55 s; we reconnect with the cursor, so
// duplicates and replays are harmless (rows carry `seq`). docs/SCAN_CONNECT.md.

export function createSseParser(onEvent) {
  let buffer = '';
  return function feed(text) {
    buffer += text;
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let name = 'message';
      const data = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event: ')) name = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      if (data.length) {
        try {
          onEvent(name, JSON.parse(data.join('\n')));
        } catch (_) {
          // a malformed frame is dropped; the next reconnect replays from cursor
        }
      }
      index = buffer.indexOf('\n\n');
    }
  };
}

export function backoffMs(attempt, random = Math.random) {
  const base = Math.min(8000, 400 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.75 + random() * 0.5));
}

/**
 * connectScanStream({ batchId, urlFor, getToken, onEvent, onStatus })
 * onStatus: 'connecting' | 'live' | 'reconnecting' | 'gone'
 */
export function connectScanStream({
  batchId,
  urlFor,
  getToken,
  onEvent,
  onStatus = () => {},
  fetchImpl = (...args) => fetch(...args),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  initialCursor = 0,
}) {
  let cursor = initialCursor;
  let stopped = false;
  let controller = null;
  let attempt = 0;

  const handle = (name, data) => {
    if (name === 'items' && Number.isFinite(Number(data?.cursor))) {
      cursor = Math.max(cursor, Number(data.cursor));
    }
    onEvent(name, data);
  };

  (async () => {
    let forceToken = false;
    while (!stopped) {
      onStatus(attempt ? 'reconnecting' : 'connecting');
      controller = new AbortController();
      let status = 0;
      try {
        const token = await getToken(forceToken);
        forceToken = false;
        const res = await fetchImpl(urlFor(batchId, cursor), {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: controller.signal,
          cache: 'no-store',
        });
        status = res.status;
        if (status === 404) {
          onStatus('gone');
          return;
        }
        if (status === 401) {
          forceToken = true;
          throw new Error('auth');
        }
        if (!res.ok || !res.body) throw new Error(`stream ${status}`);
        onStatus('live');
        attempt = 0;
        const feed = createSseParser(handle);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          feed(decoder.decode(value, { stream: true }));
        }
        // Normal end (server lifetime): reconnect right away from the cursor.
        continue;
      } catch (error) {
        if (stopped) return;
        attempt += 1;
        onStatus('reconnecting');
        await sleep(backoffMs(attempt - 1));
      }
    }
  })();

  return {
    stop() {
      stopped = true;
      controller?.abort();
    },
    get cursor() {
      return cursor;
    },
  };
}
