'use strict';

const { getFirebaseAdmin, verifyBearerToken } = require('../server/_firebase');
const {
  EVENT_TYPES,
  USERNAME_RE,
  bumpUnread,
  cleanListings,
  cleanNote,
  cleanText,
  isParticipant,
  operationId,
  otherMember,
  pairKeyFor,
  previewForEvent,
  unreadFor,
  validateAmountPkn,
} = require('./_chat_core');
const { effectiveStatus } = require('./_money_request_core');

const EVENT_PAGE = 100;

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  return new Date(value).getTime() || 0;
}

async function usernameFor(firestore, uid, fallback = '') {
  const doc = await firestore.collection('users').doc(uid).get();
  return String(doc.data()?.username || fallback).trim().toLowerCase();
}

async function resolvePeer(firestore, peerUsername) {
  const username = String(peerUsername || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw httpError(400, 'Enter a valid username.');
  const doc = await firestore.collection('usernames').doc(username).get();
  const uid = String(doc.data()?.uid || '');
  if (!doc.exists || !uid) throw httpError(404, 'No Pokoin account was found for that username.');
  return { uid, username };
}

async function resolveRegisteredUser(admin, firestore, rawUid) {
  const uid = String(rawUid || '').trim();
  if (!/^[A-Za-z0-9]{8,128}$/.test(uid)) throw httpError(400, 'That seller account is missing.');
  let record;
  try {
    record = await admin.auth().getUser(uid);
  } catch (err) {
    if (err?.code === 'auth/user-not-found') throw httpError(404, 'No Pokoin account was found for that seller.');
    throw err;
  }
  return { uid: record.uid, username: await usernameFor(firestore, record.uid) };
}

function peerUidOnly(rawUid) {
  const uid = String(rawUid || '').trim();
  if (!/^[A-Za-z0-9]{8,128}$/.test(uid)) throw httpError(400, 'That seller account is missing.');
  return { uid, username: '' };
}

async function readEventPage(ref, beforeId) {
  let query = ref.collection('events').orderBy('createdAt', 'asc');
  if (beforeId) {
    const cursor = await ref.collection('events').doc(String(beforeId)).get();
    if (!cursor.exists) return { docs: [], hasMore: false };
    query = query.endBefore(cursor);
  }
  const snap = await query.limitToLast(EVENT_PAGE + 1).get();
  const docs = snap.docs;
  const hasMore = docs.length > EVENT_PAGE;
  return { docs: hasMore ? docs.slice(1) : docs, hasMore };
}

function serializeEvent(doc, uid, requestsById) {
  const data = doc.data() || {};
  const request = data.requestId ? requestsById.get(data.requestId) : null;
  return {
    id: doc.id,
    type: data.type,
    senderUid: data.senderUid,
    senderUsername: data.senderUsername || '',
    text: data.text || '',
    listings: Array.isArray(data.listings) ? data.listings : [],
    amountPkn: Number(data.amountPkn || request?.amountPkn || 0),
    note: data.note || request?.note || '',
    requestId: data.requestId || '',
    requestStatus: request ? effectiveStatus(request) : '',
    paymentLedgerId: request?.paymentLedgerId || '',
    transactionId: data.transactionId || '',
    createdAt: data.createdAt || null,
    mine: data.senderUid === uid,
  };
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
    const action = String(url.searchParams.get('action') || 'list');
    const me = { uid: decoded.uid, username: '' };
    if (req.method === 'POST') me.username = await usernameFor(firestore, decoded.uid);

    if (req.method === 'GET' && action === 'list') {
      const snap = await firestore.collection('conversations')
        .where('members', 'array-contains', me.uid).limit(100).get();
      const conversations = snap.docs.map((doc) => {
        const data = doc.data() || {};
        if (!isParticipant(data.members, me.uid)) return null;
        const peerUid = otherMember(data.members, me.uid);
        const lastEvent = data.lastEvent || {};
        return {
          pairKey: doc.id,
          peerUid,
          peerUsername: data.memberUsernames?.[peerUid] || '',
          preview: previewForEvent(lastEvent, me.uid),
          unread: unreadFor(data, me.uid),
          updatedAt: lastEvent.at || data.createdAt || null,
        };
      }).filter(Boolean).sort((a, b) => timestampMillis(b.updatedAt) - timestampMillis(a.updatedAt));
      return res.status(200).json({ conversations });
    }

    const peerUid = req.method === 'GET' ? url.searchParams.get('peerUid') : req.body?.peerUid;
    const peerName = req.method === 'GET' ? url.searchParams.get('peer') : req.body?.peer;
    const peer = peerUid
      ? (req.method === 'GET' ? peerUidOnly(peerUid) : await resolveRegisteredUser(admin, firestore, peerUid))
      : await resolvePeer(firestore, peerName);
    if (peer.uid === me.uid) throw httpError(400, 'You cannot open a conversation with yourself.');
    const pairKey = pairKeyFor(me.uid, peer.uid);
    const ref = firestore.collection('conversations').doc(pairKey);

    if (req.method === 'GET' && action === 'get') {
      const doc = await ref.get();
      if (doc.exists && !isParticipant(doc.data()?.members, me.uid)) throw httpError(403, 'Not your conversation.');
      const beforeId = String(url.searchParams.get('before') || '').trim();
      const { docs, hasMore } = await readEventPage(ref, beforeId);
      const requestIds = [...new Set(docs.map((event) => event.data()?.requestId).filter(Boolean))];
      const requestDocs = requestIds.length
        ? await Promise.all(requestIds.map((id) => firestore.collection('money_requests').doc(id).get()))
        : [];
      const requestsById = new Map(requestDocs.filter((item) => item.exists).map((item) => [item.id, item.data()]));
      const unread = !beforeId && doc.exists ? unreadFor(doc.data(), me.uid) : 0;
      if (unread) await ref.update({ [`unread.${me.uid}`]: 0 });
      const storedName = doc.exists ? doc.data()?.memberUsernames?.[peer.uid] : '';
      return res.status(200).json({
        pairKey,
        peer: { uid: peer.uid, username: storedName || peer.username || '' },
        unread,
        hasMore,
        events: docs.map((event) => serializeEvent(event, me.uid, requestsById)),
      });
    }

    if (req.method !== 'POST') throw httpError(405, 'Unsupported action.');

    if (action === 'message') {
      const listings = cleanListings(req.body?.listings);
      const text = cleanText(req.body?.text);
      if (!text && !listings.length) throw httpError(400, 'Write a message first.');
      const previewText = text || listings[0].cardName;
      await firestore.runTransaction(async (transaction) => {
        const convo = await transaction.get(ref);
        const data = convo.exists ? convo.data() : {};
        const members = data.members || [me.uid, peer.uid].sort();
        if (convo.exists && !isParticipant(members, me.uid)) throw httpError(403, 'Not your conversation.');
        const stamp = now();
        transaction.set(ref, {
          pairKey,
          members,
          memberUsernames: { ...(data.memberUsernames || {}), [me.uid]: me.username, [peer.uid]: peer.username },
          unread: bumpUnread(data.unread, members, me.uid),
          lastEvent: { type: EVENT_TYPES.TEXT, text: previewText, senderUid: me.uid, at: stamp },
          ...(convo.exists ? {} : { createdAt: stamp }),
        }, { merge: true });
        transaction.set(ref.collection('events').doc(), {
          type: EVENT_TYPES.TEXT, senderUid: me.uid, senderUsername: me.username, text, listings, createdAt: stamp,
        });
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'pay') {
      const checked = validateAmountPkn(req.body?.amountPkn);
      if (checked.error) throw httpError(400, checked.error);
      const clientToken = String(req.body?.clientToken || '').trim();
      const opId = operationId(me.uid, clientToken);
      if (!opId) throw httpError(400, 'Missing payment idempotency token.');
      const amountPkn = checked.amount;
      const note = cleanNote(req.body?.note);
      const operationRef = firestore.collection('payment_operations').doc(opId);
      const payerRef = firestore.collection('balances').doc(me.uid);
      let result;
      await firestore.runTransaction(async (transaction) => {
        const [operation, convo, payer] = await Promise.all([
          transaction.get(operationRef), transaction.get(ref), transaction.get(payerRef),
        ]);
        if (operation.exists) {
          const prior = operation.data() || {};
          if (prior.peerUid !== peer.uid || prior.amountPkn !== amountPkn) throw httpError(409, 'That payment token was already used.');
          result = { duplicate: true, ledgerId: prior.ledgerId, amountPkn };
          return;
        }
        const data = convo.exists ? convo.data() : {};
        const members = data.members || [me.uid, peer.uid].sort();
        if (convo.exists && !isParticipant(members, me.uid)) throw httpError(403, 'Not your conversation.');
        if (Number(payer.data()?.availablePkn || 0) < amountPkn) throw httpError(400, 'Your account balance is too low.');
        const stamp = now();
        const outLedger = firestore.collection('ledger_entries').doc();
        const inLedger = firestore.collection('ledger_entries').doc();
        transaction.set(payerRef, { availablePkn: admin.firestore.FieldValue.increment(-amountPkn), updatedAt: stamp }, { merge: true });
        transaction.set(firestore.collection('balances').doc(peer.uid), { availablePkn: admin.firestore.FieldValue.increment(amountPkn), updatedAt: stamp }, { merge: true });
        transaction.set(outLedger, { uid: me.uid, type: 'chat_payment_sent', amountPkn: -amountPkn, counterpartyUid: peer.uid, counterpartyUsername: peer.username, note, operationId: opId, createdAt: stamp });
        transaction.set(inLedger, { uid: peer.uid, type: 'chat_payment_received', amountPkn, counterpartyUid: me.uid, counterpartyUsername: me.username, note, operationId: opId, createdAt: stamp });
        transaction.set(ref.collection('events').doc(), { type: EVENT_TYPES.PAYMENT, senderUid: me.uid, senderUsername: me.username, amountPkn, note, transactionId: outLedger.id, createdAt: stamp });
        transaction.set(ref, {
          pairKey, members,
          memberUsernames: { ...(data.memberUsernames || {}), [me.uid]: me.username, [peer.uid]: peer.username },
          unread: bumpUnread(data.unread, members, me.uid),
          lastEvent: { type: EVENT_TYPES.PAYMENT, amountPkn, senderUid: me.uid, at: stamp },
          ...(convo.exists ? {} : { createdAt: stamp }),
        }, { merge: true });
        transaction.set(firestore.collection('notifications').doc(), { uid: peer.uid, type: 'chat_payment_received', actorUsername: me.username, amountPkn, read: false, createdAt: stamp });
        transaction.set(operationRef, { uid: me.uid, peerUid: peer.uid, amountPkn, ledgerId: outLedger.id, createdAt: stamp });
        result = { duplicate: false, ledgerId: outLedger.id, amountPkn };
      });
      return res.status(200).json({ ok: true, ...result });
    }

    if (action === 'read') {
      const doc = await ref.get();
      if (!doc.exists) return res.status(200).json({ ok: true });
      if (!isParticipant(doc.data()?.members, me.uid)) throw httpError(403, 'Not your conversation.');
      await ref.update({ [`unread.${me.uid}`]: 0 });
      return res.status(200).json({ ok: true });
    }

    throw httpError(400, 'Unknown action.');
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) console.error('chat failed', error);
    return res.status(statusCode).json({ error: error.message || 'Chat failed.' });
  }
};
