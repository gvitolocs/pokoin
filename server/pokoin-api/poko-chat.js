'use strict';

/**
 * Website Poko chat BFF — Hermes only.
 * POST /api/poko-chat  { message, cards?, images?, sessionId? }
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

async function hermesReply({ message, cards, images, userId, sessionId, displayName }) {
  const url = resolveHermesChatUrl();
  const token = hermesToken();
  if (!url || !token) {
    const error = new Error('Poko Hermes is not configured (POKONTACT_SERVICE_URL / token).');
    error.statusCode = 503;
    throw error;
  }

  const enriched = [message, cardsContext(cards), imagesContext(images)].filter(Boolean).join('\n\n');
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
      pageContext: (cards.length || images.length)
        ? { attachedCards: cards, attachedImages: images, channel: 'website-messages' }
        : { channel: 'website-messages' },
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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  try {
    const decoded = await verifyBearerToken(req);
    const message = cleanText(req.body?.message, 4000);
    const cards = cleanCards(req.body?.cards);
    const images = cleanImages(req.body?.images);
    if (!message && !cards.length && !images.length) {
      return res.status(400).json({ error: 'message, cards, or images required' });
    }
    const prompt = message || (cards[0]?.name
      ? `What can you tell me about ${cards[0].name}?`
      : images.length
        ? 'What can you tell me about the attached photo?'
        : 'Tell me about the attached card.');
    const sessionId = cleanText(req.body?.sessionId || decoded.uid, 80) || decoded.uid;

    try {
      const reply = await hermesReply({
        message: prompt,
        cards,
        images,
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
  cardsContext,
  imagesContext,
  resolveHermesChatUrl,
  hermesToken,
  HERMES_UNAVAILABLE,
};
