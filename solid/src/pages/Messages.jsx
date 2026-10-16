import { createEffect, createMemo, createSignal, For, Match, onSettled, Show, Switch, untrack } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import { searchRecipientUsernames } from '@market/api.js';
import {
  listConversations,
  newClientToken,
  sendChatMessage,
  sendChatPayment,
  uploadChatPhoto,
} from '@market/chat-client.js';
import { chatPersonName, chatPersonPhoto, chatTime, eventAriaLabel, requestActionFor } from '@market/chat-format.js';
import { chatPreviewsLookSame, mergeChatPreviewRows, paintableChatPreviews, readChatPreviews, writeChatPreviews } from '@market/chat-history.js';
import { LISTING_DRAG_TYPE, readListingDrag, tagKey } from '@market/chat-listing.js';
import { game } from '@market/game.js';
import { createMoneyRequest, payMoneyRequest, requestStatusLabel, respondMoneyRequest } from '@market/money-requests.js';
import { isPokoPeer, POKO_DISPLAY, POKO_PEER, pokoPreview, readPokoHistory } from '@market/poko-chat.js';
import { warmSellerFromChat } from '@market/seller-seed.js';
import { acceptTrayDrop, messagesTrayId } from '@market/tray-drag.js';
import { MAX_CHAT_PHOTOS, imageFilesFromClipboard, photoFileToJpeg } from '@market/user-photos.js';
import mascotUrl from '@market/assets/pokoin-mascot@8x.png';
import AuthLink from '../components/AuthLink.jsx';
import Avatar from '../components/Avatar.jsx';
import ChatListingTag from '../components/ChatListingTag.jsx';
import ChatPhotos from '../components/ChatPhotos.jsx';
import ChatText from '../components/ChatText.jsx';
import { createChatThread } from '../lib/chat-thread.js';
import { createPokoThread } from '../lib/poko-thread.js';
import { accountProfile } from '../stores/account.js';
import { authConfirmed, authUid, getBearer, loadAuth, signedIn } from '../stores/auth.js';
import { searchLang } from '../stores/locale.js';

/** React useAuth().signedIn on these pages: the cached hint until Firebase answers. */
const ready = authConfirmed;

function PokoAvatar(props) {
  return (
    <span class={props.class || 'messages-avatar is-poko'} aria-hidden="true">
      <img src={mascotUrl} alt="" />
    </span>
  );
}

function Busy() {
  return <main class="messages-page messages-empty" aria-busy="true">Loading…</main>;
}

function SignInGate() {
  return (
    <main class="messages-page messages-empty">
      <div class="messages-empty-card">
        <span class="messages-mark" aria-hidden="true">↔</span>
        <h1>Messages and payments</h1>
        <p>Sign in to talk, request PKN, and pay people you trust in one private conversation.</p>
        <AuthLink class="wallet-primary" to="/auth?from=%2Fmessages">Sign in</AuthLink>
      </div>
    </main>
  );
}

const USERNAME = /^[a-z0-9]{3,32}$/;

function NewConversation(props) {
  const navigate = useNavigate();
  const [query, setQuery] = createSignal('');
  const [rows, setRows] = createSignal([]);
  const clean = () => query().trim().toLowerCase();

  createEffect(clean, (value) => {
    if (value.length < 2) {
      setRows([]);
      return undefined;
    }
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const token = await getBearer();
        const result = await searchRecipientUsernames(value, token);
        if (live) setRows((result.usernames || []).slice(0, 6));
      } catch (_) {
        if (live) setRows([]);
      }
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  });

  function open(username = clean()) {
    const target = String(username || '').trim().toLowerCase();
    if (!USERNAME.test(target)) return;
    props.onClose();
    navigate(`/messages/${encodeURIComponent(target)}`);
  }

  return (
    <div class="chat-modal-backdrop" onClick={() => props.onClose()}>
      <section class="chat-modal" role="dialog" aria-modal="true" aria-labelledby="new-chat-title" onClick={(event) => event.stopPropagation()}>
        <div class="chat-modal-head"><h2 id="new-chat-title">New conversation</h2><button type="button" onClick={() => props.onClose()} aria-label="Close">×</button></div>
        <label class="chat-field">Pokoin username<input ref={(el) => queueMicrotask(() => el.focus())} value={query()} onInput={(event) => setQuery(event.target.value)} placeholder="username" autocomplete="off" /></label>
        <Show when={rows().length > 0}>
          <div class="chat-user-results">
            <For each={rows()}>
              {(row) => {
                const username = typeof row === 'string' ? row : row.username;
                return <button type="button" onClick={() => open(username)}>@{username}</button>;
              }}
            </For>
          </div>
        </Show>
        <button class="wallet-primary" type="button" disabled={!USERNAME.test(clean())} onClick={() => open()}>Open conversation</button>
      </section>
    </div>
  );
}

