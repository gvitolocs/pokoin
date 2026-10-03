import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { searchRecipientUsernames } from '../api.js';
import { game } from '../game.js';
import { warmSellerFromChat } from '../seller-seed.js';
import { useAuth } from '../auth.jsx';
import {
  listConversations,
  newClientToken,
  sendChatMessage,
  sendChatPayment,
  uploadChatPhoto,
} from '../chat-client.js';
import { useChatThread } from '../use-chat-thread.js';
import { usePokoThread } from '../use-poko-thread.js';
import { chatPersonName, chatPersonPhoto, chatTime, eventAriaLabel, requestActionFor } from '../chat-format.js';
import Avatar from '../components/Avatar.jsx';
import { LISTING_DRAG_TYPE, readListingDrag, tagKey } from '../chat-listing.js';
import { readChatPreviews, writeChatPreviews } from '../chat-history.js';
import { useSearchLang } from '../locale.js';
import ChatListingTag from '../components/ChatListingTag.jsx';
import ChatText from '../components/ChatText.jsx';
import ChatPhotos from '../components/ChatPhotos.jsx';
import { MAX_CHAT_PHOTOS, imageFilesFromClipboard, photoFileToJpeg } from '../user-photos.js';
import { createMoneyRequest, payMoneyRequest, requestStatusLabel, respondMoneyRequest } from '../money-requests.js';
import {
  isPokoPeer,
  POKO_DISPLAY,
  POKO_PEER,
  pokoPreview,
  readPokoHistory,
} from '../poko-chat.js';
import { acceptTrayDrop, messagesTrayId } from '../tray-drag.js';
import mascotUrl from '../assets/pokoin-mascot@8x.png';

function PokoAvatar({ className = 'messages-avatar is-poko' }) {
  return (
    <span className={className} aria-hidden="true">
      <img src={mascotUrl} alt="" />
    </span>
  );
}

function SignInGate() {
  return (
    <main className="messages-page messages-empty">
      <div className="messages-empty-card">
        <span className="messages-mark" aria-hidden="true">↔</span>
        <h1>Messages and payments</h1>
        <p>Sign in to talk, request PKN, and pay people you trust in one private conversation.</p>
        <Link className="wallet-primary" to="/auth?from=%2Fmessages">Sign in</Link>
      </div>
    </main>
  );
}

function NewConversation({ onClose }) {
  const { getBearer } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState([]);
  const clean = query.trim().toLowerCase();

  useEffect(() => {
    if (clean.length < 2) { setRows([]); return undefined; }
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const token = await getBearer();
        const result = await searchRecipientUsernames(clean, token);
        if (live) setRows((result.usernames || []).slice(0, 6));
      } catch (_) {
        if (live) setRows([]);
      }
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [clean, getBearer]);

  function open(username = clean) {
    const target = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9]{3,32}$/.test(target)) return;
    onClose();
    navigate(`/messages/${encodeURIComponent(target)}`);
  }

  return (
    <div className="chat-modal-backdrop" onClick={onClose}>
      <section className="chat-modal" role="dialog" aria-modal="true" aria-labelledby="new-chat-title" onClick={(event) => event.stopPropagation()}>
        <div className="chat-modal-head"><h2 id="new-chat-title">New conversation</h2><button type="button" onClick={onClose} aria-label="Close">×</button></div>
        <label className="chat-field">Pokoin username<input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="username" autoComplete="off" /></label>
        {rows.length > 0 && <div className="chat-user-results">{rows.map((row) => {
          const username = typeof row === 'string' ? row : row.username;
          return <button type="button" key={username} onClick={() => open(username)}>@{username}</button>;
        })}</div>}
        <button className="wallet-primary" type="button" disabled={!/^[a-z0-9]{3,32}$/.test(clean)} onClick={() => open()}>Open conversation</button>
      </section>
    </div>
  );
}

