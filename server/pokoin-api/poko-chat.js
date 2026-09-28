'use strict';

/**
 * Website Poko chat BFF — Hermes only.
 * POST /api/poko-chat  { message, cards?, images?, sessionId?, pageContext? }
 *
 * Firebase-authed. Proxies to Hermes Poko at POKONTACT_SERVICE_URL/chat
 * (same convention as pokoin-assistant). No local scripted replies and no
 * local market-tool fallback — Hermes owns answers and may call poko-market.
 */

const path = require('path');

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

function cleanText(value, max = 2000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanCards(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.slice(0, 8).map((row) => ({
    cardId: cleanText(row?.cardId || row?.id, 40),
    name: cleanText(row?.cardName || row?.name, 120),
    setName: cleanText(row?.setName || row?.set, 120),
    condition: cleanText(row?.condition, 20),
    language: cleanText(row?.language, 12),
    canonicalPath: cleanText(row?.canonicalPath || row?.href, 200),
  })).filter((row) => row.cardId || row.name);
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
  return {
    channel: cleanText(src.channel || 'website-messages', 40) || 'website-messages',
    path: cleanText(src.path, 300),
    deskCardId: cleanText(src.deskCardId || desk.cardId, 40),
    deskCardName: cleanText(src.deskCardName || desk.name, 120),
    deskSetName: cleanText(src.deskSetName || desk.setName, 120),
    attachedCards: cards,
    attachedImages: images,
  };
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

/** Force market-tool path on Hermes: desk card → quote analytics first, never invent identity. */
function marketFirstDirective(cards, pageContext) {
  const card = cards[0];
  const id = card?.cardId || pageContext?.deskCardId;
  if (!id && !card?.name) return '';
  const name = card?.name || pageContext?.deskCardName || 'this card';
  const set = card?.setName || pageContext?.deskSetName || '';
  const bits = [name, set ? `(${set})` : '', id ? `cardId=${id}` : ''].filter(Boolean).join(' ');
  return [
    'Operator directive for this turn:',
    `- The user is on the Pokoin marketplace looking at ${bits}.`,
    '- First purpose: Pokoin card analytics (sold median, asks, liquidity) via market_query → card_quote (use the given cardId when present).',
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

async function hermesReply({ message, cards, images, pageContext, userId, sessionId, displayName }) {
  const url = resolveHermesChatUrl();
  const token = hermesToken();
  if (!url || !token) {
    const error = new Error('Poko Hermes is not configured (POKONTACT_SERVICE_URL / token).');
    error.statusCode = 503;
    throw error;
  }

  const enriched = [
    marketFirstDirective(cards, pageContext),
    message,
    cardsContext(cards),
    imagesContext(images),
  ].filter(Boolean).join('\n\n');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      message: enriched,
      userId,
      sessionId,
      user: { id: userId, displayName: displayName || '' },
      pageContext,
    }),
    signal: AbortSignal.timeout(Number(process.env.POKO_CHAT_TIMEOUT_MS) || 45000),
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
  return reply;
}

// Per-IP rate limit, same shape as the legacy assistant (20 msgs / minute).
const chatHits = new Map();

function chatRateLimited(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || req.headers?.['X-Forwarded-For'] || '').split(',')[0].trim();
  const ip = forwarded || String(req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  const fresh = (chatHits.get(ip) || []).filter((stamp) => now - stamp < 60_000);
  fresh.push(now);
  chatHits.set(ip, fresh);
  if (chatHits.size > 5000) chatHits.clear();
  return fresh.length > 20;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (chatRateLimited(req)) {
    return res.status(429).json({ error: 'Too many messages, please slow down.' });
  }
  try {
    const decoded = await verifyBearerToken(req);
    const message = cleanText(req.body?.message, 4000);
    const cards = cleanCards(req.body?.cards);
    const images = cleanImages(req.body?.images);
    const pageContext = cleanPageContext(req.body?.pageContext, cards, images);
    if (!message && !cards.length && !images.length) {
      return res.status(400).json({ error: 'message, cards, or images required' });
    }
    const prompt = message || (cards[0]?.name
      ? `Quote Pokoin sold median, current asks, and liquidity for ${cards[0].name}${cards[0].cardId ? ` (cardId=${cards[0].cardId})` : ''}. Lead with site analytics.`
      : images.length
        ? 'What can you tell me about the attached photo? Prefer OCR identity then Pokoin market tools when you can resolve a card.'
        : 'Tell me about the attached card with Pokoin sold/ask/liquidity analytics first.');
    const sessionId = cleanText(req.body?.sessionId || decoded.uid, 80) || decoded.uid;

    try {
      const reply = await hermesReply({
        message: prompt,
        cards,
        images,
        pageContext,
        userId: decoded.uid,
        sessionId,
        displayName: cleanText(decoded.name || decoded.email, 80),
      });
      return res.status(200).json({
        ok: true,
        assistant: 'poko',
        persona: 'Poko',
        reply,
        source: 'hermes',
      });
    } catch (error) {
      console.warn('poko-chat hermes failed', String(error?.message || error).slice(0, 200));
      return res.status(200).json({
        ok: true,
        assistant: 'poko',
        persona: 'Poko',
        reply: HERMES_UNAVAILABLE,
        source: 'unavailable',
      });
    }
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
  marketFirstDirective,
  resolveHermesChatUrl,
  hermesToken,
  HERMES_UNAVAILABLE,
};
