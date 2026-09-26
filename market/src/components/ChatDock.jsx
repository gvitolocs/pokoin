import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { listConversations, sendChatMessage, uploadChatPhoto } from '../chat-client.js';
import { chatTime } from '../chat-format.js';
import { LISTING_DRAG_TYPE, readListingDrag, tagKey } from '../chat-listing.js';
import {
  addChatTag,
  beginCardDrag,
  chatDropHintVisible,
  closeChatDock,
  clearChatTags,
  dismissChatDropHint,
  dropOnConversation,
  endCardDrag,
  getChatDock,
  getChatDrafts,
  markChatDrop,
  noteListingDrag,
  openChatList,
  openThread,
  removeChatTag,
  setChatTagQty,
  subscribeChatDock,
} from '../chat-dock-store.js';
import { readChatPreviews, writeChatPreviews } from '../chat-history.js';
import { useSearchLang } from '../locale.js';
import { useChatThread } from '../use-chat-thread.js';
import ChatListingTag from './ChatListingTag.jsx';
import ChatPhotos from './ChatPhotos.jsx';
import { MAX_CHAT_PHOTOS, photoFileToJpeg } from '../user-photos.js';
import '../chat-dock.css';

function draftLine(row, drafts) {
  const tags = drafts?.[row.peerUid]?.tags || [];
  const name = tags.length ? tags[tags.length - 1].cardName : '';
  if (name) return { text: `Draft: ${name}`, draft: true };
  return { text: row.preview || 'No messages yet', draft: false };
}

function ConversationList({ signedIn, getBearer, onOpen }) {
  const [rows, setRows] = useState(readChatPreviews);
  const [seen, setSeen] = useState(() => readChatPreviews().length > 0);
  const [drafts, setDrafts] = useState(getChatDrafts);
  const [overUid, setOverUid] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!signedIn) return undefined;
    let live = true;
    async function load() {
      try {
        const token = await getBearer();
        const result = await listConversations(token);
        if (!live) return;
        const next = result.conversations || [];
        setRows(next);
        writeChatPreviews(next);
        setDrafts(getChatDrafts());
        setError('');
      } catch (err) {
        if (live) setError(err.message || 'Could not load conversations.');
      } finally {
        if (live) setSeen(true);
      }
    }
    load();
    return () => { live = false; };
  }, [signedIn, getBearer]);

  if (!signedIn) {
    return (
      <p className="chat-dock-hint">
        <Link to={`/auth?from=${encodeURIComponent(window.location.pathname + window.location.search)}`}>Sign in</Link>
        {' '}to see your conversations.
      </p>
    );
  }

  return (
    <div className="chat-dock-list" role="list">
      {error ? <p className="chat-dock-error" role="alert">{error}</p> : null}
      {rows.length ? rows.map((row) => {
        const line = draftLine(row, drafts);
        return (
          <div
            key={row.pairKey || row.peerUid}
            role="listitem"
            className={`chat-dock-row${overUid === row.peerUid ? ' is-over' : ''}`}
            onDragOver={(event) => {
              if (![...(event.dataTransfer?.types || [])].includes(LISTING_DRAG_TYPE)) return;
              event.preventDefault();
              event.stopPropagation();
              setOverUid(row.peerUid);
            }}
            onDragLeave={() => setOverUid('')}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setOverUid('');
              const reference = readListingDrag(event);
              if (reference) dropOnConversation(row.peerUid, row.peerUsername, reference);
            }}
          >
            <button type="button" onClick={() => onOpen(row)}>
              <span className="chat-dock-avatar" aria-hidden="true">{(row.peerUsername || '?').slice(0, 1).toUpperCase()}</span>
              <span className="chat-dock-row-copy">
                <strong>@{row.peerUsername || 'Pokoin user'}</strong>
                <em className={line.draft ? 'is-draft' : ''}>{line.text}</em>
              </span>
              <time>{chatTime(row.updatedAt)}</time>
            </button>
          </div>
        );
      }) : seen ? <p className="chat-dock-hint">No conversations yet. Drop a card on someone after you message them.</p> : null}
    </div>
  );
}

