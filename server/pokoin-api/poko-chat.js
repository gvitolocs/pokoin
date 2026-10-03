'use strict';

/**
 * Website Poko chat BFF — Hermes only.
 * POST /api/poko-chat  { message, cards?, images?, sessionId?, pageContext? }
 * GET  /api/poko-chat?action=history&before=
 *
 * Firebase-authed. Proxies to Hermes Poko at POKONTACT_SERVICE_URL/chat.
 * Transcript is stored in Firestore poko_conversations/{uid}/events so web
 * clients can sync across devices. No local scripted replies.
 */

const path = require('path');

const EVENT_PAGE = 20;
const { REPLY_CARDS_DIRECTIVE, attachReplyCards } = require('./_poko_reply_cards');
const { limitBestEffort } = require('./_rate_limit');

function requireHelper(name) {
  try {
    return require(path.join(__dirname, '..', 'server', name));
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return require(`./${name}`);
  }
}

function verifyBearerToken(...args) {
  return requireHelper('_firebase').verifyBearerToken(...args);
}

function getFirebaseAdmin() {
  return requireHelper('_firebase').getFirebaseAdmin();
}

function marketplaceQuery(...args) {
  return requireHelper('_marketplace_db').marketplaceQuery(...args);
}

function marketplaceWriteQuery(...args) {
  return requireHelper('_marketplace_db').marketplaceWriteQuery(...args);
}

function personalContextHelpers() {
  return require('./_poko_personal_context');
}

function summarizeOwnedCollectionSafe() {
  try {
    return requireHelper('_user_card_collection').summarizeOwnedCollection;
  } catch (_) {
    return null;
  }
}

