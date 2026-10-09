import { createEffect, createMemo, createSignal, untrack } from 'solid-js';
import { getConversation } from '@market/chat-client.js';
import {
  historyKey,
  mergeChatEvents,
  nearChatTop,
  pageHasMore,
  readChatHistory,
  writeChatHistory,
} from '@market/chat-history.js';

function remember(result, page, hasMore, fallbackPeer) {
  const uid = result?.peer?.uid || '';
  const username = result?.peer?.username || fallbackPeer || '';
  const key = uid ? historyKey({ peerUid: uid }) : historyKey({ peer: username });
  writeChatHistory(key, page, hasMore, { peerUid: uid, username });
}

function cachedFor(key) {
  return key ? readChatHistory(key) : { events: [], hasMore: false };
}

/**
 * A person-to-person thread (market/src/use-chat-thread.js): paints this
 * browser's cached page at once, polls the latest page every 4 s while
 * `enabled`, loads older pages near the top and keeps the log pinned to the
 * bottom unless the reader scrolled up. Options are accessors.
 */
export function createChatThread({ peerUid, peer = () => '', signedIn, getBearer, enabled }) {
  const key = createMemo(() => historyKey({ peerUid: peerUid(), peer: peer() }));
  // Writable derived state: a new peer starts again from its cached page.
  const [events, setEventsSignal] = createSignal(() => cachedFor(key()).events);
  const [hasMore, setHasMore] = createSignal(() => cachedFor(key()).hasMore);
  const [settled, setSettled] = createSignal(() => cachedFor(key()).events.length > 0);
  const [error, setError] = createSignal(() => (key(), ''));
  const [person, setPerson] = createSignal(() => (key(), null));
  let log = null;
  let pinBottom = true;
  let olderLock = false;
  let refresh = async () => {};
  let current = untrack(() => cachedFor(key()).events);

  function setEvents(next) {
    current = next;
    setEventsSignal(() => next);
  }

  createEffect(key, (k) => {
    current = cachedFor(k).events;
    pinBottom = true;
  });

  createEffect(
    () => (enabled() && signedIn() && key() ? [key(), peer(), peerUid()] : null),
    (active) => {
      if (!active) return undefined;
      const [, peerName, uid] = active;
      let live = true;
      async function loadLatest() {
        try {
          const token = await getBearer();
          const result = await getConversation(peerName, token, { peerUid: uid });
          if (!live) return;
          const page = result.events || [];
          const more = pageHasMore(result);
          setHasMore(more);
          setEvents(mergeChatEvents(current, page));
          if (result.peer) setPerson(() => result.peer);
          remember(result, page, more, peerName);
          setError('');
        } catch (err) {
          if (live && !current.length) setError(err.message || 'Could not open the chat.');
        } finally {
          if (live) setSettled(true);
        }
      }
      refresh = loadLatest;
      loadLatest();
      const timer = setInterval(loadLatest, 4000);
      return () => {
        live = false;
        clearInterval(timer);
      };
    },
  );

  createEffect(events, () => {
    if (log && pinBottom) log.scrollTop = log.scrollHeight;
  });

  async function loadOlder() {
    if (!(enabled() && signedIn() && key()) || olderLock || !hasMore()) return;
    const oldest = current[0];
    if (!oldest?.id) return;
    olderLock = true;
    const el = log;
    const prevHeight = el?.scrollHeight || 0;
    const prevTop = el?.scrollTop || 0;
    pinBottom = false;
    try {
      const token = await getBearer();
      const result = await getConversation(peer(), token, { peerUid: peerUid(), before: oldest.id });
      if (!result) return;
      const page = result.events || [];
      setHasMore(pageHasMore(result));
      setEvents(mergeChatEvents(page, current));
      requestAnimationFrame(() => {
        if (!el) return;
        el.scrollTop = el.scrollHeight - prevHeight + prevTop;
      });
    } catch (err) {
      setError(err.message || 'Older messages could not be loaded.');
    } finally {
      olderLock = false;
    }
  }

  function onScroll(event) {
    const el = event.currentTarget;
    pinBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearChatTop(el.scrollTop)) loadOlder();
  }

  return {
    events,
    person,
    hasMore,
    settled,
    error,
    setLog: (el) => {
      log = el;
      if (el && pinBottom) el.scrollTop = el.scrollHeight;
    },
    onScroll,
    refresh: () => refresh(),
  };
}
