import { createEffect, createSignal, For, onSettled, Show, untrack } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { listConversations, sendChatMessage, uploadChatPhoto } from '@market/chat-client.js';
import {
  addChatTag,
  beginCardDrag,
  chatDropHintVisible,
  clearChatTags,
  closeChatDock,
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
} from '@market/chat-dock-store.js';
import { chatPersonName, chatPersonPhoto, chatTime } from '@market/chat-format.js';
import { chatPreviewsLookSame, mergeChatPreviewRows, paintableChatPreviews, readChatPreviews, writeChatPreviews } from '@market/chat-history.js';
import { readListingDrag, tagKey } from '@market/chat-listing.js';
import { game } from '@market/game.js';
import { MESSAGES_UNREAD_EVENT, MESSAGES_UNREAD_REFRESH_MS, unreadMessagesCount } from '@market/messages-unread.js';
import { isPokoPeer, POKO_DISPLAY, POKO_PEER, resolvePokoCards } from '@market/poko-chat.js';
import { warmSellerFromChat } from '@market/seller-seed.js';
import { acceptTrayDrop, messagesTrayId } from '@market/tray-drag.js';
import { MAX_CHAT_PHOTOS, imageFilesFromClipboard, photoFileToJpeg } from '@market/user-photos.js';
import mascotUrl from '@market/assets/pokoin-mascot@8x.png';
import '@market/chat-dock.css';
import { createChatThread } from '../lib/chat-thread.js';
import { carriesListing } from '../lib/drag.js';
import { fromExternalStore } from '../lib/external.js';
import { createPokoThread } from '../lib/poko-thread.js';
import { accountProfile } from '../stores/account.js';
import { authUser, getBearer, signedIn } from '../stores/auth.js';
import { searchLang } from '../stores/locale.js';
import AppLink from './AppLink.jsx';
import Avatar from './Avatar.jsx';
import ChatListingTag from './ChatListingTag.jsx';
import ChatPhotos from './ChatPhotos.jsx';
import ChatText from './ChatText.jsx';

/** The dock's open / view / peer / draft tags (market/src/chat-dock-store.js). */
const dockState = fromExternalStore(subscribeChatDock, getChatDock);

function draftLine(row, drafts) {
  const tags = drafts?.[row.peerUid]?.tags || [];
  const name = tags.length ? tags[tags.length - 1].cardName : '';
  if (name) return { text: `Draft: ${name}`, draft: true };
  return { text: row.preview || 'No messages yet', draft: false };
}

function signInHref() {
  return `/auth?from=${encodeURIComponent(window.location.pathname + window.location.search)}`;
}

