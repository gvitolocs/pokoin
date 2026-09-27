'use strict';

/**
 * Website Poko chat BFF.
 * POST /api/poko-chat  { message, cards?, sessionId? }
 *
 * Firebase-authed. Proxies to Hermes /api/poko/chat when POKO_CHAT_URL is set;
 * otherwise answers market questions through the local poko-market tools so
 * sellers can attach cards and ask about prices/liquidity without the browser
 * ever seeing the service token.
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

function marketTools() {
  return require('./poko-market')._test.TOOLS;
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

function looksLikeMarket(message) {
  return /\b(price|worth|value|sold|sell|buy|quote|liquidity|market|median|how much|quanto|valore|prezzo)\b/i.test(message);
}

function formatQuote(result) {
  if (!result || result.status === 'not_found') {
    return 'I could not find that card in the Pokoin catalog. Try another name or attach the card from the marketplace.';
  }
  if (result.status === 'ambiguous') {
    const names = (result.candidates || []).slice(0, 5).map((row) => row.name || row.cardId).filter(Boolean);
    return `I found a few matches — which one did you mean?\n${names.map((name) => `• ${name}`).join('\n')}`;
  }
  const name = result.name || result.card?.name || 'That card';
  const setName = result.setName || result.card?.setName || '';
  const sold = result.sold || result.estimate || {};
  const median = sold.medianPkn ?? sold.median ?? result.medianSoldPkn;
  const asks = result.asks || result.asking || {};
  const ask = asks.minPkn ?? asks.lowestPkn ?? result.lowestAskPkn;
  const lines = [
    `${name}${setName ? ` · ${setName}` : ''}`,
  ];
  if (median != null) lines.push(`Sold median (90d): ${median} PKN`);
  if (ask != null) lines.push(`Lowest ask now: ${ask} PKN`);
  if (result.askingPriceOnly) lines.push('No solid sold sample yet — this is asking-price only.');
  if (result.liquidity) {
    const liq = result.liquidity;
    if (liq.typicalDays != null) {
      lines.push(`Typical sell time: ~${liq.typicalDays} days (${liq.lowDays ?? '?'}–${liq.highDays ?? '?'}).`);
    }
  }
  if (result.confidence) lines.push(`Confidence: ${result.confidence}.`);
  lines.push('Ask me anything else about this printing — I use Pokoin’s public market tools only.');
  return lines.join('\n');
}

async function localMarketReply(message, cards, images = []) {
  const TOOLS = marketTools();
  const primary = cards[0];
  const query = primary?.name || message;
  const cardId = primary?.cardId || '';
  const condition = primary?.condition || '';
  const language = primary?.language || '';

  if (cardId || looksLikeMarket(message) || primary?.name) {
    const quote = await TOOLS.card_quote({
      cardId: cardId || undefined,
      query: cardId ? undefined : query,
      condition: condition || undefined,
      language: language || undefined,
    });
    if (quote?.status === 'ambiguous' || quote?.status === 'not_found') {
      const resolved = await TOOLS.resolve_card({ query });
      if (resolved?.status === 'ambiguous') return formatQuote(resolved);
      if (resolved?.candidates?.[0]?.cardId) {
        const again = await TOOLS.card_quote({
          cardId: resolved.candidates[0].cardId,
          condition: condition || undefined,
          language: language || undefined,
        });
        return formatQuote({ ...again, name: resolved.candidates[0].name, setName: resolved.candidates[0].setName });
      }
      return formatQuote(quote);
    }
    return formatQuote(quote);
  }

  if (images.length && !message) {
    return 'Got your photo. Tell me the card name or drop the listing from the marketplace and I\'ll pull sold medians and asks.';
  }

  return [
    'Hey — I\'m Poko. Drop a card on this chat, add a photo, or ask about a printing and I\'ll pull sold medians, asks, and sell-time bands from Pokoin\'s market tools.',
    'I only see public catalog and aggregate market data — never private seller accounts.',
  ].join('\n');
}

async function hermesReply({ message, cards, images, userId, sessionId, displayName }) {
  const base = String(process.env.POKO_CHAT_URL || '').trim().replace(/\/$/, '');
  const token = String(process.env.POKO_API_TOKEN || process.env.POKONTACT_SERVICE_TOKEN || '').trim();
  if (!base || !token) return null;

  const enriched = [message, cardsContext(cards), imagesContext(images)].filter(Boolean).join('\n\n');
  const response = await fetch(`${base}/api/poko/chat`, {
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
        ? { attachedCards: cards, attachedImages: images }
        : undefined,
    }),
    signal: AbortSignal.timeout(Number(process.env.POKO_CHAT_TIMEOUT_MS) || 45000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Poko chat failed (${response.status})`);
  }
  return cleanText(data?.reply || data?.text || '', 8000);
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

    let reply = '';
    let source = 'local';
    try {
      const remote = await hermesReply({
        message: prompt,
        cards,
        images,
        userId: decoded.uid,
        sessionId,
        displayName: cleanText(decoded.name || decoded.email, 80),
      });
      if (remote) {
        reply = remote;
        source = 'hermes';
      }
    } catch (error) {
      console.warn('poko-chat hermes failed; using local market tools', String(error?.message || error).slice(0, 200));
    }
    if (!reply) {
      reply = await localMarketReply(prompt, cards, images);
      source = 'local';
    }

    return res.status(200).json({
      ok: true,
      assistant: 'poko',
      persona: 'Poko',
      reply,
      source,
    });
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
  looksLikeMarket,
  formatQuote,
  localMarketReply,
};
