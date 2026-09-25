import { timestampMs } from './chat-format.js';

const HISTORY_KEY = 'pokoin.chatHistory';
export const CHAT_PAGE = 100;
const MAX_THREADS = 8;

export function historyKey({ peerUid = '', peer = '' } = {}) {
  const uid = String(peerUid || '').trim();
  if (uid) return `uid:${uid}`;
  const name = String(peer || '').trim().toLowerCase();
  return name ? `name:${name}` : '';
}

function emptyStore() {
  return { threads: {}, names: {} };
}

function readAll() {
  try {
    const data = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
    if (!data || typeof data !== 'object') return emptyStore();
    if (data.threads && typeof data.threads === 'object') {
      return { threads: data.threads, names: data.names && typeof data.names === 'object' ? data.names : {} };
    }
    const threads = {};
    const names = {};
    for (const [key, row] of Object.entries(data)) {
      if (!row || typeof row !== 'object') continue;
      threads[key] = row;
      if (key.startsWith('name:')) names[key.slice(5)] = key;
    }
    return { threads, names };
  } catch (_) {
    return emptyStore();
  }
}

function unpack(row) {
  const events = Array.isArray(row?.events) ? row.events.filter((event) => event?.id).slice(-CHAT_PAGE) : [];
  return {
    events,
    hasMore: events.length ? row.hasMore !== false : true,
  };
}

export function readChatHistory(key) {
  if (!key) return { events: [], hasMore: true };
  const all = readAll();
  if (key.startsWith('name:')) {
    const aliased = all.names[key.slice(5)];
    if (aliased && all.threads[aliased]) return unpack(all.threads[aliased]);
  }
  return unpack(all.threads[key]);
}

export function writeChatHistory(key, events, hasMore, link = {}) {
  if (!key) return;
  const all = readAll();
  const uid = String(link.peerUid || (key.startsWith('uid:') ? key.slice(4) : '')).trim();
  const username = String(link.username || (key.startsWith('name:') ? key.slice(5) : '')).trim().toLowerCase();
  const threadKey = uid ? `uid:${uid}` : key;
  all.threads[threadKey] = {
    events: (events || []).filter((event) => event?.id).slice(-CHAT_PAGE),
    hasMore: Boolean(hasMore),
    savedAt: Date.now(),
    username,
  };
  if (username) all.names[username] = threadKey;
  const kept = Object.entries(all.threads)
    .sort((a, b) => (b[1]?.savedAt || 0) - (a[1]?.savedAt || 0))
    .slice(0, MAX_THREADS);
  const threads = Object.fromEntries(kept);
  const names = {};
  for (const [name, savedKey] of Object.entries(all.names)) {
    if (threads[savedKey]) names[name] = savedKey;
  }
  const store = { threads, names };
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(store));
  } catch (_) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify({
        threads: { [threadKey]: all.threads[threadKey] },
        names: username ? { [username]: threadKey } : {},
      }));
    } catch (_) {
      /* private mode or a full disk */
    }
  }
}

/** `incoming` replaces an event with the same id. Order is oldest first. */
export function mergeChatEvents(base, incoming) {
  const map = new Map();
  for (const event of base || []) {
    if (event?.id) map.set(event.id, event);
  }
  for (const event of incoming || []) {
    if (event?.id) map.set(event.id, event);
  }
  return [...map.values()].sort((a, b) => {
    const delta = timestampMs(a.createdAt) - timestampMs(b.createdAt);
    return delta || String(a.id).localeCompare(String(b.id));
  });
}

export function pageHasMore(result) {
  if (typeof result?.hasMore === 'boolean') return result.hasMore;
  return (result?.events || []).length >= CHAT_PAGE;
}

export function nearChatTop(scrollTop, threshold = 48) {
  return Number(scrollTop) <= threshold;
}
