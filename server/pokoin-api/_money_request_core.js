'use strict';

const STATUS = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  DECLINED: 'declined',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[a-z0-9]{3,32}$/;

function validateAmountPkn(value) {
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a whole PKN amount greater than zero.' };
  if (amount > 1000000000) return { error: 'That amount is too large.' };
  return { amount };
}

function validateCreate(input = {}) {
  const toUsername = String(input.recipientUsername || '').trim().toLowerCase();
  if (!USERNAME_RE.test(toUsername)) return { error: 'Enter a valid recipient username.' };
  const amount = validateAmountPkn(input.amountPkn);
  if (amount.error) return amount;
  return {
    value: {
      toUsername,
      amountPkn: amount.amount,
      note: String(input.note || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      clientToken: String(input.clientToken || '').trim().slice(0, 80),
    },
  };
}

function timestampMs(value, fallback = 0) {
  if (!value) return fallback;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value._seconds === 'number') return value._seconds * 1000;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function effectiveStatus(request = {}, now = Date.now()) {
  const status = String(request.status || STATUS.PENDING);
  if (status === STATUS.PENDING && now - timestampMs(request.createdAt, now) > TTL_MS) return STATUS.EXPIRED;
  return status;
}

function canPay(request = {}, uid, now = Date.now()) {
  const status = effectiveStatus(request, now);
  if (status !== STATUS.PENDING) return { ok: false, error: `This request is ${status}.` };
  if (String(request.toUid || '') !== String(uid || '')) return { ok: false, error: 'Only the request recipient can pay it.' };
  if (String(request.fromUid || '') === String(uid || '')) return { ok: false, error: 'You cannot pay your own request.' };
  return { ok: true };
}

function canRespond(request = {}, uid, action, now = Date.now()) {
  if (effectiveStatus(request, now) !== STATUS.PENDING) return { ok: false, error: 'Only pending requests can be updated.' };
  if (action === 'decline' && String(request.toUid) === String(uid)) return { ok: true };
  if (action === 'cancel' && String(request.fromUid) === String(uid)) return { ok: true };
  return { ok: false, error: action === 'decline'
    ? 'Only the request recipient can decline it.'
    : 'Only the requester can cancel it.' };
}

module.exports = { STATUS, TTL_MS, USERNAME_RE, validateAmountPkn, validateCreate, effectiveStatus, canPay, canRespond };