/** /messages: Poko first, then the cached previews, refreshed every 15 s. */
export default function Messages() {
  loadAuth().catch(() => {});
  const first = paintableChatPreviews();
  const [rows, setRows] = createSignal(first);
  const [loading, setLoading] = createSignal(first.length === 0);
  const [error, setError] = createSignal('');
  const [creating, setCreating] = createSignal(false);
  const pokoEvents = () => readPokoHistory(authUid()).events;

  async function refresh() {
    if (!untrack(signedIn)) return;
    try {
      const token = await getBearer();
      const result = await listConversations(token);
      const next = mergeChatPreviewRows(readChatPreviews(), result.conversations || []);
      writeChatPreviews(next);
      const current = untrack(rows);
      if (!chatPreviewsLookSame(current, next)) setRows(next);
      setError('');
    } catch (err) {
      setError(err.message || 'Messages could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  createEffect(signedIn, () => {
    refresh();
    const timer = setInterval(refresh, 15000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); };
  });

  return (
    <Switch>
      <Match when={!ready() && !rows().length}><Busy /></Match>
      <Match when={ready() && !signedIn()}><SignInGate /></Match>
      <Match when={true}>
        <main class="messages-page">
          <header class="messages-title-row"><div><p class="messages-kicker">Your people</p><h1>Messages</h1></div><button class="messages-new" type="button" onClick={() => setCreating(true)}>New message</button></header>
          <Show when={error()}><p class="chat-error" role="alert">{error()}</p></Show>
          <div class="messages-list">
            <a class="messages-row is-poko" href={`/messages/${POKO_PEER}`}>
              <PokoAvatar />
              <span class="messages-row-copy">
                <strong>{POKO_DISPLAY}</strong>
                <span>{pokoPreview(pokoEvents())}</span>
              </span>
              <span class="messages-row-meta"><time>Assistant</time></span>
            </a>
            <Show when={!loading()} fallback={<div class="messages-list-skeleton" aria-label="Loading conversations" />}>
              <For each={rows()} keyed={(row) => row.pairKey}>
                {(row) => (
                  <a class="messages-row" href={`/messages/${encodeURIComponent(row().peerUsername)}`}>
                    <Avatar src={chatPersonPhoto(row())} seed={row().peerUid} name={chatPersonName(row())} size={42} />
                    <span class="messages-row-copy"><strong>{chatPersonName(row())}</strong><span>{row().preview || 'Start the conversation'}</span></span>
                    <span class="messages-row-meta">
                      <time>{chatTime(row().updatedAt)}</time>
                      <Show when={row().unread > 0}><b aria-label={`${row().unread} unread`}>{row().unread}</b></Show>
                    </span>
                  </a>
                )}
              </For>
            </Show>
          </div>
          <Show when={!loading() && !rows().length}>
            <p class="messages-hint">Chat with Poko about cards above, or start a conversation with another Pokoin username.</p>
          </Show>
          <Show when={creating()}><NewConversation onClose={() => setCreating(false)} /></Show>
        </main>
      </Match>
    </Switch>
  );
}

