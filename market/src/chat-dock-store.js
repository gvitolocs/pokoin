import { appendChatTag, sellerUserId } from './chat-listing.js';

const DRAFT_KEY = 'pokoin.chatDrafts';

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

export function openThread(peer, label = '', text) {
  const uid = sellerUserId(peer) || String(peer || '').trim();
  if (!uid) return false;
  persistCurrent(text);
  const draft = readDrafts()[uid] || {};
  snapshot = {
    open: true,
    view: 'thread',
    peer: uid,
    peerLabel: label || draft.label || 'Seller',
    tags: Array.isArray(draft.tags) ? draft.tags : [],
    text: draft.text || '',
  };
  emit();
  return true;
}

export function dropOnConversation(peer, label, reference) {
  const uid = sellerUserId(peer) || String(peer || '').trim();
  if (!uid || !reference?.cardName) return false;
  persistCurrent();
  const prior = readDrafts()[uid] || {};
  const tags = appendChatTag(prior.tags || [], reference);
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

export function addChatTag(reference) {
  if (!snapshot.open || snapshot.view !== 'thread' || !snapshot.peer) {
    openChatList();
    return false;
  }
  snapshot = { ...snapshot, tags: appendChatTag(snapshot.tags, reference) };
  remember(snapshot.peer, snapshot);
  emit();
  return true;
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
