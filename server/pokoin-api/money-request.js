'use strict';

const crypto = require('node:crypto');
const { getFirebaseAdmin, verifyBearerToken } = require('../server/_firebase');
const { EVENT_TYPES, bumpUnread, pairKeyFor } = require('./_chat_core');
const { STATUS, canPay, canRespond, effectiveStatus, validateCreate } = require('./_money_request_core');

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function requestDocId(uid, clientToken) {
  const token = String(clientToken || '').trim();
  if (!token) return '';
  return `req_${crypto.createHash('sha256').update(`${uid}\0${token}`).digest('hex')}`;
}

function serializeRequest(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    requestId: doc.id,
    fromUid: data.fromUid,
    fromUsername: data.fromUsername || '',
    toUid: data.toUid,
    toUsername: data.toUsername || '',
    amountPkn: Number(data.amountPkn || 0),
    note: data.note || '',
    status: effectiveStatus(data),
    createdAt: data.createdAt || null,
    paidAt: data.paidAt || null,
    paymentLedgerId: data.paymentLedgerId || '',
  };
}

async function usernameFor(firestore, uid) {
  const doc = await firestore.collection('users').doc(uid).get();
  return String(doc.data()?.username || '').trim().toLowerCase();
}

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  try {
    const decoded = await verifyBearerToken(req);
    const admin = getFirebaseAdmin();
    const firestore = admin.firestore();
    const now = () => admin.firestore.FieldValue.serverTimestamp();
    const url = new URL(req.url, 'https://local');
    const action = String(url.searchParams.get('action') || (req.method === 'POST' ? 'create' : 'list'));

    if (req.method === 'GET' && action === 'list') {
      const [incoming, outgoing] = await Promise.all([
        firestore.collection('money_requests').where('toUid', '==', decoded.uid).limit(50).get(),
        firestore.collection('money_requests').where('fromUid', '==', decoded.uid).limit(50).get(),
      ]);
      const sort = (snap) => snap.docs.map(serializeRequest).sort((a, b) => {
        const av = a.createdAt?.toMillis?.() || a.createdAt?.seconds * 1000 || 0;
        const bv = b.createdAt?.toMillis?.() || b.createdAt?.seconds * 1000 || 0;
        return bv - av;
      });
      return res.status(200).json({ incoming: sort(incoming), outgoing: sort(outgoing) });
    }

    if (req.method !== 'POST') throw httpError(405, 'Unsupported action.');

    if (action === 'create') {
      const checked = validateCreate(req.body || {});
      if (checked.error) throw httpError(400, checked.error);
      const { toUsername, amountPkn, note, clientToken } = checked.value;
      if (!clientToken) throw httpError(400, 'Missing request idempotency token.');
      const [usernameDoc, fromUsername] = await Promise.all([
        firestore.collection('usernames').doc(toUsername).get(),
        usernameFor(firestore, decoded.uid),
      ]);
      const toUid = String(usernameDoc.data()?.uid || '');
      if (!usernameDoc.exists || !toUid) throw httpError(404, 'No Pokoin account was found for that username.');
      if (toUid === decoded.uid) throw httpError(400, 'You cannot request PKN from your own account.');
      const requestId = requestDocId(decoded.uid, clientToken);
      const requestRef = firestore.collection('money_requests').doc(requestId);
      const pairKey = pairKeyFor(decoded.uid, toUid);
      const convoRef = firestore.collection('conversations').doc(pairKey);
      let duplicate = false;
      await firestore.runTransaction(async (transaction) => {
        const [existing, convo] = await Promise.all([transaction.get(requestRef), transaction.get(convoRef)]);
        if (existing.exists) {
          const prior = existing.data() || {};
          if (prior.toUid !== toUid || Number(prior.amountPkn) !== amountPkn) throw httpError(409, 'That request token was already used.');
          duplicate = true;
          return;
        }
        const data = convo.exists ? convo.data() : {};
        const members = data.members || [decoded.uid, toUid].sort();
        const stamp = now();
        transaction.set(requestRef, { fromUid: decoded.uid, fromUsername, toUid, toUsername, amountPkn, note, status: STATUS.PENDING, clientToken, createdAt: stamp });
        transaction.set(convoRef, {
          pairKey, members,
          memberUsernames: { ...(data.memberUsernames || {}), [decoded.uid]: fromUsername, [toUid]: toUsername },
          unread: bumpUnread(data.unread, members, decoded.uid),
          lastEvent: { type: EVENT_TYPES.MONEY_REQUEST, amountPkn, requestId, senderUid: decoded.uid, at: stamp },
          ...(convo.exists ? {} : { createdAt: stamp }),
        }, { merge: true });
        transaction.set(convoRef.collection('events').doc(), { type: EVENT_TYPES.MONEY_REQUEST, senderUid: decoded.uid, senderUsername: fromUsername, amountPkn, note, requestId, createdAt: stamp });
        transaction.set(firestore.collection('notifications').doc(), { uid: toUid, type: 'money_request_created', requestId, actorUsername: fromUsername, amountPkn, read: false, createdAt: stamp });
      });
      return res.status(200).json({ ok: true, requestId, duplicate });
    }

    if (action === 'pay') {
      const requestId = String(req.body?.requestId || '').trim();
      if (!requestId) throw httpError(400, 'Missing request id.');
      const requestRef = firestore.collection('money_requests').doc(requestId);
      let outcome;
      await firestore.runTransaction(async (transaction) => {
        const requestDoc = await transaction.get(requestRef);
        if (!requestDoc.exists) throw httpError(404, 'Request not found.');
        const data = requestDoc.data() || {};
        const guard = canPay(data, decoded.uid);
        if (!guard.ok) throw httpError(400, guard.error);
        const pairKey = pairKeyFor(data.fromUid, data.toUid);
        const convoRef = firestore.collection('conversations').doc(pairKey);
        const payerRef = firestore.collection('balances').doc(decoded.uid);
        const [payer, convo] = await Promise.all([transaction.get(payerRef), transaction.get(convoRef)]);
        const amountPkn = Number(data.amountPkn);
        if (Number(payer.data()?.availablePkn || 0) < amountPkn) throw httpError(400, 'Your account balance is too low.');
        const convoData = convo.exists ? convo.data() : {};
        const members = convoData.members || [data.fromUid, data.toUid].sort();
        const stamp = now();
        const outLedger = firestore.collection('ledger_entries').doc();
        const inLedger = firestore.collection('ledger_entries').doc();
        transaction.set(payerRef, { availablePkn: admin.firestore.FieldValue.increment(-amountPkn), updatedAt: stamp }, { merge: true });
        transaction.set(firestore.collection('balances').doc(data.fromUid), { availablePkn: admin.firestore.FieldValue.increment(amountPkn), updatedAt: stamp }, { merge: true });
        transaction.set(outLedger, { uid: decoded.uid, type: 'money_request_paid_sent', amountPkn: -amountPkn, counterpartyUid: data.fromUid, counterpartyUsername: data.fromUsername, requestId, createdAt: stamp });
        transaction.set(inLedger, { uid: data.fromUid, type: 'money_request_paid_received', amountPkn, counterpartyUid: decoded.uid, counterpartyUsername: data.toUsername, requestId, createdAt: stamp });
        transaction.update(requestRef, { status: STATUS.PAID, paidAt: stamp, paidBy: decoded.uid, paymentLedgerId: outLedger.id });
        transaction.set(convoRef.collection('events').doc(), { type: EVENT_TYPES.PAYMENT, senderUid: decoded.uid, senderUsername: data.toUsername, amountPkn, note: data.note || '', requestId, transactionId: outLedger.id, createdAt: stamp });
        transaction.set(convoRef, {
          pairKey, members,
          memberUsernames: { ...(convoData.memberUsernames || {}), [data.fromUid]: data.fromUsername, [data.toUid]: data.toUsername },
          unread: bumpUnread(convoData.unread, members, decoded.uid),
          lastEvent: { type: EVENT_TYPES.PAYMENT, amountPkn, requestId, senderUid: decoded.uid, at: stamp },
          ...(convo.exists ? {} : { createdAt: stamp }),
        }, { merge: true });
        transaction.set(firestore.collection('notifications').doc(), { uid: data.fromUid, type: 'money_request_paid', requestId, actorUsername: data.toUsername, amountPkn, read: false, createdAt: stamp });
        outcome = { amountPkn, fromUsername: data.fromUsername, ledgerId: outLedger.id };
      });
      return res.status(200).json({ ok: true, ...outcome });
    }

    if (action === 'decline' || action === 'cancel') {
      const requestId = String(req.body?.requestId || '').trim();
      if (!requestId) throw httpError(400, 'Missing request id.');
      const requestRef = firestore.collection('money_requests').doc(requestId);
      const status = action === 'decline' ? STATUS.DECLINED : STATUS.CANCELLED;
      await firestore.runTransaction(async (transaction) => {
        const requestDoc = await transaction.get(requestRef);
        if (!requestDoc.exists) throw httpError(404, 'Request not found.');
        const data = requestDoc.data() || {};
        const guard = canRespond(data, decoded.uid, action);
        if (!guard.ok) throw httpError(400, guard.error);
        const convoRef = firestore.collection('conversations').doc(pairKeyFor(data.fromUid, data.toUid));
        const convo = await transaction.get(convoRef);
        const convoData = convo.exists ? convo.data() : {};
        const members = convoData.members || [data.fromUid, data.toUid].sort();
        const notifyUid = action === 'decline' ? data.fromUid : data.toUid;
        const stamp = now();
        transaction.update(requestRef, { status, resolvedAt: stamp });
        transaction.set(convoRef, {
          unread: bumpUnread(convoData.unread, members, decoded.uid),
          lastEvent: { type: EVENT_TYPES.MONEY_REQUEST, amountPkn: Number(data.amountPkn), requestId, status, senderUid: data.fromUid, at: stamp },
        }, { merge: true });
        transaction.set(firestore.collection('notifications').doc(), { uid: notifyUid, type: `money_request_${status}`, requestId, actorUsername: action === 'decline' ? data.toUsername : data.fromUsername, amountPkn: Number(data.amountPkn), read: false, createdAt: stamp });
      });
      return res.status(200).json({ ok: true, status });
    }

    throw httpError(400, 'Unknown action.');
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) console.error('money-request failed', error);
    return res.status(statusCode).json({ error: error.message || 'Money request failed.' });
  }
};