export default function Messages() {
  const { ready, signedIn, getBearer, user } = useAuth();
  const [rows, setRows] = useState(readChatPreviews);
  const [loading, setLoading] = useState(() => readChatPreviews().length === 0);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const uid = user?.uid || '';
  const pokoEvents = readPokoHistory(uid).events;

  const refresh = useCallback(async () => {
    if (!signedIn) return;
    try {
      const token = await getBearer();
      const result = await listConversations(token);
      const next = result.conversations || [];
      setRows(next);
      writeChatPreviews(next);
      setError('');
    } catch (err) {
      setError(err.message || 'Messages could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [getBearer, signedIn]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  if (!ready && !rows.length) return <main className="messages-page messages-empty" aria-busy="true">Loading…</main>;
  if (ready && !signedIn) return <SignInGate />;
  return (
    <main className="messages-page">
      <header className="messages-title-row"><div><p className="messages-kicker">Your people</p><h1>Messages</h1></div><button className="messages-new" type="button" onClick={() => setCreating(true)}>New message</button></header>
      {error && <p className="chat-error" role="alert">{error}</p>}
      <div className="messages-list">
        <Link className="messages-row is-poko" to={`/messages/${POKO_PEER}`}>
          <PokoAvatar />
          <span className="messages-row-copy">
            <strong>{POKO_DISPLAY}</strong>
            <span>{pokoPreview(pokoEvents)}</span>
          </span>
          <span className="messages-row-meta"><time>Assistant</time></span>
        </Link>
        {loading ? <div className="messages-list-skeleton" aria-label="Loading conversations" /> : rows.map((row) => (
          <Link key={row.pairKey} className="messages-row" to={`/messages/${encodeURIComponent(row.peerUsername)}`}>
            <Avatar src={chatPersonPhoto(row)} seed={row.peerUid} name={chatPersonName(row)} size={42} />
            <span className="messages-row-copy"><strong>{chatPersonName(row)}</strong><span>{row.preview || 'Start the conversation'}</span></span>
            <span className="messages-row-meta"><time>{chatTime(row.updatedAt)}</time>{row.unread > 0 && <b aria-label={`${row.unread} unread`}>{row.unread}</b>}</span>
          </Link>
        ))}
      </div>
      {!loading && !rows.length ? (
        <p className="messages-hint">Chat with Poko about cards above, or start a conversation with another Pokoin username.</p>
      ) : null}
      {creating && <NewConversation onClose={() => setCreating(false)} />}
    </main>
  );
}

function MoneyModal({ mode, peer, onClose, onDone }) {
  const { getBearer } = useAuth();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const amountPkn = Number(amount);

  async function submit() {
    if (!Number.isInteger(amountPkn) || amountPkn <= 0) { setError('Enter a whole PKN amount greater than zero.'); return; }
    if (!confirming) { setConfirming(true); return; }
    setBusy(true); setError('');
    try {
      const token = await getBearer();
      if (mode === 'send') await sendChatPayment(peer, amountPkn, note, newClientToken(), token);
      else await createMoneyRequest({ recipientUsername: peer, amountPkn, note, clientToken: newClientToken() }, token);
      onDone(mode === 'send' ? `${amountPkn} PKN sent` : `${amountPkn} PKN requested`);
    } catch (err) {
      setError(err.message || 'The action could not be completed.'); setConfirming(false);
    } finally { setBusy(false); }
  }

  return (
    <div className="chat-modal-backdrop" onClick={onClose}>
      <section className="chat-modal" role="dialog" aria-modal="true" aria-labelledby="money-modal-title" onClick={(event) => event.stopPropagation()}>
        <div className="chat-modal-head"><h2 id="money-modal-title">{mode === 'send' ? 'Send PKN' : 'Request PKN'}</h2><button type="button" onClick={onClose} aria-label="Close">×</button></div>
        {confirming ? <div className="chat-confirm"><span>{mode === 'send' ? 'Send' : 'Request'}</span><strong>{amountPkn} PKN</strong><p>{mode === 'send' ? 'This balance transfer cannot be undone.' : `@${peer} can pay or decline in this chat.`}</p></div> : <>
          <label className="chat-field">Amount<input inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value.replace(/\D/g, ''))} placeholder="0" /></label>
          <label className="chat-field">Note (optional)<input value={note} maxLength={140} onChange={(event) => setNote(event.target.value)} placeholder="What is this for?" /></label>
        </>}
        {error && <p className="chat-error" role="alert">{error}</p>}
        <button className="wallet-primary" type="button" disabled={busy} onClick={submit}>{busy ? 'Working…' : confirming ? `Confirm ${mode}` : 'Review'}</button>
        {confirming && <button className="chat-secondary" type="button" disabled={busy} onClick={() => setConfirming(false)}>Back</button>}
      </section>
    </div>
  );
}

function EventCard({ event, busy, onAction, peer, me }) {
  const action = requestActionFor(event);
  if (event.type === 'money_request') return (
    <article className={`chat-money-card ${event.mine ? 'mine' : ''}`} aria-label={eventAriaLabel(event)}>
      <span className="chat-money-kind">PKN request</span><strong>{event.amountPkn} PKN</strong>
      {event.note && <p>{event.note}</p>}
      <span className={`chat-status ${event.requestStatus || 'pending'}`}>{requestStatusLabel(event.requestStatus)}</span>
      {action === 'pay' && <div className="chat-card-actions"><button disabled={busy} type="button" onClick={() => onAction(event, 'pay')}>Pay request</button><button disabled={busy} type="button" onClick={() => onAction(event, 'decline')}>Decline</button></div>}
      {action === 'cancel' && <button className="chat-link-button" disabled={busy} type="button" onClick={() => onAction(event, 'cancel')}>Cancel request</button>}
      <time>{chatTime(event.createdAt)}</time>
    </article>
  );
  if (event.type === 'payment') return (
    <article className={`chat-money-card payment ${event.mine ? 'mine' : ''}`} aria-label={eventAriaLabel(event)}><span className="chat-money-kind">{event.mine ? 'You sent' : 'You received'}</span><strong>{event.amountPkn} PKN</strong>{event.note && <p>{event.note}</p>}<span className="chat-status paid">Paid ✓</span><time>{chatTime(event.createdAt)}</time></article>
  );
  return (
    <div className={`chat-bubble ${event.mine ? ' mine' : ''}`} aria-label={eventAriaLabel(event)}>
      {event.text ? <ChatText text={event.text} /> : null}
      <ChatPhotos urls={event.images || []} />
      {(event.listings || []).length ? (
        <span className="chat-tags">
          {(event.listings || []).map((row, index) => (
            <ChatListingTag key={`${tagKey(row)}:${index}`} row={row} peer={{ username: peer }} me={me} />
          ))}
        </span>
      ) : null}
      <time>{chatTime(event.createdAt)}</time>
    </div>
  );
}

export function Conversation() {
  const { username = '' } = useParams();
  const peer = decodeURIComponent(username).trim().toLowerCase();
  if (isPokoPeer(peer)) return <PokoConversation />;
  return <HumanConversation peer={peer} />;
}

function cardPayload(row) {
  return {
    cardId: String(row?.cardId || row?.id || ''),
    name: String(row?.cardName || row?.name || ''),
    setName: String(row?.setName || row?.set || ''),
    condition: String(row?.condition || ''),
    language: String(row?.language || ''),
    canonicalPath: String(row?.canonicalPath || row?.href || ''),
    imageUrl: String(row?.imageUrl || row?.cardImageUrl || ''),
    cardName: String(row?.cardName || row?.name || ''),
  };
}

function PokoConversation() {
  const navigate = useNavigate();
  const { ready, signedIn, getBearer, user, profile } = useAuth();
  const uid = user?.uid || '';
  const [text, setText] = useState('');
  const [cards, setCards] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const [over, setOver] = useState(false);
  const pokoThread = usePokoThread({
    uid,
    signedIn,
    getBearer,
    enabled: ready && signedIn,
    pathname: typeof window !== 'undefined' ? window.location.pathname : '',
  });
  const events = pokoThread.events;
  const busy = photoBusy || pokoThread.busy;
  const error = photoError || pokoThread.error;

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('pokoin.pokoPendingCard');
      if (!raw) return;
      sessionStorage.removeItem('pokoin.pokoPendingCard');
      const next = cardPayload(JSON.parse(raw));
      if (next.cardId || next.name) setCards([next]);
    } catch (_) { /* ignore */ }
  }, []);

  function addCard(reference) {
    const next = cardPayload(reference);
    if (!next.cardId && !next.name) return;
    setCards((current) => {
      const key = `${next.cardId}|${next.name}|${next.condition}`;
      if (current.some((row) => `${row.cardId}|${row.name}|${row.condition}` === key)) return current;
      return [...current, next].slice(-4);
    });
  }

  async function addPhotoFiles(files) {
    const room = MAX_CHAT_PHOTOS - photos.length;
    const list = [...files].filter(Boolean).slice(0, room);
    if (!list.length || room <= 0) return;
    setPhotoBusy(true);
    setPhotoError('');
    try {
      const token = await getBearer();
      const next = [];
      for (const file of list) {
        const dataUrl = await photoFileToJpeg(file);
        const saved = await uploadChatPhoto(token, dataUrl, 'chat');
        if (saved?.url) next.push(saved.url);
      }
      setPhotos((current) => [...current, ...next].slice(0, MAX_CHAT_PHOTOS));
    } catch (err) {
      setPhotoError(err.message || 'Photo was not added.');
    } finally {
      setPhotoBusy(false);
    }
  }

  function addPhotos(event) {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    addPhotoFiles(files);
  }

  function pastePhotos(event) {
    const files = imageFilesFromClipboard(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    addPhotoFiles(files);
  }

  async function send(event) {
    event?.preventDefault();
    const message = text.trim();
    if (busy || (!message && !cards.length && !photos.length)) return;
    const tags = cards.slice();
    const attachedImages = photos.slice();
    setText('');
    setCards([]);
    setPhotos([]);
    setPhotoError('');
    try {
      await pokoThread.send({ message, tags, photos: attachedImages });
    } catch (_) {
      /* error surfaced via pokoThread.error */
    }
  }

  if (!ready) return <main className="messages-page messages-empty" aria-busy="true">Loading…</main>;
  if (ready && !signedIn) return <SignInGate />;

  return (
    <main
      className={`conversation-page${over ? ' is-poko-over' : ''}`}
      onDragOver={(event) => {
        if (![...(event.dataTransfer?.types || [])].includes(LISTING_DRAG_TYPE)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const reference = readListingDrag(event);
        if (reference) {
          acceptTrayDrop(messagesTrayId(POKO_PEER));
          addCard(reference);
        }
      }}
    >
      <header className="conversation-head">
        <button type="button" onClick={() => navigate('/messages')} aria-label="Back to messages">‹</button>
        <span className="conversation-person">
          <PokoAvatar className="messages-avatar is-poko" />
          <span>
            <strong>{POKO_DISPLAY}</strong>
            <span>Pokoin conversation</span>
          </span>
        </span>
      </header>
      {error ? <p className="chat-error conversation-error" role="alert">{error}</p> : null}
      <section className="chat-timeline" ref={pokoThread.logRef} onScroll={pokoThread.onScroll} aria-live="polite">
        {!events.length ? (
          <div className="chat-first">
            <h2>Say hello to {POKO_DISPLAY}</h2>
            <p>Messages appear here in chronological order. Drop a card or add a photo anytime.</p>
          </div>
        ) : events.map((event) => (
          <div key={event.id} className={`chat-bubble${event.mine ? ' mine' : ''}${event.source === 'unavailable' ? ' is-unavailable' : ''}`}>
            {event.text ? <ChatText text={event.text} /> : null}
            {event.source === 'unavailable' ? (
              <p className="chat-muted">Could not reply — try again.</p>
            ) : null}
            <ChatPhotos urls={event.images || []} />
            {(event.listings || event.cards || []).length ? (
              <span className="chat-tags">
                {(event.listings || event.cards || []).map((row, index) => (
                  <ChatListingTag key={`${tagKey(row)}:${index}`} row={row} peer={{ username: POKO_PEER }} me={{ uid, username: profile?.username }} />
                ))}
              </span>
            ) : null}
            <time>{chatTime(event.createdAt)}</time>
          </div>
        ))}
        {pokoThread.busy ? <p className="chat-muted">…</p> : null}
      </section>
      {cards.length ? (
        <div className="chat-photo-draft poko-card-draft">
          <span className="chat-tags">
            {cards.map((row, index) => (
              <ChatListingTag
                key={`${tagKey(row)}:${index}`}
                row={row}
                trayId={messagesTrayId(POKO_PEER)}
                peer={{ username: POKO_PEER }}
                me={{ uid, username: profile?.username }}
                onRemove={() => setCards((current) => current.filter((_, i) => i !== index))}
              />
            ))}
          </span>
          <button type="button" onClick={() => setCards([])}>Clear cards</button>
        </div>
      ) : null}
      {photos.length ? (
        <div className="chat-photo-draft">
          <ChatPhotos urls={photos} />
          <button type="button" onClick={() => setPhotos([])}>Clear photos</button>
        </div>
      ) : null}
      {!cards.length && !photos.length ? (
        <p className="poko-drop-hint">Drag a listing or card onto this chat, paste a photo, or tap +.</p>
      ) : null}
      <form className="chat-composer" onSubmit={send}>
        <label className="chat-photo-add" aria-label="Add photos">
          +
          <input type="file" accept="image/*" multiple hidden onChange={addPhotos} disabled={busy || photos.length >= MAX_CHAT_PHOTOS} />
        </label>
        <label className="sr-only" htmlFor="poko-message">Message Poko</label>
        <textarea
          id="poko-message"
          rows="1"
          maxLength={1000}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Message Poko"
          onPaste={pastePhotos}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send(event);
            }
          }}
        />
        <button type="submit" disabled={busy || (!text.trim() && !cards.length && !photos.length)} aria-label="Send to Poko">↑</button>
      </form>
    </main>
  );
}