function MoneyModal(props) {
  const [amount, setAmount] = createSignal('');
  const [note, setNote] = createSignal('');
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const amountPkn = () => Number(amount());
  const send = () => props.mode === 'send';

  async function submit() {
    const pkn = amountPkn();
    if (!Number.isInteger(pkn) || pkn <= 0) { setError('Enter a whole PKN amount greater than zero.'); return; }
    if (!confirming()) { setConfirming(true); return; }
    setBusy(true); setError('');
    try {
      const token = await getBearer();
      if (send()) await sendChatPayment(props.peer, pkn, note(), newClientToken(), token);
      else await createMoneyRequest({ recipientUsername: props.peer, amountPkn: pkn, note: note(), clientToken: newClientToken() }, token);
      props.onDone(send() ? `${pkn} PKN sent` : `${pkn} PKN requested`);
    } catch (err) {
      setError(err.message || 'The action could not be completed.'); setConfirming(false);
    } finally { setBusy(false); }
  }

  return (
    <div class="chat-modal-backdrop" onClick={() => props.onClose()}>
      <section class="chat-modal" role="dialog" aria-modal="true" aria-labelledby="money-modal-title" onClick={(event) => event.stopPropagation()}>
        <div class="chat-modal-head"><h2 id="money-modal-title">{send() ? 'Send PKN' : 'Request PKN'}</h2><button type="button" onClick={() => props.onClose()} aria-label="Close">×</button></div>
        <Show
          when={confirming()}
          fallback={(
            <>
              <label class="chat-field">Amount<input inputmode="numeric" value={amount()} onInput={(event) => { const v = event.target.value.replace(/\D/g, ''); event.target.value = v; setAmount(v); }} placeholder="0" /></label>
              <label class="chat-field">Note (optional)<input value={note()} maxLength={140} onInput={(event) => setNote(event.target.value)} placeholder="What is this for?" /></label>
            </>
          )}
        >
          <div class="chat-confirm"><span>{send() ? 'Send' : 'Request'}</span><strong>{amountPkn()} PKN</strong><p>{send() ? 'This balance transfer cannot be undone.' : `@${props.peer} can pay or decline in this chat.`}</p></div>
        </Show>
        <Show when={error()}><p class="chat-error" role="alert">{error()}</p></Show>
        <button class="wallet-primary" type="button" disabled={busy()} onClick={submit}>{busy() ? 'Working…' : confirming() ? `Confirm ${props.mode}` : 'Review'}</button>
        <Show when={confirming()}><button class="chat-secondary" type="button" disabled={busy()} onClick={() => setConfirming(false)}>Back</button></Show>
      </section>
    </div>
  );
}

function EventCard(props) {
  const event = () => props.event;
  const action = () => requestActionFor(event());
  return (
    <Switch>
      <Match when={event().type === 'money_request'}>
        <article class={['chat-money-card', { mine: Boolean(event().mine) }]} aria-label={eventAriaLabel(event())}>
          <span class="chat-money-kind">PKN request</span><strong>{event().amountPkn} PKN</strong>
          <Show when={event().note}><p>{event().note}</p></Show>
          <span class={['chat-status', event().requestStatus || 'pending']}>{requestStatusLabel(event().requestStatus)}</span>
          <Show when={action() === 'pay'}>
            <div class="chat-card-actions"><button disabled={props.busy} type="button" onClick={() => props.onAction(event(), 'pay')}>Pay request</button><button disabled={props.busy} type="button" onClick={() => props.onAction(event(), 'decline')}>Decline</button></div>
          </Show>
          <Show when={action() === 'cancel'}>
            <button class="chat-link-button" disabled={props.busy} type="button" onClick={() => props.onAction(event(), 'cancel')}>Cancel request</button>
          </Show>
          <time>{chatTime(event().createdAt)}</time>
        </article>
      </Match>
      <Match when={event().type === 'payment'}>
        <article class={['chat-money-card', 'payment', { mine: Boolean(event().mine) }]} aria-label={eventAriaLabel(event())}>
          <span class="chat-money-kind">{event().mine ? 'You sent' : 'You received'}</span><strong>{event().amountPkn} PKN</strong>
          <Show when={event().note}><p>{event().note}</p></Show>
          <span class="chat-status paid">Paid ✓</span><time>{chatTime(event().createdAt)}</time>
        </article>
      </Match>
      <Match when={true}>
        <div class={['chat-bubble', { mine: Boolean(event().mine) }]} aria-label={eventAriaLabel(event())}>
          <Show when={event().text}><ChatText text={event().text} /></Show>
          <ChatPhotos urls={event().images || []} />
          <Show when={(event().listings || []).length}>
            <span class="chat-tags">
              <For each={event().listings || []}>
                {(row) => <ChatListingTag row={row} peer={{ username: props.peer }} me={props.me} />}
              </For>
            </span>
          </Show>
          <time>{chatTime(event().createdAt)}</time>
        </div>
      </Match>
    </Switch>
  );
}

