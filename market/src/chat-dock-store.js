import { appendChatTag } from './chat-listing.js';

const USERNAME_RE = /^[a-z0-9]{3,32}$/;

let snapshot = { open: false, peer: '', tags: [] };
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
  const seller = String(reference?.seller || '').trim().toLowerCase();
  if (!USERNAME_RE.test(seller)) return false;
  const same = snapshot.open && snapshot.peer === seller;
  snapshot = {
    open: true,
    peer: seller,
    tags: appendChatTag(same ? snapshot.tags : [], reference),
  };
  emit();
  return true;
}

export function addChatTag(reference) {
  if (!snapshot.open) {
    if (reference?.seller) return openListingChat(reference);
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
  snapshot = { open: false, peer: '', tags: [] };
  emit();
}

export function clearChatTags() {
  snapshot = { ...snapshot, tags: [] };
  emit();
}
