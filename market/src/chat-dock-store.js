import { appendChatTag, chatQty, dragCardsOf, explicitStock, sellerUserId, tagKey } from './chat-listing.js';

const DRAFT_KEY = 'pokoin.chatDrafts';
const DROP_HINT_KEY = 'pokoin.chatDropHint';

let snapshot = { open: false, view: 'list', peer: '', peerLabel: '', tags: [], text: '' };
const listeners = new Set();

function emit() {
  for (const listener of listeners) listener(snapshot);
}

function readDrafts() {
  try {
    const data = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch (_) {
    return {};
  }
}

function writeDrafts(drafts) {
  const compact = {};
  for (const [peer, draft] of Object.entries(drafts || {})) {
    const tags = Array.isArray(draft?.tags) ? draft.tags.slice(-4) : [];
    const text = String(draft?.text || '').slice(0, 1000);
    if (!tags.length && !text.trim()) continue;
    compact[peer] = { tags, text, label: String(draft?.label || '') };
  }
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(compact));
  } catch (_) {
    /* private mode */
  }
  return compact;
}

function remember(peer, { tags, text, label }) {
  if (!peer) return;
  const drafts = readDrafts();
  drafts[peer] = { tags: tags || [], text: text || '', label: label || drafts[peer]?.label || '' };
  writeDrafts(drafts);
}

function persistCurrent(text) {
  if (!snapshot.peer) return;
  remember(snapshot.peer, {
    tags: snapshot.tags,
    text: text ?? snapshot.text,
    label: snapshot.peerLabel,
  });
}

export function getChatDock() {
  return snapshot;
}

export function getChatDrafts() {
  return readDrafts();
}

/** Browser-local: the tip is chrome, not account data, so it stays hidden on this device. */
export function chatDropHintVisible() {
  try {
    return localStorage.getItem(DROP_HINT_KEY) !== 'dismissed';
  } catch (_) {
    return true;
  }
}

export function dismissChatDropHint() {
  try {
    localStorage.setItem(DROP_HINT_KEY, 'dismissed');
  } catch (_) {
    /* private mode hides it for this view only */
  }
}

export function subscribeChatDock(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openChatList(text) {
  if (snapshot.open && snapshot.view === 'list') return;
  if (text !== undefined) snapshot = { ...snapshot, text };
  persistCurrent();
  snapshot = { ...snapshot, open: true, view: 'list' };
  emit();
}

/** Dragging a card opens the list only when no conversation is already open. */
export function noteListingDrag(text) {
  if (snapshot.open && snapshot.view === 'thread') return 'thread';
  openChatList(text);
  return 'list';
}

let cardDrag = null;

/** Open the messages panel for this drag. It closes again unless the card lands on it. */
export function beginCardDrag() {
  if (cardDrag) return;
  cardDrag = { wasOpen: snapshot.open, landed: false };
  if (!snapshot.open) openChatList();
}

export function markChatDrop() {
  if (cardDrag) cardDrag.landed = true;
}

export function endCardDrag() {
  const session = cardDrag;
  cardDrag = null;
  if (!session || session.wasOpen || session.landed) return;
  closeChatDock();
}

let stagedCards = [];

export function stageChatCards(references) {
  const rows = (references || []).filter((row) => row?.cardName);
  if (!rows.length) return false;
  if (snapshot.open && snapshot.view === 'thread' && snapshot.peer) {
    let tags = snapshot.tags;
    for (const row of rows) tags = appendChatTag(tags, row);
    snapshot = { ...snapshot, tags };
    remember(snapshot.peer, snapshot);
    emit();
    return true;
  }
  stagedCards = rows;
  openChatList();
  return true;
}

export function openThread(peer, label = '', text) {
  const uid = sellerUserId(peer) || String(peer || '').trim();
  if (!uid) return false;
  persistCurrent(text);
  const draft = readDrafts()[uid] || {};
  let tags = Array.isArray(draft.tags) ? draft.tags : [];
  if (stagedCards.length) {
    for (const row of stagedCards) tags = appendChatTag(tags, row);
    stagedCards = [];
  }
  snapshot = {
    open: true,
    view: 'thread',
    peer: uid,
    peerLabel: label || draft.label || 'Seller',
    tags,
    text: draft.text || '',
  };
  emit();
  return true;
}

export function dropOnConversation(peer, label, reference) {
  const uid = sellerUserId(peer) || String(peer || '').trim();
  const rows = dragCardsOf(reference);
  if (!uid || !rows.length) return false;
  markChatDrop();
  persistCurrent();
  const prior = readDrafts()[uid] || {};
  let tags = prior.tags || [];
  for (const row of rows) tags = appendChatTag(tags, row);
  remember(uid, { tags, text: prior.text || '', label: label || prior.label || '' });
  snapshot = {
    open: true,
    view: 'thread',
    peer: uid,
    peerLabel: label || prior.label || 'Seller',
    tags,
    text: prior.text || '',
  };
  emit();
  return true;
}

export function openListingChat(reference) {
  const sellerUid = sellerUserId(reference?.sellerUid);
  if (!sellerUid) {
    openChatList();
    return false;
  }
  return dropOnConversation(sellerUid, reference?.seller || '', reference);
}

export function addChatTag(reference, text) {
  if (!snapshot.open || snapshot.view !== 'thread' || !snapshot.peer) {
    openChatList(text);
    return false;
  }
  if (text !== undefined) snapshot = { ...snapshot, text };
  markChatDrop();
  let tags = snapshot.tags;
  for (const row of dragCardsOf(reference)) tags = appendChatTag(tags, row);
  snapshot = { ...snapshot, tags };
  remember(snapshot.peer, snapshot);
  emit();
  return true;
}

export function setChatTagQty(key, qty) {
  snapshot = {
    ...snapshot,
    tags: snapshot.tags.map((row) => (
      tagKey(row) === key ? { ...row, qty: chatQty(qty) } : row
    )),
  };
  remember(snapshot.peer, snapshot);
  emit();
}

export function setChatTagStock(key, stock) {
  const n = explicitStock(stock);
  if (n == null) return;
  let changed = false;
  const tags = snapshot.tags.map((row) => {
    if (tagKey(row) !== key || explicitStock(row.stock) === n) return row;
    changed = true;
    return { ...row, stock: n };
  });
  if (!changed) return;
  snapshot = { ...snapshot, tags };
  remember(snapshot.peer, snapshot);
  emit();
}

export function removeChatTag(key) {
  snapshot = {
    ...snapshot,
    tags: snapshot.tags.filter((row) => `${row.kind}:${row.listingId || row.cardId || row.cardName}` !== key),
  };
  remember(snapshot.peer, snapshot);
  emit();
}

export function closeChatDock(text) {
  stagedCards = [];
  if (text !== undefined) snapshot = { ...snapshot, text };
  persistCurrent();
  snapshot = { ...snapshot, open: false, view: 'list' };
  emit();
}

export function clearChatTags() {
  if (snapshot.peer) {
    const drafts = readDrafts();
    delete drafts[snapshot.peer];
    writeDrafts(drafts);
  }
  snapshot = { ...snapshot, tags: [], text: '' };
  emit();
}
