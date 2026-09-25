import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getConversation } from './chat-client.js';
import {
  historyKey,
  mergeChatEvents,
  nearChatTop,
  pageHasMore,
  readChatHistory,
  writeChatHistory,
} from './chat-history.js';

function remember(result, page, hasMore) {
  const uid = result?.peer?.uid || '';
  const username = result?.peer?.username || '';
  if (uid) writeChatHistory(historyKey({ peerUid: uid }), page, hasMore);
  if (username) writeChatHistory(historyKey({ peer: username }), page, hasMore);
}

export function useChatThread({ peer = '', peerUid = '', signedIn = false, getBearer, enabled = true }) {
  const key = historyKey({ peerUid, peer });
  const active = Boolean(enabled && signedIn && key);
  const cached = active ? readChatHistory(key) : { events: [], hasMore: false };
  const [cacheKey, setCacheKey] = useState(key);
  const [events, setEvents] = useState(cached.events);
  const [hasMore, setHasMore] = useState(cached.hasMore);
  const [settled, setSettled] = useState(cached.events.length > 0);
  const [error, setError] = useState('');
  const logRef = useRef(null);
  const pinBottom = useRef(true);
  const olderLock = useRef(false);
  const refreshRef = useRef(async () => {});
  const eventsRef = useRef(events);
  eventsRef.current = events;

  if (key !== cacheKey) {
    setCacheKey(key);
    setEvents(cached.events);
    setHasMore(cached.hasMore);
    setSettled(cached.events.length > 0);
    setError('');
    pinBottom.current = true;
  }

  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    async function loadLatest() {
      try {
        const token = await getBearer();
        const result = await getConversation(peer, token, { peerUid });
        if (!live) return;
        const page = result.events || [];
        const more = pageHasMore(result);
        setHasMore(more);
        setEvents((current) => mergeChatEvents(current, page));
        remember(result, page, more);
        writeChatHistory(key, page, more);
        setError('');
      } catch (err) {
        if (live && !eventsRef.current.length) setError(err.message || 'Could not open the chat.');
      } finally {
        if (live) setSettled(true);
      }
    }
    refreshRef.current = loadLatest;
    loadLatest();
    const timer = setInterval(loadLatest, 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, key, peer, peerUid, getBearer]);

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && pinBottom.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  async function loadOlder() {
    if (!active || olderLock.current || !hasMore) return;
    const oldest = eventsRef.current[0];
    if (!oldest?.id) return;
    olderLock.current = true;
    const el = logRef.current;
    const prevHeight = el?.scrollHeight || 0;
    const prevTop = el?.scrollTop || 0;
    pinBottom.current = false;
    try {
      const token = await getBearer();
      const result = await getConversation(peer, token, { peerUid, before: oldest.id });
      if (!result) return;
      const page = result.events || [];
      setHasMore(pageHasMore(result));
      setEvents((current) => mergeChatEvents(page, current));
      requestAnimationFrame(() => {
        if (!el) return;
        el.scrollTop = el.scrollHeight - prevHeight + prevTop;
      });
    } catch (err) {
      setError(err.message || 'Older messages could not be loaded.');
    } finally {
      olderLock.current = false;
    }
  }

  function onScroll(event) {
    const el = event.currentTarget;
    pinBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearChatTop(el.scrollTop)) loadOlder();
  }

  return {
    events,
    hasMore,
    settled,
    error,
    logRef,
    onScroll,
    refresh: () => refreshRef.current(),
  };
}
