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

function previewForEvent(event = {}, viewerUid = '') {
  const amount = `${Number(event.amountPkn || 0)} PKN`;
  const mine = String(event.senderUid || '') === String(viewerUid || '');
  if (event.type === EVENT_TYPES.TEXT) return cleanText(event.text).slice(0, 80);
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
  pairKeyFor,
  isParticipant,
  otherMember,
  cleanText,
  cleanNote,
  validateAmountPkn,
  bumpUnread,
  unreadFor,
  previewForEvent,
  operationId,
};
