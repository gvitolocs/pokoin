'use strict';

const crypto = require('node:crypto');

const EVENT_TYPES = Object.freeze({
  TEXT: 'text',
  MONEY_REQUEST: 'money_request',
  PAYMENT: 'payment',
  SYSTEM: 'system',
});

const USERNAME_RE = /^[a-z0-9]{3,32}$/;
const TEXT_MAX = 1000;
const NOTE_MAX = 140;
const MAX_CHAT_PHOTOS = 4;
const MAX_LISTING_PHOTOS = 8;

function pairKeyFor(uidA, uidB) {
  const members = [String(uidA || '').trim(), String(uidB || '').trim()].sort();
  if (!members[0] || !members[1]) throw new Error('Two participants are required.');
  if (members[0] === members[1]) throw new Error('A conversation needs two different users.');
  return `direct_${crypto.createHash('sha256').update(JSON.stringify(members)).digest('hex')}`;
}

function isParticipant(members = [], uid) {
  return members.map(String).includes(String(uid || ''));
}

function otherMember(members = [], uid) {
  return members.map(String).find((member) => member !== String(uid || '')) || '';
}

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
}

function cleanNote(note) {
  return String(note || '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
}

function validateAmountPkn(value) {
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a whole PKN amount greater than zero.' };
  if (amount > 1000000000) return { error: 'That amount is too large.' };
  return { amount };
}

function bumpUnread(unreadMap = {}, members = [], senderUid) {
  const next = { ...(unreadMap || {}) };
  for (const member of members.map(String)) {
    next[member] = member === String(senderUid)
      ? Number(next[member] || 0)
      : Number(next[member] || 0) + 1;
  }
  return next;
}

function unreadFor(conversation = {}, uid) {
  return Number((conversation.unread || {})[String(uid)] || 0);
}

function cleanImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 400 || raw.includes('\\') || raw.includes('..')) return '';
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return url.href;
  } catch (_) {
    return '';
  }
  return '';
}

function cleanListing(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const cardName = String(raw.cardName || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!cardName) return null;
  const seller = String(raw.seller || '').trim().toLowerCase();
  const imageUrl = cleanImageUrl(raw.imageUrl);
  let path = String(raw.path || '');
  if (!path.startsWith('/') || path.startsWith('//')) path = '';
  const price = Number(raw.pricePkn);
  const qty = Math.trunc(Number(raw.qty));
  return {
    kind: raw.kind === 'card' ? 'card' : 'listing',
    listingId: String(raw.listingId || '').slice(0, 80),
    cardId: String(raw.cardId || '').slice(0, 40),
    seller: USERNAME_RE.test(seller) ? seller : '',
    sellerUid: /^[A-Za-z0-9]{8,128}$/.test(String(raw.sellerUid || '')) ? String(raw.sellerUid) : '',
    cardName,
    setName: String(raw.setName || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    imageUrl,
    path: path.slice(0, 240),
    pricePkn: Number.isFinite(price) && price >= 0 ? Math.min(Math.round(price), 1000000000) : 0,
    qty: Number.isFinite(qty) && qty >= 1 ? Math.min(qty, 99) : 1,
  };
}

function cleanOwnedPhotos(value, uid, kind, limit) {
  const owner = String(uid || '').trim();
  if (!/^[A-Za-z0-9]{8,128}$/.test(owner)) return [];
  const prefix = `/card-images/user-photos/${kind}/${owner}/`;
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const url = String(item || '').trim();
    if (!url.startsWith(prefix) || url.includes('..') || url.includes('\\')) continue;
    if (!url.endsWith('.jpg')) continue;
    out.push(url.slice(0, 240));
    if (out.length >= limit) break;
  }
  return out;
}

function cleanChatImages(value, uid) {
  return cleanOwnedPhotos(value, uid, 'chat', MAX_CHAT_PHOTOS);
}

function cleanListingPhotos(value, uid) {
  return cleanOwnedPhotos(value, uid, 'listing', MAX_LISTING_PHOTOS);
}

function cleanListings(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const row of value) {
    const clean = cleanListing(row);
    if (!clean) continue;
    out.push(clean);
    if (out.length >= 4) break;
  }
  return out;
}

function previewForEvent(event = {}, viewerUid = '') {
  const amount = `${Number(event.amountPkn || 0)} PKN`;
  const mine = String(event.senderUid || '') === String(viewerUid || '');
  if (event.type === EVENT_TYPES.TEXT) {
    const text = cleanText(event.text);
    if (text) return text.slice(0, 80);
    if (Array.isArray(event.images) && event.images.length) return 'Photo';
    const name = event.listings?.[0]?.cardName;
    return name ? String(name).slice(0, 80) : '';
  }
  if (event.type === EVENT_TYPES.MONEY_REQUEST) {
    if (event.status === 'paid') return `Paid ✓ ${amount}`;
    return mine ? `You requested ${amount}` : `Requested ${amount}`;
  }
  if (event.type === EVENT_TYPES.PAYMENT) return mine ? `You sent ${amount}` : `Sent you ${amount}`;
  return cleanText(event.text).slice(0, 80);
}

function operationId(uid, clientToken) {
  const token = String(clientToken || '').trim().slice(0, 80);
  if (!token) return '';
  return `chat_${crypto.createHash('sha256').update(`${uid}\0${token}`).digest('hex')}`;
}

module.exports = {
  EVENT_TYPES,
  USERNAME_RE,
  TEXT_MAX,
  MAX_CHAT_PHOTOS,
  MAX_LISTING_PHOTOS,
  pairKeyFor,
  isParticipant,
  otherMember,
  cleanText,
  cleanListings,
  cleanChatImages,
  cleanListingPhotos,
  cleanNote,
  validateAmountPkn,
  bumpUnread,
  unreadFor,
  previewForEvent,
  operationId,
};