/** /messages/:username — Poko or a person-to-person thread. */
export function Conversation() {
  loadAuth().catch(() => {});
  const params = useParams();
  const peer = createMemo(() => decodeURIComponent(params.username || '').trim().toLowerCase());
  return (
    <Show when={!isPokoPeer(peer())} fallback={<PokoConversation />}>
      <Show when={peer()} keyed>{(name) => <HumanConversation peer={name} />}</Show>
    </Show>
  );
}

function cardPayload(row) {
  const path = String(row?.path || row?.canonicalPath || row?.href || '');
  const gameId = String(row?.game || '').trim();
  return {
    cardId: String(row?.cardId || row?.id || ''),
    name: String(row?.cardName || row?.name || ''),
    setName: String(row?.setName || row?.set || ''),
    condition: String(row?.condition || ''),
    language: String(row?.language || ''),
    canonicalPath: path,
    path,
    imageUrl: String(row?.imageUrl || row?.cardImageUrl || ''),
    cardName: String(row?.cardName || row?.name || ''),
    ...(gameId ? { game: gameId } : {}),
  };
}

function readPendingCard() {
  try {
    const raw = sessionStorage.getItem('pokoin.pokoPendingCard');
    if (!raw) return [];
    sessionStorage.removeItem('pokoin.pokoPendingCard');
    const next = cardPayload(JSON.parse(raw));
    return next.cardId || next.name ? [next] : [];
  } catch (_) {
    return [];
  }
}

