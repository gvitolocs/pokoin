import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fetchPokoChatHistory, sendPokoChat } from './api.js';
import { nearChatTop } from './chat-history.js';
import {
  buildPokoPageContext,
  defaultPokoDeskPrompt,
  mergePokoEvents,
  pokoEventsSignature,
  pokoHistoryHasMore,
  pokoUserTurnKey,
  readPokoHistory,
  reconcilePokoEvents,
  resolvePokoCards,
  writePokoHistory,
} from './poko-chat.js';

const POLL_MS = 4000;

export function usePokoThread({
  uid = '',
  signedIn = false,
  getBearer,
  enabled = true,
  pathname = '',
} = {}) {
  const active = Boolean(enabled && signedIn && uid);
  const cached = uid ? readPokoHistory(uid) : { events: [], hasMore: false };
  const [cacheUid, setCacheUid] = useState(uid);
  const [events, setEvents] = useState(cached.events);
  const [hasMore, setHasMore] = useState(cached.hasMore);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef(null);
  const pinBottom = useRef(true);
  const olderLock = useRef(false);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const busyRef = useRef(false);
  busyRef.current = busy;
  const refreshRef = useRef(async () => {});
  const getBearerRef = useRef(getBearer);
  getBearerRef.current = getBearer;
  const wasActive = useRef(active);

  if (uid !== cacheUid) {
    setCacheUid(uid);
    const next = uid ? readPokoHistory(uid) : { events: [], hasMore: false };
    setEvents(next.events);
    setHasMore(next.hasMore);
    setError('');
    pinBottom.current = true;
  }

  useEffect(() => {
    if (!uid) return;
    writePokoHistory(uid, events, hasMore);
  }, [uid, events, hasMore]);

  // Opening the dock remounts the log without changing events — re-pin once.
  useEffect(() => {
    if (active && !wasActive.current) {
      pinBottom.current = true;
    }
    wasActive.current = active;
  }, [active]);

  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    async function loadLatest() {
      // Do not race history over an in-flight send — that was wiping the
      // optimistic user bubble until a full page refresh.
      if (busyRef.current) return;
      try {
        const token = await getBearerRef.current?.();
        if (!token || !live || busyRef.current) return;
        const result = await fetchPokoChatHistory(token);
        if (!live || busyRef.current) return;
        const page = result?.events || [];
        const more = pokoHistoryHasMore(result);
        setHasMore(more);
        setEvents((current) => {
          const next = reconcilePokoEvents(current, page);
          // Idle polls must not rebuild state — that re-rendered the thread and
          // yanked scroll to the bottom every 4s while pinBottom stayed true.
          if (pokoEventsSignature(current) === pokoEventsSignature(next)) {
            return current;
          }
          return next;
        });
        setError('');
      } catch (err) {
        if (live && !eventsRef.current.length) {
          setError(err.message || 'Could not load Poko chat.');
        }
      }
    }
    refreshRef.current = loadLatest;
    loadLatest();
    const timer = setInterval(loadLatest, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, uid]);

  useLayoutEffect(() => {
    if (!active) return;
    const el = logRef.current;
    if (el && pinBottom.current) el.scrollTop = el.scrollHeight;
  }, [events, busy, active]);

  async function loadOlder() {
    if (!active || olderLock.current || !hasMoreRef.current) return;
    const oldest = eventsRef.current[0];
    if (!oldest?.id || String(oldest.id).startsWith('local-')) return;
    olderLock.current = true;
    const el = logRef.current;
    const prevHeight = el?.scrollHeight || 0;
    const prevTop = el?.scrollTop || 0;
    pinBottom.current = false;
    try {
      const token = await getBearerRef.current?.();
      if (!token) return;
      const result = await fetchPokoChatHistory(token, { before: oldest.id });
      const page = result?.events || [];
      setHasMore(pokoHistoryHasMore(result));
      if (!page.length) return;
      setEvents((current) => mergePokoEvents(page, current));
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

  async function send({
    message = '',
    tags = [],
    photos = [],
  } = {}) {
    const attached = resolvePokoCards({ tags, pathname });
    const attachedImages = (photos || []).slice();
    if (busy || (!message.trim() && !attached.length && !attachedImages.length)) return null;
    setBusy(true);
    busyRef.current = true;
    setError('');
    pinBottom.current = true;
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const mine = {
      id: localId,
      role: 'user',
      mine: true,
      text: message.trim(),
      listings: tags.map((row) => ({ ...row })),
      cards: tags.map((row) => ({ ...row })),
      images: attachedImages,
      createdAt: new Date().toISOString(),
    };
    setEvents((current) => mergePokoEvents(current, [mine]));
    try {
      const token = await getBearerRef.current?.();
      if (!token) throw new Error('Sign in to message Poko.');
      const pageContext = buildPokoPageContext({
        pathname,
        cards: attached,
        images: attachedImages,
      });
      const result = await sendPokoChat({
        message: message.trim() || (attached[0]
          ? defaultPokoDeskPrompt(attached[0])
          : attachedImages.length ? 'What can you tell me about this photo?' : ''),
        cards: attached,
        images: attachedImages,
        pageContext,
        sessionId: uid,
        clientTurnId: localId,
      }, token);
      const serverEvents = Array.isArray(result?.events) ? result.events : [];
      setEvents((current) => {
        // Keep local-* in `current` so reconcile can match/replace it. Never
        // strip the optimistic row before we know the server twin is present.
        if (serverEvents.length) {
          const next = reconcilePokoEvents(current, serverEvents);
          const key = pokoUserTurnKey(mine);
          const hasUser = next.some((row) => (
            row.role === 'user'
              && (row.id === localId || row.clientTurnId === localId || pokoUserTurnKey(row) === key)
          ));
          if (hasUser) return next;
          return mergePokoEvents(next, [{ ...mine, id: `user-${Date.now()}` }]);
        }
        const assistant = {
          id: `poko-${Date.now()}`,
          role: 'assistant',
          mine: false,
          text: result?.reply || '…',
          cards: Array.isArray(result?.cards) ? result.cards : [],
          source: result?.source || '',
          createdAt: new Date().toISOString(),
        };
        const confirmedMine = {
          ...mine,
          id: `user-${Date.now()}`,
        };
        return mergePokoEvents(
          (current || []).filter((row) => row.id !== localId),
          [confirmedMine, assistant],
        );
      });
      if (result?.source === 'unavailable' || result?.ok === false) {
        setError(result?.error || 'Poko could not reply. Try again.');
      }
      return result;
    } catch (err) {
      // Keep the user's bubble visible; only flag the failure.
      setEvents((current) => (current || []).map((row) => (
        row.id === localId
          ? { ...row, source: 'send_failed' }
          : row
      )));
      setError(err.message || 'Poko could not reply.');
      throw err;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return {
    events,
    hasMore,
    error,
    busy,
    logRef,
    onScroll,
    refresh: () => refreshRef.current(),
    send,
    setError,
  };
}
