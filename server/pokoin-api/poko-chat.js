'use strict';

/**
 * Thin pass-through from the website chat dock to the real Poko
 * (Hermes /api/poko/chat on peer1). Unlike /api/pokoin-assistant (the legacy
 * Pokontact brain that answers many intents locally), this route ALWAYS
 * forwards, and passes the verified Firebase uid as Poko's userId so the
 * conversation memory is private per user.
 *
 * Auth: Firebase bearer (same as the rest of the site). The Pi container
 * already holds POKONTACT_SERVICE_TOKEN / POKONTACT_SERVICE_URL, which are
 * the shared Poko service credential and Hermes address (docs/poko-handoff.md).
 */

const { verifyBearerToken } = require('./_firebase');

const POKO_CHAT_URL = String(
  process.env.POKONTACT_SERVICE_URL || 'http://10.0.0.170:8789/api/poko',
).replace(/\/+$/, '') + '/chat';

// Read per request (matches poko-market) so rotating the env value takes effect without a restart.
function serviceToken() {
  return String(process.env.POKONTACT_SERVICE_TOKEN || process.env.POKO_API_TOKEN || '').trim();
}

const FORWARD_TIMEOUT_MS = Number(process.env.POKO_CHAT_TIMEOUT_MS || 60_000);

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sendJson(res, statusCode, body) {
  res.status(statusCode).json(body);
}

module.exports = async function handler(req, res) {
  if ((req.method || 'GET').toUpperCase() !== 'POST') {
    sendJson(res, 405, { error: 'POST only' });
    return;
  }
  if (!serviceToken()) {
    sendJson(res, 503, { error: 'poko-chat not configured: service token missing' });
    return;
  }

  let uid = '';
  try {
    uid = await verifyBearerToken(req);
  } catch {
    uid = '';
  }
  if (!uid) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const message = cleanText(req.body?.message, 2000);
  const sessionId = cleanText(req.body?.sessionId, 120) || `site-${uid.slice(0, 24)}`;
  if (message.length < 1) {
    sendJson(res, 400, { error: 'message required' });
    return;
  }

  try {
    const upstream = await fetch(`${POKO_CHAT_URL}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${serviceToken()}`,
      },
      body: JSON.stringify({
        message,
        userId: uid,
        sessionId,
        user: { id: uid },
      }),
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok || !data?.reply) {
      console.error('poko-chat upstream failed', {
        status: upstream.status,
        error: String(data?.error || '').slice(0, 200),
      });
      sendJson(res, 502, { error: 'Poko is unavailable right now, please try again soon.' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      assistant: 'poko',
      persona: 'Poko',
      reply: data.reply,
    });
  } catch (error) {
    console.error('poko-chat forward failed', { error: String(error?.message || error).slice(0, 200) });
    sendJson(res, 502, { error: 'Poko is unavailable right now, please try again soon.' });
  }
};

module.exports._test = { POKO_CHAT_URL, cleanText };