function PokoConversation() {
  const navigate = useNavigate();
  const [text, setText] = createSignal('');
  const [cards, setCards] = createSignal(readPendingCard());
  const [photos, setPhotos] = createSignal([]);
  const [photoBusy, setPhotoBusy] = createSignal(false);
  const [photoError, setPhotoError] = createSignal('');
  const [over, setOver] = createSignal(false);
  const pokoThread = createPokoThread({
    uid: authUid,
    signedIn,
    getBearer,
    enabled: () => ready() && signedIn(),
    pathname: () => window.location.pathname,
  });
  const events = () => pokoThread.events();
  const busy = () => photoBusy() || pokoThread.busy();
  const error = () => photoError() || pokoThread.error();
  const me = () => ({ uid: authUid(), username: accountProfile()?.username });

  function addCard(reference) {
    const next = cardPayload(reference);
    if (!next.cardId && !next.name) return;
    const current = cards();
    const key = `${next.cardId}|${next.name}|${next.condition}`;
    if (current.some((row) => `${row.cardId}|${row.name}|${row.condition}` === key)) return;
    setCards([...current, next].slice(-4));
  }

  async function addPhotoFiles(files) {
    const room = MAX_CHAT_PHOTOS - photos().length;
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
    const message = text().trim();
    if (busy() || (!message && !cards().length && !photos().length)) return;
    const tags = cards().slice();
    const attachedImages = photos().slice();
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

  const tagsOf = (event) => event.listings || event.cards || [];

  return (
    <Switch>
      <Match when={!ready()}><Busy /></Match>
      <Match when={!signedIn()}><SignInGate /></Match>
      <Match when={true}>
        <main
          class={['conversation-page', { 'is-poko-over': over() }]}
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
          <header class="conversation-head">
            <button type="button" onClick={() => navigate('/messages')} aria-label="Back to messages">‹</button>
            <span class="conversation-person">
              <PokoAvatar class="messages-avatar is-poko" />
              <span>
                <strong>{POKO_DISPLAY}</strong>
                <span>Pokoin conversation</span>
              </span>
            </span>
          </header>
          <Show when={error()}><p class="chat-error conversation-error" role="alert">{error()}</p></Show>
          <section class="chat-timeline" ref={pokoThread.setLog} onScroll={pokoThread.onScroll} aria-live="polite">
            <For
              each={events()}
              keyed={(event) => event.id}
              fallback={(
                <div class="chat-first">
                  <h2>Say hello to {POKO_DISPLAY}</h2>
                  <p>Messages appear here in chronological order. Drop a card or add a photo anytime.</p>
                </div>
              )}
            >
              {(event) => (
                <div class={['chat-bubble', { mine: Boolean(event().mine), 'is-unavailable': event().source === 'unavailable' }]}>
                  <Show when={event().text}><ChatText text={event().text} /></Show>
                  <Show when={event().source === 'unavailable'}>
                    <p class="chat-muted">Could not reply — try again.</p>
                  </Show>
                  <ChatPhotos urls={event().images || []} />
                  <Show when={tagsOf(event()).length}>
                    <span class="chat-tags">
                      <For each={tagsOf(event())}>
                        {(row) => <ChatListingTag row={row} peer={{ username: POKO_PEER }} me={me()} defaultGame="pokemon" />}
                      </For>
                    </span>
                  </Show>
                  <time>{chatTime(event().createdAt)}</time>
                </div>
              )}
            </For>
            <Show when={pokoThread.busy()}><p class="chat-muted">…</p></Show>
          </section>
          <Show when={cards().length}>
            <div class="chat-photo-draft poko-card-draft">
              <span class="chat-tags">
                <For each={cards()}>
                  {(row, index) => (
                    <ChatListingTag
                      row={row}
                      trayId={messagesTrayId(POKO_PEER)}
                      peer={{ username: POKO_PEER }}
                      me={me()}
                      defaultGame="pokemon"
                      onRemove={() => setCards((current) => current.filter((_, i) => i !== index()))}
                    />
                  )}
                </For>
              </span>
              <button type="button" onClick={() => setCards([])}>Clear cards</button>
            </div>
          </Show>
          <Show when={photos().length}>
            <div class="chat-photo-draft">
              <ChatPhotos urls={photos()} />
              <button type="button" onClick={() => setPhotos([])}>Clear photos</button>
            </div>
          </Show>
          <Show when={!cards().length && !photos().length}>
            <p class="poko-drop-hint">Drag a listing or card onto this chat, paste a photo, or tap +.</p>
          </Show>
          <form class="chat-composer" onSubmit={send}>
            <label class="chat-photo-add" aria-label="Add photos">
              +
              <input type="file" accept="image/*" multiple hidden onChange={addPhotos} disabled={busy() || photos().length >= MAX_CHAT_PHOTOS} />
            </label>
            <label class="sr-only" for="poko-message">Message Poko</label>
            <textarea
              id="poko-message"
              rows="1"
              maxLength={1000}
              value={text()}
              onInput={(event) => setText(event.target.value)}
              placeholder="Message Poko"
              onPaste={pastePhotos}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send(event);
                }
              }}
            />
            <button type="submit" disabled={busy() || (!text().trim() && !cards().length && !photos().length)} aria-label="Send to Poko">↑</button>
          </form>
        </main>
      </Match>
    </Switch>
  );
}

