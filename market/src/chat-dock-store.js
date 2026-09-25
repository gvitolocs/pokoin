import { appendChatTag, sellerUserId } from './chat-listing.js';

let snapshot = { open: false, peer: '', peerLabel: '', tags: [] };
const listeners = new Set();

function emit() {
  for (const listener of listeners) listener(snapshot);
}

export function getChatDock() {
  return snapshot;
}

export function subscribeChatDock(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openListingChat(reference) {
  const sellerUid = sellerUserId(reference?.sellerUid);
  if (!sellerUid) return false;
  const same = snapshot.open && snapshot.peer === sellerUid;
  snapshot = {
    open: true,
    peer: sellerUid,
    peerLabel: reference?.seller || 'Seller',
    tags: appendChatTag(same ? snapshot.tags : [], reference),
  };
  emit();
  return true;
}

export function addChatTag(reference) {
  if (!snapshot.open) {
    if (reference?.sellerUid) return openListingChat(reference);
    return false;
  }
  snapshot = { ...snapshot, tags: appendChatTag(snapshot.tags, reference) };
  emit();
  return true;
}

export function removeChatTag(key) {
  snapshot = { ...snapshot, tags: snapshot.tags.filter((row) => `${row.kind}:${row.listingId || row.cardId || row.cardName}` !== key) };
  emit();
}

export function closeChatDock() {
  snapshot = { open: false, peer: '', peerLabel: '', tags: [] };
  emit();
}

export function clearChatTags() {
  snapshot = { ...snapshot, tags: [] };
  emit();
}
