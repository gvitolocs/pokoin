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

function readAll() {
  try {
    const data = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch (_) {
    return {};
  }
}

export function readChatHistory(key) {
  const row = key ? readAll()[key] : null;
  const events = Array.isArray(row?.events) ? row.events.filter((event) => event?.id).slice(-CHAT_PAGE) : [];
  return {
    events,
    hasMore: events.length ? row.hasMore !== false : true,
  };
}

export function writeChatHistory(key, events, hasMore) {
  if (!key) return;
  const all = readAll();
  all[key] = {
    events: (events || []).filter((event) => event?.id).slice(-CHAT_PAGE),
    hasMore: Boolean(hasMore),
    savedAt: Date.now(),
  };
  const kept = Object.entries(all)
    .sort((a, b) => (b[1]?.savedAt || 0) - (a[1]?.savedAt || 0))
    .slice(0, MAX_THREADS);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch (_) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify({ [key]: all[key] }));
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