function HumanConversation(props) {
  const peer = props.peer;
  const navigate = useNavigate();
  const [text, setText] = createSignal('');
  const [photos, setPhotos] = createSignal([]);
  const [moneyMode, setMoneyMode] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [flash, setFlash] = createSignal('');
  const thread = createChatThread({
    peerUid: () => '',
    peer: () => peer,
    signedIn,
    getBearer,
    enabled: () => signedIn() && Boolean(peer),
  });
  const person = () => thread.person();
  const name = () => chatPersonName({ ...person(), peerUsername: peer });
  const me = () => ({ uid: authUid(), username: accountProfile()?.username });

  createEffect(person, (who) => {
    warmSellerFromChat({
      username: who?.username || peer,
      uid: who?.uid,
      displayName: who?.displayName,
      photoUrl: who?.photoUrl,
      game: game().apiGame,
    });
  });

  async function addPhotoFiles(files) {
    const room = MAX_CHAT_PHOTOS - photos().length;
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
    const message = text().trim();
    if (busy() || (!message && !photos().length)) return;
    setBusy(true); setError('');
    try {
      const token = await getBearer();
      await sendChatMessage(peer, message, token, [], '', photos());
      setText('');
      setPhotos([]);
      await thread.refresh();
    }
    catch (err) { setError(err.message || 'Message was not sent.'); }
    finally { setBusy(false); }
  }

  async function actOnRequest(event, action) {
    if (busy()) return;
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

  return (
    <Switch>
      <Match when={!ready() && !thread.events().length}><Busy /></Match>
      <Match when={ready() && !signedIn()}><SignInGate /></Match>
      <Match when={true}>
        <main class="conversation-page">
          <header class="conversation-head">
            <button type="button" onClick={() => navigate('/messages')} aria-label="Back to messages">‹</button>
            <a class="conversation-person" href={`/marketplace/${searchLang()}/users/${encodeURIComponent(peer)}`}>
              <Avatar src={chatPersonPhoto(person())} seed={person()?.uid} name={name()} size={38} />
              <span>
                <strong>{name()}</strong>
                <span>Pokoin conversation</span>
              </span>
            </a>
          </header>
          <Show when={flash()}><button class="chat-flash" type="button" onClick={() => setFlash('')}>{flash()} ✓</button></Show>
          <Show when={error() || thread.error()}><p class="chat-error conversation-error" role="alert">{error() || thread.error()}</p></Show>
          <section
            class="chat-timeline"
            ref={thread.setLog}
            onScroll={thread.onScroll}
            aria-live="polite"
            aria-busy={String(!thread.settled() && !thread.events().length)}
          >
            <Switch>
              <Match when={!thread.settled() && !thread.events().length}><p class="chat-muted">Loading conversation…</p></Match>
              <Match when={thread.events().length}>
                <For each={thread.events()} keyed={(event) => event.id}>
                  {(event) => <EventCard event={event()} busy={busy()} onAction={actOnRequest} peer={peer} me={me()} />}
                </For>
              </Match>
              <Match when={true}>
                <div class="chat-first"><h2>Say hello to @{peer}</h2><p>Messages, requests, and payments appear here in chronological order.</p></div>
              </Match>
            </Switch>
          </section>
          <div class="chat-tools"><button type="button" onClick={() => setMoneyMode('request')}>Request</button><button type="button" onClick={() => setMoneyMode('send')}>Send PKN</button></div>
          <Show when={photos().length}>
            <div class="chat-photo-draft"><ChatPhotos urls={photos()} /><button type="button" onClick={() => setPhotos([])}>Clear photos</button></div>
          </Show>
          <form class="chat-composer" onSubmit={send}>
            <label class="chat-photo-add" aria-label="Add photos">+<input type="file" accept="image/*" multiple hidden onChange={addPhotos} disabled={busy() || photos().length >= MAX_CHAT_PHOTOS} /></label>
            <label class="sr-only" for="chat-message">Message</label>
            <textarea
              id="chat-message"
              rows="1"
              maxLength={1000}
              value={text()}
              onInput={(event) => setText(event.target.value)}
              placeholder={`Message @${peer}`}
              onPaste={pastePhotos}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(event); } }}
            />
            <button type="submit" disabled={busy() || (!text().trim() && !photos().length)} aria-label="Send message">↑</button>
          </form>
          <Show when={moneyMode()}>
            <MoneyModal
              mode={moneyMode()}
              peer={peer}
              onClose={() => setMoneyMode('')}
              onDone={(message) => { setMoneyMode(''); setFlash(message); thread.refresh(); }}
            />
          </Show>
        </main>
      </Match>
    </Switch>
  );
}