export default function ChatDock() {
  const { signedIn, getBearer, user, profile } = useAuth();
  const lang = useSearchLang();
  const [dock, setDock] = useState(getChatDock);
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const [showDropHint, setShowDropHint] = useState(chatDropHintVisible);
  const textRef = useRef('');
  textRef.current = text;
  const thread = useChatThread({
    peerUid: dock.peer,
    signedIn,
    getBearer,
    enabled: dock.open && dock.view === 'thread',
  });

  useEffect(() => subscribeChatDock(setDock), []);

  useEffect(() => {
    if (dock.view === 'thread') setText(dock.text || '');
  }, [dock.view, dock.peer]);

  useEffect(() => {
    function allowsDrop(event) {
      return [...(event.dataTransfer?.types || [])].includes(LISTING_DRAG_TYPE);
    }
    function onDragStart(event) {
      if (!allowsDrop(event) && !document.documentElement.classList.contains('is-card-dragging')) return;
      beginCardDrag();
    }
    function onDragOver(event) {
      if (!allowsDrop(event)) return;
      if (noteListingDrag(textRef.current) === 'thread') return;
      event.preventDefault();
    }
    function onDragEnd() {
      endCardDrag();
    }
    window.addEventListener('dragstart', onDragStart);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragend', onDragEnd);
    return () => {
      window.removeEventListener('dragstart', onDragStart);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragend', onDragEnd);
    };
  }, []);

  if (!dock.open) return null;

  const label = dock.peerLabel && dock.peerLabel !== 'Seller' ? `@${dock.peerLabel}` : 'Seller';

  async function addPhotos(event) {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    const room = MAX_CHAT_PHOTOS - photos.length;
    if (!files.length || room <= 0) return;
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      const next = [];
      for (const file of files.slice(0, room)) {
        const dataUrl = await photoFileToJpeg(file);
        const saved = await uploadChatPhoto(token, dataUrl, 'chat');
        if (saved?.url) next.push(saved.url);
      }
      setPhotos((current) => [...current, ...next].slice(0, MAX_CHAT_PHOTOS));
    } catch (err) {
      setError(err.message || 'Photo was not added.');
    } finally {
      setBusy(false);
    }
  }

  async function send(event) {
    event?.preventDefault();
    const message = text.trim();
    if (busy || (!message && !dock.tags.length && !photos.length)) return;
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      if (!token) throw new Error('Sign in to send a message.');
      await sendChatMessage('', message, token, dock.tags, dock.peer, photos);
      setText('');
      setPhotos([]);
      clearChatTags();
      await thread.refresh();
    } catch (err) {
      setError(err.message || 'Message was not sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={`chat-dock${over ? ' is-over' : ''}`}
      aria-label={dock.view === 'list' ? 'Messages' : `Chat with ${label}`}
      onDragOver={(event) => {
        if (![...(event.dataTransfer?.types || [])].includes(LISTING_DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        if (dock.view === 'thread') setOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setOver(false);
      }}
      onDrop={(event) => {
        if (![...(event.dataTransfer?.types || [])].includes(LISTING_DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        markChatDrop();
        if (dock.view !== 'thread') return;
        const reference = readListingDrag(event);
        if (reference) addChatTag(reference, textRef.current);
      }}
    >
      <header className="chat-dock-head">
        {dock.view === 'thread' ? (
          <button type="button" aria-label="Conversations" onClick={() => openChatList(text)}>‹</button>
        ) : <span />}
        <strong>
          {dock.view === 'thread' && dock.peerLabel && dock.peerLabel !== 'Seller' ? (
            <Link to={`/marketplace/${lang}/users/${encodeURIComponent(dock.peerLabel)}`}>{label}</Link>
          ) : (dock.view === 'thread' ? label : 'Messages')}
        </strong>
        <button type="button" aria-label="Close chat" onClick={() => closeChatDock(text)}>×</button>
      </header>
      {dock.view === 'list' ? (
        <ConversationList signedIn={signedIn} getBearer={getBearer} onOpen={(row) => openThread(row.peerUid, row.peerUsername, text)} />
      ) : (
        <>
          <div className="chat-dock-log" ref={thread.logRef} onScroll={thread.onScroll}>
            {thread.events.map((event) => (
              <div key={event.id} className={`chat-bubble${event.mine ? ' mine' : ''}`}>
                {event.text ? <p>{event.text}</p> : null}
                <ChatPhotos urls={event.images || []} />
                {(event.listings || []).length ? (
                  <span className="chat-tags">
                    {(event.listings || []).map((row, index) => (
                      <ChatListingTag
                        key={`${tagKey(row)}:${index}`}
                        row={row}
                        peer={{ uid: dock.peer, username: dock.peerLabel && dock.peerLabel !== 'Seller' ? dock.peerLabel : '' }}
                        me={{ uid: user?.uid, username: profile?.username }}
                      />
                    ))}
                  </span>
                ) : null}
                {!event.text && !(event.listings || []).length && !(event.images || []).length ? <p>…</p> : null}
              </div>
            ))}
          </div>
          {error || thread.error ? <p className="chat-dock-error" role="alert">{error || thread.error}</p> : null}
          {signedIn && dock.peer ? (
            <form className="chat-dock-compose" onSubmit={send}>
              {dock.tags.length ? (
                <div className="chat-dock-tags">
                  {dock.tags.map((row) => (
                    <ChatListingTag
                      key={tagKey(row)}
                      row={row}
                        onRemove={removeChatTag}
                        onQty={setChatTagQty}
                      peer={{ uid: dock.peer, username: dock.peerLabel && dock.peerLabel !== 'Seller' ? dock.peerLabel : '' }}
                      me={{ uid: user?.uid, username: profile?.username }}
                    />
                  ))}
                </div>
              ) : showDropHint ? (
                <p className="chat-dock-hint chat-dock-hint-row">
                  <span>Drop a card on a conversation to attach it.</span>
                  <button
                    type="button"
                    className="chat-hint-x"
                    aria-label="Hide hint"
                    onClick={() => {
                      dismissChatDropHint();
                      setShowDropHint(false);
                    }}
                  >×</button>
                </p>
              ) : null}
              {photos.length ? (
                <div className="chat-photo-draft">
                  <ChatPhotos urls={photos} />
                  <button type="button" onClick={() => setPhotos([])}>Clear photos</button>
                </div>
              ) : null}
              <div className="chat-dock-field">
                <label className="chat-photo-add" aria-label="Add photos">
                  +
                  <input type="file" accept="image/*" multiple hidden onChange={addPhotos} disabled={busy || photos.length >= MAX_CHAT_PHOTOS} />
                </label>
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
                <button type="submit" disabled={busy || (!text.trim() && !dock.tags.length && !photos.length)} aria-label="Send">↑</button>
              </div>
            </form>
          ) : (
            <p className="chat-dock-hint">
              <Link to={`/auth?from=${encodeURIComponent(window.location.pathname + window.location.search)}`}>Sign in</Link>
              {' '}to message this seller.
            </p>
          )}
        </>
      )}
    </section>
  );
}
