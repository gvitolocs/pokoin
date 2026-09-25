import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { searchRecipientUsernames } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  listConversations,
  newClientToken,
  sendChatMessage,
  sendChatPayment,
} from '../chat-client.js';
import { useChatThread } from '../use-chat-thread.js';
import { chatTime, eventAriaLabel, requestActionFor } from '../chat-format.js';
import { tagKey } from '../chat-listing.js';
import ChatListingTag from '../components/ChatListingTag.jsx';
import { createMoneyRequest, payMoneyRequest, requestStatusLabel, respondMoneyRequest } from '../money-requests.js';

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
  const { ready, signedIn, getBearer } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    if (!signedIn) return;
    try {
      const token = await getBearer();
      const result = await listConversations(token);
      setRows(result.conversations || []);
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

  if (!ready) return <main className="messages-page messages-empty" aria-busy="true">Loading…</main>;
  if (!signedIn) return <SignInGate />;
  return (
    <main className="messages-page">
      <header className="messages-title-row"><div><p className="messages-kicker">Your people</p><h1>Messages</h1></div><button className="messages-new" type="button" onClick={() => setCreating(true)}>New message</button></header>
      {error && <p className="chat-error" role="alert">{error}</p>}
      {loading ? <div className="messages-list-skeleton" aria-label="Loading conversations" /> : rows.length ? (
        <div className="messages-list">{rows.map((row) => (
          <Link key={row.pairKey} className="messages-row" to={`/messages/${encodeURIComponent(row.peerUsername)}`}>
            <span className="messages-avatar" aria-hidden="true">{row.peerUsername?.slice(0, 1).toUpperCase() || '?'}</span>
            <span className="messages-row-copy"><strong>@{row.peerUsername || 'Pokoin user'}</strong><span>{row.preview || 'Start the conversation'}</span></span>
            <span className="messages-row-meta"><time>{chatTime(row.updatedAt)}</time>{row.unread > 0 && <b aria-label={`${row.unread} unread`}>{row.unread}</b>}</span>
          </Link>
        ))}</div>
      ) : (
        <div className="messages-empty-card compact"><h2>No conversations yet</h2><p>Message someone by their Pokoin username. Payments and requests stay in the same timeline.</p><button className="wallet-primary" type="button" onClick={() => setCreating(true)}>Start a conversation</button></div>
      )}
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
      {event.text ? <p>{event.text}</p> : null}
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
  const navigate = useNavigate();
  const { ready, signedIn, getBearer, user, profile } = useAuth();
  const [text, setText] = useState('');
  const [moneyMode, setMoneyMode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const thread = useChatThread({ peer, signedIn, getBearer, enabled: signedIn && Boolean(peer) });

  async function send(event) {
    event.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true); setError('');
    try { const token = await getBearer(); await sendChatMessage(peer, message, token); setText(''); await thread.refresh(); }
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
      <header className="conversation-head"><button type="button" onClick={() => navigate('/messages')} aria-label="Back to messages">‹</button><span className="messages-avatar" aria-hidden="true">{peer.slice(0, 1).toUpperCase()}</span><div><strong>@{peer}</strong><span>Pokoin conversation</span></div></header>
      {flash && <button className="chat-flash" type="button" onClick={() => setFlash('')}>{flash} ✓</button>}
      {(error || thread.error) && <p className="chat-error conversation-error" role="alert">{error || thread.error}</p>}
      <section className="chat-timeline" ref={thread.logRef} onScroll={thread.onScroll} aria-live="polite" aria-busy={!thread.settled && !thread.events.length}>
        {!thread.settled && !thread.events.length ? <p className="chat-muted">Loading conversation…</p> : thread.events.length ? thread.events.map((event) => <EventCard key={event.id} event={event} busy={busy} onAction={actOnRequest} peer={peer} me={{ uid: user?.uid, username: profile?.username }} />) : <div className="chat-first"><h2>Say hello to @{peer}</h2><p>Messages, requests, and payments appear here in chronological order.</p></div>}
      </section>
      <div className="chat-tools"><button type="button" onClick={() => setMoneyMode('request')}>Request</button><button type="button" onClick={() => setMoneyMode('send')}>Send PKN</button></div>
      <form className="chat-composer" onSubmit={send}><label className="sr-only" htmlFor="chat-message">Message</label><textarea id="chat-message" rows="1" maxLength={1000} value={text} onChange={(event) => setText(event.target.value)} placeholder={`Message @${peer}`} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(event); } }} /><button type="submit" disabled={!text.trim() || busy} aria-label="Send message">↑</button></form>
      {moneyMode && <MoneyModal mode={moneyMode} peer={peer} onClose={() => setMoneyMode('')} onDone={(message) => { setMoneyMode(''); setFlash(message); thread.refresh(); }} />}
    </main>
  );
}
