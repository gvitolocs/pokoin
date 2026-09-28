import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fetchPokoChatHistory, sendPokoChat } from './api.js';
import {
  buildPokoPageContext,
  defaultPokoDeskPrompt,
  mergePokoEvents,
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
  const cached = uid ? readPokoHistory(uid) : [];
  const [cacheUid, setCacheUid] = useState(uid);
  const [events, setEvents] = useState(cached);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef(null);
  const pinBottom = useRef(true);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const refreshRef = useRef(async () => {});

  if (uid !== cacheUid) {
    setCacheUid(uid);
    setEvents(uid ? readPokoHistory(uid) : []);
    setError('');
    pinBottom.current = true;
  }

  useEffect(() => {
    if (!uid) return;
    writePokoHistory(uid, events);
  }, [uid, events]);

  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    async function loadLatest() {
      try {
        const token = await getBearer();
        if (!token || !live) return;
        const result = await fetchPokoChatHistory(token);
        if (!live) return;
        const page = result?.events || [];
        setEvents((current) => {
          const next = reconcilePokoEvents(current, page);
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
  }, [active, uid, getBearer]);

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && pinBottom.current) el.scrollTop = el.scrollHeight;
  }, [events, busy]);

  async function send({
    message = '',
    tags = [],
    photos = [],
  } = {}) {
    const attached = resolvePokoCards({ tags, pathname });
    const attachedImages = (photos || []).slice();
    if (busy || (!message.trim() && !attached.length && !attachedImages.length)) return null;
    setBusy(true);
    setError('');
    pinBottom.current = true;
    const localId = `local-${Date.now()}`;
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
      const token = await getBearer();
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
      }, token);
      const serverEvents = Array.isArray(result?.events) ? result.events : [];
      setEvents((current) => {
        const withoutLocal = (current || []).filter((row) => row.id !== localId);
        if (serverEvents.length) return reconcilePokoEvents(withoutLocal, serverEvents);
        const assistant = {
          id: `poko-${Date.now()}`,
          role: 'assistant',
          mine: false,
          text: result?.reply || '…',
          source: result?.source || '',
          createdAt: new Date().toISOString(),
        };
        return mergePokoEvents(withoutLocal, [mine, assistant]);
      });
      if (result?.source === 'unavailable' || result?.ok === false) {
        setError(result?.error || 'Poko could not reply. Try again.');
      }
      return result;
    } catch (err) {
      setEvents((current) => (current || []).filter((row) => row.id !== localId));
      setError(err.message || 'Poko could not reply.');
      throw err;
    } finally {
      setBusy(false);
    }
  }

  return {
    events,
    error,
    busy,
    logRef,
    refresh: () => refreshRef.current(),
    send,
    setError,
  };
}
