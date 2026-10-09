import { createEffect, createSignal, untrack } from 'solid-js';
import { fetchPokoChatHistory, sendPokoChat } from '@market/api.js';
import { nearChatTop } from '@market/chat-history.js';
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
} from '@market/poko-chat.js';

const POLL_MS = 4000;

function cachedFor(uid) {
  return uid ? readPokoHistory(uid) : { events: [], hasMore: false };
}

/**
 * The Poko assistant thread (market/src/use-poko-thread.js): cached history
 * first, a 4 s poll while open that never races an in-flight send, an
 * optimistic user bubble reconciled with the server's echo, older pages near
 * the top. Options are accessors.
 */
export function createPokoThread({ uid, signedIn, getBearer, enabled, pathname }) {
  const [events, setEventsSignal] = createSignal(() => cachedFor(uid()).events);
  const [hasMore, setHasMoreSignal] = createSignal(() => cachedFor(uid()).hasMore);
  const [error, setError] = createSignal(() => (uid(), ''));
  const [busy, setBusy] = createSignal(false);
  const active = () => Boolean(enabled() && signedIn() && uid());
  let log = null;
  let pinBottom = true;
  let olderLock = false;
  let busyNow = false;
  let refresh = async () => {};
  let current = untrack(() => cachedFor(uid()).events);
  let more = untrack(() => cachedFor(uid()).hasMore);

  function setEvents(next) {
    current = next;
    setEventsSignal(() => next);
  }

  function setHasMore(next) {
    more = next;
    setHasMoreSignal(next);
  }

  createEffect(uid, (owner) => {
    const cached = cachedFor(owner);
    current = cached.events;
    more = cached.hasMore;
    pinBottom = true;
  });

  createEffect(
    () => [uid(), events(), hasMore()],
    ([owner, list, older]) => {
      if (owner) writePokoHistory(owner, list, older);
    },
  );

  // Opening the dock remounts the log without changing events — re-pin once.
  createEffect(active, (on, was) => {
    if (on && !was) pinBottom = true;
  });

  createEffect(
    () => (active() ? uid() : ''),
    (owner) => {
      if (!owner) return undefined;
      let live = true;
      async function loadLatest() {
        // Do not race history over an in-flight send — that wiped the
        // optimistic user bubble until a full page refresh.
        if (busyNow) return;
        try {
          const token = await getBearer();
          if (!token || !live || busyNow) return;
          const result = await fetchPokoChatHistory(token);
          if (!live || busyNow) return;
          const page = result?.events || [];
          setHasMore(pokoHistoryHasMore(result));
          const next = reconcilePokoEvents(current, page);
          // Idle polls must not rebuild state (that yanked scroll every 4 s).
          if (pokoEventsSignature(current) !== pokoEventsSignature(next)) setEvents(next);
          setError('');
        } catch (err) {
          if (live && !current.length) setError(err.message || 'Could not load Poko chat.');
        }
      }
      refresh = loadLatest;
      loadLatest();
      const timer = setInterval(loadLatest, POLL_MS);
      return () => {
        live = false;
        clearInterval(timer);
      };
    },
  );

  createEffect(
    () => [events(), busy(), active()],
    ([, , on]) => {
      if (!on) return;
      if (log && pinBottom) log.scrollTop = log.scrollHeight;
    },
  );

  async function loadOlder() {
    if (!active() || olderLock || !more) return;
    const oldest = current[0];
    if (!oldest?.id || String(oldest.id).startsWith('local-')) return;
    olderLock = true;
    const el = log;
    const prevHeight = el?.scrollHeight || 0;
    const prevTop = el?.scrollTop || 0;
    pinBottom = false;
    try {
      const token = await getBearer();
      if (!token) return;
      const result = await fetchPokoChatHistory(token, { before: oldest.id });
      const page = result?.events || [];
      setHasMore(pokoHistoryHasMore(result));
      if (!page.length) return;
      setEvents(mergePokoEvents(page, current));
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

  async function send({ message = '', tags = [], photos = [] } = {}) {
    const path = pathname();
    const attached = resolvePokoCards({ tags, pathname: path });
    const attachedImages = (photos || []).slice();
    if (busyNow || (!message.trim() && !attached.length && !attachedImages.length)) return null;
    busyNow = true;
    setBusy(true);
    setError('');
    pinBottom = true;
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
    setEvents(mergePokoEvents(current, [mine]));
    try {
      const token = await getBearer();
      if (!token) throw new Error('Sign in to message Poko.');
      const pageContext = buildPokoPageContext({ pathname: path, cards: attached, images: attachedImages });
      const result = await sendPokoChat({
        message: message.trim() || (attached[0]
          ? defaultPokoDeskPrompt(attached[0])
          : attachedImages.length ? 'What can you tell me about this photo?' : ''),
        cards: attached,
        images: attachedImages,
        pageContext,
        sessionId: uid(),
        clientTurnId: localId,
      }, token);
      const serverEvents = Array.isArray(result?.events) ? result.events : [];
      if (serverEvents.length) {
        // Keep local-* in `current` so reconcile can match/replace it. Never
        // strip the optimistic row before the server twin is present.
        const next = reconcilePokoEvents(current, serverEvents);
        const turn = pokoUserTurnKey(mine);
        const hasUser = next.some((row) => (
          row.role === 'user'
            && (row.id === localId || row.clientTurnId === localId || pokoUserTurnKey(row) === turn)
        ));
        setEvents(hasUser ? next : mergePokoEvents(next, [{ ...mine, id: `user-${Date.now()}` }]));
      } else {
        const assistant = {
          id: `poko-${Date.now()}`,
          role: 'assistant',
          mine: false,
          text: result?.reply || '…',
          cards: Array.isArray(result?.cards) ? result.cards : [],
          source: result?.source || '',
          createdAt: new Date().toISOString(),
        };
        setEvents(mergePokoEvents(
          (current || []).filter((row) => row.id !== localId),
          [{ ...mine, id: `user-${Date.now()}` }, assistant],
        ));
      }
      if (result?.source === 'unavailable' || result?.ok === false) {
        setError(result?.error || 'Poko could not reply. Try again.');
      }
      return result;
    } catch (err) {
      // Keep the user's bubble visible; only flag the failure.
      setEvents((current || []).map((row) => (row.id === localId ? { ...row, source: 'send_failed' } : row)));
      setError(err.message || 'Poko could not reply.');
      throw err;
    } finally {
      busyNow = false;
      setBusy(false);
    }
  }

  return {
    events,
    hasMore,
    error,
    busy,
    setLog: (el) => {
      log = el;
      if (el && pinBottom) el.scrollTop = el.scrollHeight;
    },
    onScroll,
    refresh: () => refresh(),
    send,
    setError,
  };
}
