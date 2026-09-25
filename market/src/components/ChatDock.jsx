import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { getConversation, sendChatMessage } from '../chat-client.js';
import { LISTING_DRAG_TYPE, readListingDrag, tagKey } from '../chat-listing.js';
import { addChatTag, clearChatTags, closeChatDock, getChatDock, removeChatTag, subscribeChatDock } from '../chat-dock-store.js';
import ChatListingTag from './ChatListingTag.jsx';
import '../chat-dock.css';

export default function ChatDock() {
  const { signedIn, getBearer } = useAuth();
  const [dock, setDock] = useState(getChatDock);
  const [events, setEvents] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);

  useEffect(() => subscribeChatDock(setDock), []);

  useEffect(() => {
    if (!dock.open || !signedIn || !dock.peer) {
      setEvents([]);
      return undefined;
    }
    let live = true;
    async function load() {
      try {
        const token = await getBearer();
        const result = await getConversation('', token, { peerUid: dock.peer });
        if (live) {
          setEvents(result.events || []);
          setError('');
        }
      } catch (err) {
        if (live) setError(err.message || 'Could not open the chat.');
      }
    }
    load();
    const timer = setInterval(load, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [dock.open, dock.peer, signedIn, getBearer]);

  useEffect(() => {
    function allowsDrop(event) {
      return [...(event.dataTransfer?.types || [])].includes(LISTING_DRAG_TYPE);
    }
    function onDragOver(event) {
      if (!allowsDrop(event)) return;
      event.preventDefault();
      setOver(true);
    }
    function onDragLeave(event) {
      if (event.target === window) setOver(false);
    }
    function onDrop(event) {
      if (!allowsDrop(event)) return;
      event.preventDefault();
      setOver(false);
      const reference = readListingDrag(event);
      if (reference) addChatTag(reference);
    }
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  if (!dock.open && !over) return null;

  async function send(event) {
    event?.preventDefault();
    const message = text.trim();
    if (busy || (!message && !dock.tags.length)) return;
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      if (!token) throw new Error('Sign in to send a message.');
      await sendChatMessage('', message, token, dock.tags, dock.peer);
      setText('');
      clearChatTags();
      const result = await getConversation('', token, { peerUid: dock.peer });
      setEvents(result.events || []);
    } catch (err) {
      setError(err.message || 'Message was not sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={`chat-dock${over ? ' is-over' : ''}`}
      aria-label={`Chat with ${dock.peerLabel || 'seller'}`}
      onDragOver={(event) => { event.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        const reference = readListingDrag(event);
        if (reference) addChatTag(reference);
      }}
    >
      <header className="chat-dock-head">
        <strong>{dock.peerLabel ? (dock.peerLabel === 'Seller' ? 'Seller' : `@${dock.peerLabel}`) : 'Drop a listing'}</strong>
        <button type="button" aria-label="Close chat" onClick={closeChatDock}>×</button>
      </header>
      <div className="chat-dock-log">
        {events.map((event) => (
          <div key={event.id} className={`chat-bubble${event.mine ? ' mine' : ''}`}>
            {event.text ? <p>{event.text}</p> : null}
            {(event.listings || []).map((row) => <ChatListingTag key={tagKey(row)} row={row} />)}
            {!event.text && !(event.listings || []).length ? <p>…</p> : null}
          </div>
        ))}
      </div>
      {error ? <p className="chat-dock-error" role="alert">{error}</p> : null}
      {signedIn && dock.peer ? (
        <form className="chat-dock-compose" onSubmit={send}>
          {dock.tags.length ? (
            <div className="chat-dock-tags">
              {dock.tags.map((row) => (
                <ChatListingTag key={tagKey(row)} row={row} onRemove={removeChatTag} />
              ))}
            </div>
          ) : (
            <p className="chat-dock-hint">Drop a card or listing here to reference it.</p>
          )}
          <div className="chat-dock-field">
            <label className="sr-only" htmlFor="chat-dock-input">Message</label>
            <textarea
              id="chat-dock-input"
              rows="2"
              maxLength={1000}
              value={text}
              placeholder={dock.peerLabel && dock.peerLabel !== 'Seller' ? `Message @${dock.peerLabel}` : 'Message'}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send(event);
                }
              }}
            />
            <button type="submit" disabled={busy || (!text.trim() && !dock.tags.length)} aria-label="Send">↑</button>
          </div>
        </form>
      ) : (
        <p className="chat-dock-hint">
          <Link to={`/auth?from=${encodeURIComponent(window.location.pathname + window.location.search)}`}>Sign in</Link>
          {' '}to message this seller.
        </p>
      )}
    </section>
  );
}