function cleanText(value, max = 2000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanCards(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.slice(0, 12).map((row) => {
    const cardId = cleanText(row?.cardId || row?.id, 40);
    const path = cleanText(row?.path || row?.canonicalPath || row?.href, 200)
      || (cardId ? `/marketplace/en/cards/${cardId}` : '');
    const name = cleanText(row?.cardName || row?.name, 120);
    return {
      kind: 'card',
      cardId,
      name,
      cardName: name,
      setName: cleanText(row?.setName || row?.set, 120),
      condition: cleanText(row?.condition, 20),
      language: cleanText(row?.language, 12),
      canonicalPath: path,
      path,
      imageUrl: cleanText(row?.imageUrl || row?.cardImageUrl, 500),
      pricePkn: Number(row?.pricePkn || row?.minAsk) || 0,
    };
  }).filter((row) => row.cardId || row.name);
}

function cleanImages(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((url) => cleanText(url, 500))
    .filter((url) => /^https?:\/\//i.test(url))
    .slice(0, 8);
}

function cleanPageContext(raw, cards, images) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const desk = cards[0] || {};
  const { cleanCartItems, normalizeCardIds } = personalContextHelpers();
  const watchlistIds = normalizeCardIds(src.watchlistIds || src.watchlist || []);
  const cart = cleanCartItems(src.cart || []);
  return {
    channel: cleanText(src.channel || 'website-messages', 40) || 'website-messages',
    path: cleanText(src.path, 300),
    deskCardId: cleanText(src.deskCardId || desk.cardId, 40),
    deskCardName: cleanText(src.deskCardName || desk.name, 120),
    deskSetName: cleanText(src.deskSetName || desk.setName, 120),
    watchlistIds: watchlistIds.map(String),
    cart,
    attachedCards: cards,
    attachedImages: images,
  };
}

async function loadPersonalForChat(uid, pageContext) {
  try {
    const { buildPersonalContext, formatPersonalIntent } = personalContextHelpers();
    let firestore = null;
    try {
      firestore = getFirebaseAdmin().firestore();
    } catch (_) {
      firestore = null;
    }
    const personal = await buildPersonalContext({
      query: marketplaceQuery,
      writeQuery: marketplaceWriteQuery,
      uid,
      firestore,
      summarizeOwnedCollection: summarizeOwnedCollectionSafe(),
      overlay: {
        watchlistIds: pageContext.watchlistIds,
        cart: pageContext.cart,
        desk: {
          cardId: pageContext.deskCardId,
          name: pageContext.deskCardName,
          setName: pageContext.deskSetName,
        },
      },
      // Persist browser cart/watchlist/desk so Telegram/Discord Connect sees them.
      persistOverlay: true,
    });
    return {
      personal,
      intent: formatPersonalIntent(personal),
    };
  } catch (error) {
    console.warn('poko-chat personal context skipped', String(error?.message || error).slice(0, 160));
    return { personal: null, intent: '' };
  }
}

function cardsContext(cards) {
  if (!cards.length) return '';
  return `Attached cards:\n${cards.map((card, index) => {
    const bits = [
      `#${index + 1}`,
      card.name || 'card',
      card.setName ? `(${card.setName})` : '',
      card.cardId ? `id=${card.cardId}` : '',
      card.condition || '',
      card.language || '',
    ].filter(Boolean);
    return `- ${bits.join(' ')}`;
  }).join('\n')}`;
}

function imagesContext(images) {
  if (!images.length) return '';
  return `Attached photos (${images.length}):\n${images.map((url, index) => `- #${index + 1} ${url}`).join('\n')}`;
}

/** Chat photos live on our R2 bucket. Anything else is not fetched. */
function isUserPhotoUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname.endsWith('.r2.dev')
      && url.pathname.startsWith('/user-photos/');
  } catch {
    return false;
  }
}

function hitToPhotoCard(hit) {
  if (!hit || typeof hit !== 'object') return null;
  const score = Number(hit.score);
  if (!Number.isFinite(score) || score < 0.42) return null;
  const name = cleanText(hit.name, 120);
  if (!name) return null;
  const cardId = cleanText(hit.public_id || hit.publicId || '', 40);
  const path = cardId ? `/marketplace/en/cards/${cardId}` : '';
  return {
    kind: 'card',
    cardId,
    name,
    cardName: name,
    setName: cleanText(hit.set || hit.set_name || hit.expansion || '', 120),
    number: cleanText(hit.collector_number || hit.number || '', 20),
    score: Math.round(score * 1000) / 1000,
    path,
    canonicalPath: path,
  };
}

/** uniqueHits is the multi-card result. A lone top1 is the single-card lookup. */
function photoCardsFromIdentify(payload) {
  const unique = Array.isArray(payload?.uniqueHits) ? payload.uniqueHits : [];
  const boxes = Array.isArray(payload?.cards)
    ? payload.cards.map((row) => row?.top1).filter(Boolean)
    : [];
  const rows = unique.length ? unique : boxes;
  const out = [];
  const seen = new Set();
  for (const hit of rows) {
    const card = hitToPhotoCard(hit);
    if (!card) continue;
    const key = card.cardId || `${card.name}|${card.setName}|${card.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(card);
    if (out.length >= 8) break;
  }
  return out;
}

function photoCardLine(card, index) {
  return [
    `#${index + 1}`,
    card.name,
    card.setName ? `(${card.setName})` : '',
    card.number ? card.number : '',
    card.cardId ? `cardId=${card.cardId}` : '',
    Number.isFinite(card.score) ? `score=${card.score}` : '',
  ].filter(Boolean).join(' ');
}

function photoSearchContext(photoCards) {
  if (!photoCards.length) return '';
  return [
    `Multi-card search of the attached photo (${photoCards.length} printings; not a single-card lookup):`,
    ...photoCards.map((card, index) => `- ${photoCardLine(card, index)}`),
  ].join('\n');
}

const SCAN_PRIMARY = process.env.SCAN_PRIMARY_URL || 'http://127.0.0.1:18151';
const SCAN_FALLBACK = process.env.SCAN_FALLBACK_URL || 'http://127.0.0.1:18150';

async function identifyOnePhoto(url, { fetchImpl, primary, fallback }) {
  const image = await fetchImpl(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (!image?.ok) return [];
  const bytes = Buffer.from(await image.arrayBuffer());
  if (bytes.length < 32 || bytes.length > 4_000_000) return [];
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return [];
  const path = '/identify?catalog=pokemon_generic&multi=1&live=0&top_k=3';
  for (const base of [primary, fallback].filter(Boolean)) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'photo.jpg');
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(base === primary ? 12000 : 25000),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.busy) continue;
      const cards = photoCardsFromIdentify(data);
      if (cards.length) return cards;
    } catch {
      /* try the other worker */
    }
  }
  return [];
}