function HumanConversation({ peer }) {
  const lang = useSearchLang();
  const navigate = useNavigate();
  const { ready, signedIn, getBearer, user, profile } = useAuth();
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState([]);
  const [moneyMode, setMoneyMode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const thread = useChatThread({ peer, signedIn, getBearer, enabled: signedIn && Boolean(peer) });

  useEffect(() => {
    if (!peer || isPokoPeer(peer)) return undefined;
    warmSellerFromChat({
      username: thread.person?.username || peer,
      uid: thread.person?.uid,
      displayName: thread.person?.displayName,
      photoUrl: thread.person?.photoUrl,
      game: game().apiGame,
    });
    return undefined;
  }, [peer, thread.person]);

  async function addPhotoFiles(files) {
    const room = MAX_CHAT_PHOTOS - photos.length;
    const list = [...files].filter(Boolean).slice(0, room);
    if (!list.length || room <= 0) return;
    setBusy(true); setError('');
    try {
      const token = await getBearer();
      const next = [];
      for (const file of list) {
        const dataUrl = await photoFileToJpeg(file);
        const saved = await uploadChatPhoto(token, dataUrl, 'chat');
        if (saved?.url) next.push(saved.url);
      }
      setPhotos((current) => [...current, ...next].slice(0, MAX_CHAT_PHOTOS));
    } catch (err) { setError(err.message || 'Photo was not added.'); }
    finally { setBusy(false); }
  }

  function addPhotos(event) {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    addPhotoFiles(files);
  }

  function pastePhotos(event) {
    const files = imageFilesFromClipboard(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    addPhotoFiles(files);
  }

  async function send(event) {
    event.preventDefault();
    const message = text.trim();
    if (busy || (!message && !photos.length)) return;
    setBusy(true); setError('');
    try {
      const token = await getBearer();
      await sendChatMessage(peer, message, token, [], '', photos);
      setText('');
      setPhotos([]);
      await thread.refresh();
    }
    catch (err) { setError(err.message || 'Message was not sent.'); }
    finally { setBusy(false); }
  }

  async function actOnRequest(event, action) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const token = await getBearer();
      if (action === 'pay') await payMoneyRequest(event.requestId, token);
      else await respondMoneyRequest(event.requestId, action, token);
      setFlash(action === 'pay' ? `${event.amountPkn} PKN paid` : `Request ${action}d`);
      await thread.refresh();
    } catch (err) { setError(err.message || 'Request could not be updated.'); }
    finally { setBusy(false); }
  }

  if (!ready && !thread.events.length) return <main className="messages-page messages-empty" aria-busy="true">Loading…</main>;
  if (ready && !signedIn) return <SignInGate />;
  return (
    <main className="conversation-page">
      <header className="conversation-head">
        <button type="button" onClick={() => navigate('/messages')} aria-label="Back to messages">‹</button>
        <Link className="conversation-person" to={`/marketplace/${lang}/users/${encodeURIComponent(peer)}`}>
          <Avatar src={chatPersonPhoto(thread.person)} seed={thread.person?.uid} name={chatPersonName({ ...thread.person, peerUsername: peer })} size={38} />
          <span>
            <strong>{chatPersonName({ ...thread.person, peerUsername: peer })}</strong>
            <span>Pokoin conversation</span>
          </span>
        </Link>
      </header>
      {flash && <button className="chat-flash" type="button" onClick={() => setFlash('')}>{flash} ✓</button>}
      {(error || thread.error) && <p className="chat-error conversation-error" role="alert">{error || thread.error}</p>}
      <section className="chat-timeline" ref={thread.logRef} onScroll={thread.onScroll} aria-live="polite" aria-busy={!thread.settled && !thread.events.length}>
        {!thread.settled && !thread.events.length ? <p className="chat-muted">Loading conversation…</p> : thread.events.length ? thread.events.map((event) => <EventCard key={event.id} event={event} busy={busy} onAction={actOnRequest} peer={peer} me={{ uid: user?.uid, username: profile?.username }} />) : <div className="chat-first"><h2>Say hello to @{peer}</h2><p>Messages, requests, and payments appear here in chronological order.</p></div>}
      </section>
      <div className="chat-tools"><button type="button" onClick={() => setMoneyMode('request')}>Request</button><button type="button" onClick={() => setMoneyMode('send')}>Send PKN</button></div>
      {photos.length ? <div className="chat-photo-draft"><ChatPhotos urls={photos} /><button type="button" onClick={() => setPhotos([])}>Clear photos</button></div> : null}
      <form className="chat-composer" onSubmit={send}><label className="chat-photo-add" aria-label="Add photos">+<input type="file" accept="image/*" multiple hidden onChange={addPhotos} disabled={busy || photos.length >= MAX_CHAT_PHOTOS} /></label><label className="sr-only" htmlFor="chat-message">Message</label><textarea id="chat-message" rows="1" maxLength={1000} value={text} onChange={(event) => setText(event.target.value)} placeholder={`Message @${peer}`} onPaste={pastePhotos} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(event); } }} /><button type="submit" disabled={busy || (!text.trim() && !photos.length)} aria-label="Send message">↑</button></form>
      {moneyMode && <MoneyModal mode={moneyMode} peer={peer} onClose={() => setMoneyMode('')} onDone={(message) => { setMoneyMode(''); setFlash(message); thread.refresh(); }} />}
    </main>
  );
}