function ConversationList(props) {
  const [rows, setRows] = createSignal(paintableChatPreviews());
  const [seen, setSeen] = createSignal(paintableChatPreviews().length > 0);
  const [drafts, setDrafts] = createSignal(getChatDrafts());
  const [overUid, setOverUid] = createSignal('');
  const [error, setError] = createSignal('');

  createEffect(signedIn, (on) => {
    if (!on) return undefined;
    let live = true;
    (async () => {
      try {
        const token = await getBearer();
        const result = await listConversations(token);
        if (!live) return;
        const next = mergeChatPreviewRows(readChatPreviews(), result.conversations || []);
        writeChatPreviews(next);
        setRows((current) => (chatPreviewsLookSame(current, next) ? current : next));
        setDrafts(getChatDrafts());
        setError('');
      } catch (err) {
        if (live) setError(err.message || 'Could not load conversations.');
      } finally {
        if (live) setSeen(true);
      }
    })();
    return () => {
      live = false;
    };
  });

  // Dropping a card on a conversation drafts it there.
  function dragOver(event, uid) {
    if (!carriesListing(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setOverUid(uid);
  }

  function dropOn(event, uid, label) {
    event.preventDefault();
    event.stopPropagation();
    setOverUid('');
    const reference = readListingDrag(event);
    if (!reference) return;
    acceptTrayDrop(messagesTrayId(uid));
    dropOnConversation(uid, label, reference);
  }

  return (
    <Show
      when={signedIn()}
      fallback={(
        <p class="chat-dock-hint">
          <AppLink to={signInHref()}>Sign in</AppLink>
          {' '}to see your conversations.
        </p>
      )}
    >
      <div class="chat-dock-list" role="list">
        <Show when={props.onPoko}>
          <div
            role="listitem"
            class={['chat-dock-row poko-row is-poko', { 'is-over': overUid() === 'poko' }]}
            onDragOver={(event) => dragOver(event, 'poko')}
            onDragLeave={() => setOverUid('')}
            onDrop={(event) => dropOn(event, POKO_PEER, POKO_DISPLAY)}
          >
            <button type="button" onClick={() => props.onPoko()}>
              <span class="chat-dock-avatar is-poko poko-avatar" aria-hidden="true">
                <img src={mascotUrl} alt="" />
              </span>
              <span class="chat-dock-row-copy">
                <strong>{POKO_DISPLAY}</strong>
                <em>Ask about cards — drop one to attach</em>
              </span>
            </button>
          </div>
        </Show>
        <Show when={error()}><p class="chat-dock-error" role="alert">{error()}</p></Show>
        <Show
          when={rows().length}
          fallback={<Show when={seen()}><p class="chat-dock-hint">No people yet — talk to Poko above, or message a seller.</p></Show>}
        >
          <For each={rows()} keyed={(row) => row.pairKey || row.peerUid}>
            {(row) => (
              <div
                role="listitem"
                class={['chat-dock-row', { 'is-over': overUid() === row().peerUid }]}
                onDragOver={(event) => dragOver(event, row().peerUid)}
                onDragLeave={() => setOverUid('')}
                onDrop={(event) => dropOn(event, row().peerUid, row().peerUsername)}
              >
                <button type="button" onClick={() => props.onOpen(row())}>
                  <Avatar src={chatPersonPhoto(row())} seed={row().peerUid} name={chatPersonName(row())} size={36} />
                  <span class="chat-dock-row-copy">
                    <strong>{chatPersonName(row())}</strong>
                    <em class={draftLine(row(), drafts()).draft ? 'is-draft' : undefined}>{draftLine(row(), drafts()).text}</em>
                  </span>
                  <time>{chatTime(row().updatedAt)}</time>
                </button>
              </div>
            )}
          </For>
        </Show>
      </div>
    </Show>
  );
}

/**
 * Floating messages dock (market/src/components/ChatDock.jsx): the chat
 * button, the conversation list, person threads and the Poko assistant, with
 * card drops onto conversations. A lazy chunk the shell loads once the page
 * is idle — never on the first paint.
 */
export default function ChatDock() {
  const location = useLocation();
  const dock = dockState;
  const [text, setText] = createSignal('');
  const [photos, setPhotos] = createSignal([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [over, setOver] = createSignal(false);
  const [showDropHint, setShowDropHint] = createSignal(chatDropHintVisible());
  const [unread, setUnread] = createSignal(0);
  let textNow = '';
  const poko = () => isPokoPeer(dock().peer);
  const threadOpen = () => dock().open && dock().view === 'thread';
  const thread = createChatThread({
    peerUid: () => dock().peer,
    signedIn,
    getBearer,
    enabled: () => threadOpen() && !poko(),
  });
  const pokoThread = createPokoThread({
    uid: () => authUser()?.uid || '',
    signedIn,
    getBearer,
    enabled: () => threadOpen() && poko(),
    pathname: () => location.pathname,
  });

  function updateText(value) {
    textNow = value;
    setText(value);
  }

  createEffect(
    () => {
      const state = dock();
      if (!state.open || state.view !== 'thread' || isPokoPeer(state.peer)) return null;
      const username = state.peerLabel && state.peerLabel !== 'Seller' ? state.peerLabel : '';
      if (!username) return null;
      return {
        username,
        uid: state.peer,
        displayName: thread.person()?.displayName || state.peerName,
        photoUrl: thread.person()?.photoUrl || state.peerPhotoUrl,
      };
    },
    (seed) => {
      if (seed) warmSellerFromChat({ ...seed, game: game().apiGame });
    },
  );

  // The unread badge: polled while the dock is closed (and on every route), pushed by the Messages page.
  createEffect(
    () => [signedIn(), dock().open, location.pathname],
    ([on, open]) => {
      if (!on || open) {
        if (!on) setUnread(0);
        return undefined;
      }
      let live = true;
      const refresh = async () => {
        try {
          const token = await getBearer();
          if (!token || !live) return;
          const result = await listConversations(token);
          if (!live) return;
          setUnread(unreadMessagesCount(result?.conversations || []));
        } catch (_) {
          /* badge is best-effort */
        }
      };
      refresh();
      const timer = setInterval(refresh, MESSAGES_UNREAD_REFRESH_MS);
      return () => {
        live = false;
        clearInterval(timer);
      };
    },
  );

  createEffect(
    () => [dock().view, dock().peer],
    ([view]) => {
      if (view === 'thread') updateText(untrack(() => dock().text) || '');
    },
  );

  onSettled(() => {
    const onUnread = (event) => {
      if (typeof event?.detail?.count === 'number') setUnread(event.detail.count);
    };
    const onDragStart = (event) => {
      if (!carriesListing(event) && !document.documentElement.classList.contains('is-card-dragging')) return;
      beginCardDrag();
    };
    const onDragOver = (event) => {
      if (!carriesListing(event)) return;
      if (noteListingDrag(textNow) === 'thread') return;
      event.preventDefault();
    };
    const onDragEnd = () => endCardDrag();
    window.addEventListener(MESSAGES_UNREAD_EVENT, onUnread);
    window.addEventListener('dragstart', onDragStart);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragend', onDragEnd);
    return () => {
      window.removeEventListener(MESSAGES_UNREAD_EVENT, onUnread);
      window.removeEventListener('dragstart', onDragStart);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragend', onDragEnd);
    };
  });

  const handle = () => (dock().peerLabel && dock().peerLabel !== 'Seller' ? dock().peerLabel : '');
  const personName = () => thread.person()?.displayName || dock().peerName || '';
  const personPhoto = () => thread.person()?.photoUrl || dock().peerPhotoUrl || '';
  const label = () => (poko() ? POKO_DISPLAY : (personName() || handle() || 'Seller'));
  const events = () => (poko() ? pokoThread.events() : thread.events());
  const sending = () => busy() || (poko() && pokoThread.busy());
  const threadError = () => error() || (poko() ? pokoThread.error() : thread.error());
  const peerRef = () => ({ uid: dock().peer, username: poko() ? POKO_PEER : handle() });
  const me = () => ({ uid: authUser()?.uid, username: accountProfile()?.username });

  async function addPhotoFiles(files) {
    const room = MAX_CHAT_PHOTOS - photos().length;
    const list = [...files].filter(Boolean).slice(0, room);
    if (!list.length || room <= 0) return;
    setBusy(true);
    setError('');
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
      setError(err.message || 'Photo was not added.');
    } finally {
      setBusy(false);
    }
  }

  async function send(event) {
    event?.preventDefault();
    const state = dock();
    const message = text().trim();
    const deskCards = resolvePokoCards({ tags: state.tags, pathname: location.pathname });
    if (sending() || (!message && !state.tags.length && !photos().length && !deskCards.length)) return;
    setError('');
    try {
      if (poko()) {
        const tags = state.tags.slice();
        const attachedImages = photos().slice();
        updateText('');
        setPhotos([]);
        clearChatTags();
        await pokoThread.send({ message, tags, photos: attachedImages });
      } else {
        const token = await getBearer();
        if (!token) throw new Error('Sign in to send a message.');
        setBusy(true);
        await sendChatMessage('', message, token, state.tags, state.peer, photos());
        updateText('');
        setPhotos([]);
        clearChatTags();
        await thread.refresh();
      }
    } catch (err) {
      setError(err.message || 'Message was not sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show
      when={dock().open}
      fallback={(
        <button
          type="button"
          class="chat-fab"
          aria-label={unread() > 0 ? `Open messages, ${unread()} unread` : 'Open messages'}
          onClick={() => openChatList()}
        >
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 3C6.48 3 2 6.92 2 11.75c0 2.68 1.35 5.08 3.48 6.74V21l3.2-1.76c1.05.3 2.17.46 3.32.46 5.52 0 10-3.92 10-8.75S17.52 3 12 3zm-1.1 10.5H7.8v-1.5h3.1v1.5zm5.3 0h-3.1v-1.5h3.1v1.5zm0-3.25H7.8V8.75h8.4v1.5z"
            />
          </svg>
          <Show when={unread() > 0}>
            <span class="chat-fab-badge" aria-hidden="true">{unread() > 9 ? '9+' : unread()}</span>
          </Show>
        </button>
      )}
    >
      <section
        class={['chat-dock', { 'is-over': over() }]}
        aria-label={dock().view === 'list' ? 'Messages' : `Chat with ${label()}`}
        onDragOver={(event) => {
          if (!carriesListing(event)) return;
          event.preventDefault();
          event.stopPropagation();
          if (dock().view === 'thread') setOver(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          setOver(false);
        }}
        onDrop={(event) => {
          if (!carriesListing(event)) return;
          event.preventDefault();
          event.stopPropagation();
          setOver(false);
          markChatDrop();
          if (dock().view !== 'thread') return;
          const reference = readListingDrag(event);
          if (reference) {
            acceptTrayDrop(messagesTrayId(dock().peer || POKO_PEER));
            addChatTag(reference, textNow);
          }
        }}
      >
        <header class="chat-dock-head">
          <Show when={dock().view === 'thread'} fallback={<span />}>
            <button type="button" aria-label="Conversations" onClick={() => openChatList(text())}>‹</button>
          </Show>
          <strong class={['chat-dock-person', { 'is-poko': poko() }]}>
            <Show
              when={poko()}
              fallback={(
                <Show when={dock().view === 'thread' && handle()} fallback={dock().view === 'thread' ? label() : 'Messages'}>
                  <AppLink to={`/marketplace/${searchLang()}/users/${encodeURIComponent(handle())}`}>
                    <Avatar src={personPhoto()} seed={dock().peer} name={label()} size={30} />
                    {label()}
                  </AppLink>
                </Show>
              )}
            >
              <span class="chat-dock-avatar is-poko poko-avatar" aria-hidden="true">
                <img src={mascotUrl} alt="" />
              </span>
              {POKO_DISPLAY}
            </Show>
          </strong>
          <button type="button" aria-label="Close chat" onClick={() => closeChatDock(text())}>×</button>
        </header>
        <Show
          when={dock().view !== 'list'}
          fallback={(
            <ConversationList
              onPoko={() => openThread(POKO_PEER, POKO_DISPLAY, text())}
              onOpen={(row) => openThread(row.peerUid, row.peerUsername, text(), {
                displayName: row.peerDisplayName,
                photoUrl: row.peerPhotoUrl,
              })}
            />
          )}
        >
          <div
            class="chat-dock-log"
            ref={(el) => {
              // One log element; whichever thread is active pins and pages it.
              thread.setLog(el);
              pokoThread.setLog(el);
            }}
            onScroll={(event) => (poko() ? pokoThread.onScroll(event) : thread.onScroll(event))}
          >
            <For each={events()} keyed={(event) => event.id}>
              {(event) => (
                <div
                  class={[
                    'chat-bubble',
                    { mine: event().mine, 'is-unavailable': event().source === 'unavailable' || event().source === 'send_failed' },
                  ]}
                >
                  <Show when={event().text}><ChatText text={event().text} /></Show>
                  <Show when={event().source === 'unavailable'}><p class="chat-dock-hint">Could not reply — try again.</p></Show>
                  <Show when={event().source === 'send_failed'}><p class="chat-dock-hint">Not delivered — try again.</p></Show>
                  <ChatPhotos urls={event().images || []} />
                  <Show when={(event().listings || event().cards || []).length}>
                    <span class="chat-tags">
                      <For each={event().listings || event().cards || []}>
                        {(row) => <ChatListingTag row={row} peer={peerRef()} me={me()} />}
                      </For>
                    </span>
                  </Show>
                  <Show when={!event().text && !(event().listings || event().cards || []).length && !(event().images || []).length}>
                    <p>…</p>
                  </Show>
                </div>
              )}
            </For>
            <Show when={poko() && pokoThread.busy()}><p class="chat-dock-hint">…</p></Show>
          </div>
          <Show when={threadError()}><p class="chat-dock-error" role="alert">{threadError()}</p></Show>
          <Show
            when={signedIn() && dock().peer}
            fallback={(
              <p class="chat-dock-hint">
                <AppLink to={signInHref()}>Sign in</AppLink>
                {' '}to message {poko() ? 'Poko' : 'this seller'}.
              </p>
            )}
          >
            <form class="chat-dock-compose" onSubmit={send}>
              <Show
                when={dock().tags.length}
                fallback={(
                  <Show when={showDropHint()}>
                    <p class="chat-dock-hint chat-dock-hint-row">
                      <span>Drop a card here to attach it.</span>
                      <button
                        type="button"
                        class="chat-hint-x"
                        aria-label="Hide hint"
                        onClick={() => {
                          dismissChatDropHint();
                          setShowDropHint(false);
                        }}
                      >×</button>
                    </p>
                  </Show>
                )}
              >
                <div class="chat-dock-tags">
                  <For each={dock().tags} keyed={(row) => tagKey(row)}>
                    {(row) => (
                      <ChatListingTag
                        row={row()}
                        trayId={messagesTrayId(dock().peer || POKO_PEER)}
                        onRemove={removeChatTag}
                        onQty={setChatTagQty}
                        peer={peerRef()}
                        me={me()}
                      />
                    )}
                  </For>
                </div>
              </Show>
              <Show when={photos().length}>
                <div class="chat-photo-draft">
                  <ChatPhotos urls={photos()} />
                  <button type="button" onClick={() => setPhotos([])}>Clear photos</button>
                </div>
              </Show>
              <div class="chat-dock-field">
                <label class="chat-photo-add" aria-label="Add photos">
                  +
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={(event) => {
                      const files = [...(event.target.files || [])];
                      event.target.value = '';
                      addPhotoFiles(files);
                    }}
                    disabled={sending() || photos().length >= MAX_CHAT_PHOTOS}
                  />
                </label>
                <label class="sr-only" for="chat-dock-input">Message</label>
                <textarea
                  id="chat-dock-input"
                  rows="2"
                  maxlength={1000}
                  value={text()}
                  placeholder={poko() ? 'Message Poko' : (handle() ? `Message @${handle()}` : 'Message')}
                  onInput={(event) => updateText(event.target.value)}
                  onPaste={(event) => {
                    const files = imageFilesFromClipboard(event.clipboardData);
                    if (!files.length) return;
                    event.preventDefault();
                    addPhotoFiles(files);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      send(event);
                    }
                  }}
                />
                <button type="submit" disabled={sending() || (!text().trim() && !dock().tags.length && !photos().length)} aria-label="Send">↑</button>
              </div>
            </form>
          </Show>
        </Show>
      </section>
    </Show>
  );
}