/** YOLO + Milo on every box in the photo. Single-card lookup is not used. */
async function identifyChatPhotos(urls, {
  fetchImpl = globalThis.fetch,
  primary = SCAN_PRIMARY,
  fallback = SCAN_FALLBACK,
} = {}) {
  const own = (Array.isArray(urls) ? urls : []).filter(isUserPhotoUrl).slice(0, 4);
  const found = [];
  const seen = new Set();
  for (const url of own) {
    let cards = [];
    try {
      cards = await identifyOnePhoto(url, { fetchImpl, primary, fallback });
    } catch (error) {
      console.warn('poko-chat photo search skipped', String(error?.message || error).slice(0, 160));
    }
    for (const card of cards) {
      const key = card.cardId || `${card.name}|${card.setName}|${card.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(card);
      if (found.length >= 8) return found;
    }
  }
  return found;
}

/** Force market-tool path on Hermes: desk card → quote analytics first, never invent identity. */
function marketFirstDirective(cards, pageContext, photoCards = []) {
  if (photoCards.length) {
    return [
      'Operator directive for this turn:',
      '- The attached photo was identified with multi-card search (every detected card), not a single-card lookup.',
      '- Identified printings, in reading order:',
      ...photoCards.map((card, index) => `- ${photoCardLine(card, index)}`),
      '- Quote Pokoin analytics for every identified printing via market_query multipath including card_quote (use each cardId). Do not answer as if the photo contains only one card.',
      '- card_quote.priceSources includes dated CardTrader lowest listed asks in PKN and separate TCGplayer aggregate market quotes in USD. Cite the source and observation date; asks are not sales, aggregate quotes are not condition-specific, and zero sold comps does not erase price analytics. Never convert USD to PKN implicitly.',
      '- For attacks, abilities, HP, or printed rules, include card_ocr in that card\'s multipath (western leftover OCR; approximate).',
      '- A weak score is a guess: say so. Never invent a card that is not in this list.',
      '- The open desk card is separate from the photo. Mention it only if the user also asked about the page.',
    ].join('\n');
  }
  const card = cards[0];
  const id = card?.cardId || pageContext?.deskCardId;
  if (!id && !card?.name) return '';
  const name = card?.name || pageContext?.deskCardName || 'this card';
  const set = card?.setName || pageContext?.deskSetName || '';
  const bits = [name, set ? `(${set})` : '', id ? `cardId=${id}` : ''].filter(Boolean).join(' ');
  return [
    'Operator directive for this turn:',
    `- The user is on the Pokoin marketplace looking at ${bits}.`,
    '- First purpose: Pokoin card analytics (sold median, asks, liquidity) via market_query multipath including card_quote (use the given cardId when present).',
    '- card_quote.priceSources includes dated CardTrader lowest listed asks in PKN and separate TCGplayer aggregate market quotes in USD. Cite the source and observation date; asks are not sales, aggregate quotes are not condition-specific, and zero sold comps does not erase price analytics. Never convert USD to PKN implicitly.',
    '- For attacks, abilities, HP, or printed rules on this card, include card_ocr in the same multipath with the same cardId (western leftover OCR; approximate).',
    '- Never invent a different card name, set, HP, or attack. If tools fail, say you do not know yet.',
    '- Lore/flavor only after quoting site numbers, and only if it matches the same cardId.',
  ].join('\n');
}

/** Same URL convention as CardVault pokoin-assistant: base …/api/poko + /chat. */
function resolveHermesChatUrl(env = process.env) {
  const raw = String(env.POKO_CHAT_URL || env.POKONTACT_SERVICE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (/\/chat$/i.test(raw)) return raw;
  return `${raw}/chat`;
}

function hermesToken(env = process.env) {
  return String(env.POKO_API_TOKEN || env.POKONTACT_SERVICE_TOKEN || '').trim();
}

const HERMES_UNAVAILABLE = 'I don’t know the answer yet, but I’m always improving ✨ Ask me another way, or try a cute card question while my tiny brain levels up.';
const HERMES_UNAVAILABLE_ERROR = 'Poko could not reach the assistant in time. Try again in a moment.';

async function hermesReply({
  message,
  cards,
  images,
  photoCards = [],
  pageContext,
  personalIntent = '',
  personal = null,
  userId,
  sessionId,
  displayName,
}) {
  const url = resolveHermesChatUrl();
  const token = hermesToken();
  if (!url || !token) {
    const error = new Error('Poko Hermes is not configured (POKONTACT_SERVICE_URL / token).');
    error.statusCode = 503;
    throw error;
  }

  const enriched = [
    marketFirstDirective(cards, pageContext, photoCards),
    personalIntent,
    message,
    photoSearchContext(photoCards),
    cardsContext(cards),
    imagesContext(images),
    REPLY_CARDS_DIRECTIVE,
  ].filter(Boolean).join('\n\n');
  const pageWithPersonal = personal
    ? { ...pageContext, personal }
    : pageContext;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      message: enriched,
      // Raw question for Hermes intent routing: `enriched` leads with desk /
      // personal context, so keyword gates on it matched the context instead.
      userMessage: message,
      userId,
      sessionId,
      user: { id: userId, displayName: displayName || '' },
      pageContext: pageWithPersonal,
      personalIntent,
    }),
    signal: AbortSignal.timeout(Number(process.env.POKO_CHAT_TIMEOUT_MS) || 90000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `Poko chat failed (${response.status})`);
    error.statusCode = response.status >= 400 && response.status < 600 ? response.status : 502;
    throw error;
  }
  const reply = cleanText(data?.reply || data?.text || '', 8000);
  if (!reply) {
    const error = new Error('Poko returned an empty reply.');
    error.statusCode = 502;
    throw error;
  }
  return {
    reply,
    cards: cleanCards(data?.cards),
  };
}

// Per-IP comfort limit shared across API instances through Valkey, with a
// bounded local fallback when Valkey is down: 20 msgs / minute, same shape as
// the legacy assistant. The IP is hashed before it reaches any key.
async function chatRateLimited(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || req.headers?.['X-Forwarded-For'] || '').split(',')[0].trim();
  const ip = forwarded || String(req.socket?.remoteAddress || 'unknown');
  const verdict = await limitBestEffort({ scope: 'poko-chat', identity: ip, limit: 20, windowSeconds: 60 });
  return !verdict.allowed;
}

function conversationRef(firestore, uid) {
  return firestore.collection('poko_conversations').doc(String(uid));
}

function firestoreTimeIso(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toDate === 'function') {
    try {
      return value.toDate().toISOString();
    } catch (_) {
      return null;
    }
  }
  if (typeof value._seconds === 'number') {
    return new Date(value._seconds * 1000).toISOString();
  }
  if (typeof value.seconds === 'number') {
    return new Date(value.seconds * 1000).toISOString();
  }
  return null;
}

function serializeEvent(doc) {
  const data = doc.data() || {};
  const role = data.role === 'assistant' ? 'assistant' : 'user';
  const cards = Array.isArray(data.cards) ? data.cards : [];
  return {
    id: doc.id,
    role,
    mine: role === 'user',
    text: data.text || '',
    cards,
    listings: cards,
    images: Array.isArray(data.images) ? data.images : [],
    source: data.source || '',
    turnId: data.turnId || '',
    clientTurnId: data.clientTurnId || '',
    createdAt: firestoreTimeIso(data.createdAt),
  };
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

/**
 * One user turn + its reply. The question is stamped when it arrived and the
 * reply strictly later, so they can never tie (a shared serverTimestamp made
 * the random doc id decide, and the reply showed above the question). Both
 * carry turnId; the user row echoes the client's optimistic id.
 */
async function appendTurn({
  firestore,
  uid,
  userText,
  cards,
  images,
  reply,
  replyCards = [],
  source,
  userAtMs = Date.now(),
  replyAtMs = Date.now(),
  clientTurnId = '',
}) {
  const admin = getFirebaseAdmin();
  const Timestamp = admin.firestore.Timestamp;
  const askedAt = Math.trunc(Number(userAtMs) || Date.now());
  const answeredAt = Math.max(Math.trunc(Number(replyAtMs) || Date.now()), askedAt + 1);
  const at = (ms) => (Timestamp?.fromMillis ? Timestamp.fromMillis(ms) : new Date(ms));
  const ref = conversationRef(firestore, uid);
  const userRef = ref.collection('events').doc();
  const assistantRef = ref.collection('events').doc();
  const turnId = userRef.id;
  const batch = firestore.batch();
  const assistantCards = cleanCards(replyCards);
  batch.set(ref, { uid, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  batch.set(userRef, {
    role: 'user',
    text: userText || '',
    cards,
    images,
    turnId,
    clientTurnId,
    createdAt: at(askedAt),
  });
  batch.set(assistantRef, {
    role: 'assistant',
    text: reply || '',
    cards: assistantCards,
    images: [],
    source: source || 'hermes',
    turnId,
    createdAt: at(answeredAt),
  });
  await batch.commit();
  return [
    {
      id: userRef.id,
      role: 'user',
      mine: true,
      text: userText || '',
      cards,
      listings: cards,
      images,
      source: '',
      turnId,
      clientTurnId,
      createdAt: new Date(askedAt).toISOString(),
    },
    {
      id: assistantRef.id,
      role: 'assistant',
      mine: false,
      text: reply || '',
      cards: assistantCards,
      listings: assistantCards,
      images: [],
      source: source || 'hermes',
      turnId,
      clientTurnId: '',
      createdAt: new Date(answeredAt).toISOString(),
    },
  ];
}

function cleanClientTurnId(value) {
  const text = cleanText(value, 80);
  return /^[A-Za-z0-9_-]{1,80}$/.test(text) ? text : '';
}

async function handleHistory(req, res, uid) {
  const url = new URL(req.url, 'https://local');
  const before = cleanText(url.searchParams.get('before'), 80);
  const admin = getFirebaseAdmin();
  const firestore = admin.firestore();
  const ref = conversationRef(firestore, uid);
  const { docs, hasMore } = await readEventPage(ref, before);
  return res.status(200).json({
    ok: true,
    events: docs.map(serializeEvent),
    hasMore,
  });
}

/**
 * Never echo the card the user already has open or attached under Poko's reply.
 * Name matching applies to catalog lookups by name only, which can return a
 * different printing of the same open card; Hermes tool cards keep other
 * printings of the same name ("other Raikou ex printings").
 */
function withoutOpenCards(replyCards, { pageContext = {}, cards = [], byName = false } = {}) {
  const ids = new Set([pageContext.deskCardId, ...cards.map((card) => card.cardId)]
    .filter(Boolean).map(String));
  const names = new Set([pageContext.deskCardName, ...cards.map((card) => card.name)]
    .filter(Boolean).map((name) => String(name).toLowerCase()));
  return (Array.isArray(replyCards) ? replyCards : []).filter((card) => (
    !ids.has(String(card?.cardId || ''))
    && !(byName && names.has(String(card?.name || card?.cardName || '').toLowerCase()))
  ));
}

async function handleChat(req, res, decoded) {
  if (await chatRateLimited(req)) {
    return res.status(429).json({ error: 'Too many messages, please slow down.' });
  }
  const receivedAtMs = Date.now();
  const clientTurnId = cleanClientTurnId(req.body?.clientTurnId);
  const message = cleanText(req.body?.message, 4000);
  const cards = cleanCards(req.body?.cards);
  const images = cleanImages(req.body?.images);
  const pageContext = cleanPageContext(req.body?.pageContext, cards, images);
  if (!message && !cards.length && !images.length) {
    return res.status(400).json({ error: 'message, cards, or images required' });
  }
  const photoCards = images.length ? await identifyChatPhotos(images) : [];
  const prompt = message || (photoCards.length
    ? `The attached photo was identified with multi-card search (${photoCards.length} printings). Quote Pokoin sold median, current asks, and liquidity for each one. Do not collapse the photo to a single card.`
    : cards[0]?.name
    ? `Quote Pokoin sold median, current asks, and liquidity for ${cards[0].name}${cards[0].cardId ? ` (cardId=${cards[0].cardId})` : ''}. Lead with site analytics.`
    : images.length
      ? 'What can you tell me about the attached photo? Multi-card search found no printings; do not invent cards.'
      : 'Tell me about the attached card with Pokoin sold/ask/liquidity analytics first.');
  const sessionId = cleanText(req.body?.sessionId || decoded.uid, 80) || decoded.uid;
  const userVisible = message || prompt;
  const firestore = getFirebaseAdmin().firestore();
  const { personal, intent: personalIntent } = await loadPersonalForChat(decoded.uid, pageContext);

  let reply = '';
  let replyCards = [];
  let source = 'hermes';
  let hermesError = '';
  try {
    const hermes = await hermesReply({
      message: prompt,
      cards,
      images,
      photoCards,
      pageContext,
      personalIntent,
      personal,
      userId: decoded.uid,
      sessionId,
      displayName: cleanText(decoded.name || decoded.email, 80),
    });
    // Hermes' own tool cards win; otherwise resolve the cards Poko names
    // (hidden [[cards: …]] line, lists, bold) against the catalog.
    const hermesCards = Array.isArray(hermes.cards) ? hermes.cards : [];
    const attached = await attachReplyCards(hermes.reply, {
      query: hermesCards.length ? null : marketplaceQuery,
    });
    reply = attached.text || hermes.reply;
    const fromPhoto = photoCards.filter((card) => card.cardId);
    replyCards = withoutOpenCards(
      [...fromPhoto, ...(hermesCards.length ? hermesCards : attached.cards)],
      { pageContext, cards, byName: !hermesCards.length },
    ).slice(0, 8);
  } catch (error) {
    hermesError = String(error?.message || error).slice(0, 200);
    console.warn('poko-chat hermes failed', hermesError);
    reply = HERMES_UNAVAILABLE;
    source = 'unavailable';
  }

  let events = [];
  try {
    events = await appendTurn({
      firestore,
      uid: decoded.uid,
      userText: userVisible,
      cards,
      images,
      reply,
      replyCards,
      source,
      userAtMs: receivedAtMs,
      replyAtMs: Date.now(),
      clientTurnId,
    });
  } catch (error) {
    console.error('poko-chat persist failed', String(error?.message || error).slice(0, 200));
  }

  if (source === 'unavailable') {
    return res.status(200).json({
      ok: false,
      assistant: 'poko',
      persona: 'Poko',
      reply,
      source,
      error: HERMES_UNAVAILABLE_ERROR,
      events,
    });
  }

  return res.status(200).json({
    ok: true,
    assistant: 'poko',
    persona: 'Poko',
    reply,
    cards: replyCards,
    source,
    events,
  });
}

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  try {
    const decoded = await verifyBearerToken(req);
    if (req.method === 'GET') {
      const url = new URL(req.url, 'https://local');
      const action = cleanText(url.searchParams.get('action') || 'history', 40) || 'history';
      if (action !== 'history') {
        return res.status(400).json({ error: 'Unknown action.' });
      }
      return handleHistory(req, res, decoded.uid);
    }
    return handleChat(req, res, decoded);
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('poko-chat', error.message);
    return res.status(status).json({ error: error.message || 'Poko chat failed.' });
  }
};

module.exports._test = {
  cleanCards,
  cleanImages,
  cleanPageContext,
  cardsContext,
  imagesContext,
  isUserPhotoUrl,
  photoCardsFromIdentify,
  photoSearchContext,
  identifyChatPhotos,
  marketFirstDirective,
  resolveHermesChatUrl,
  hermesToken,
  hermesReply,
  withoutOpenCards,
  serializeEvent,
  appendTurn,
  cleanClientTurnId,
  loadPersonalForChat,
  HERMES_UNAVAILABLE,
  HERMES_UNAVAILABLE_ERROR,
  EVENT_PAGE,
};
