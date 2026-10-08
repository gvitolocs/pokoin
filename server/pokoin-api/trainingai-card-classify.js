const { clientIp } = require('./_client_ip');
const { limitGlobal } = require('./_rate_limit');

const MAX_IMAGE_BYTES = Number(process.env.TRAININGAI_CLASSIFIER_MAX_IMAGE_BYTES || 8 * 1024 * 1024);
const DEFAULT_TIMEOUT_MS = Number(process.env.TRAININGAI_CLASSIFIER_TIMEOUT_MS || 120000);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-TrainingAI-Token',
  'Access-Control-Max-Age': '86400',
};

async function classifyRateLimited(req) {
  const verdict = await limitGlobal({ scope: 'trainingai-classify', identity: clientIp(req), limit: 30, windowSeconds: 60 });
  return !verdict.allowed;
}

function setCorsHeaders(res) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
}

function cleanTopK(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(Math.max(Math.trunc(parsed), 1), 10);
}

function configuredSpaceUrl() {
  const raw = String(
    process.env.TRAININGAI_CLASSIFIER_URL ||
      process.env.TRAININGAI_HF_SPACE_URL ||
      process.env.HF_SPACE_URL ||
      '',
  ).trim();
  return raw.replace(/\/+$/, '');
}

function configuredPublicEndpoint() {
  return String(
    process.env.TRAININGAI_PUBLIC_ENDPOINT ||
      'https://trainingai.pokoin.com/api/classify',
  ).trim();
}

function requestHeader(req, name) {
  const headers = req.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function bearerToken() {
  return String(
    process.env.TRAININGAI_HF_TOKEN ||
      process.env.HF_TOKEN ||
      '',
  ).trim();
}

function normalizeImageBase64(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
}

function decodeImageBase64(value) {
  const normalized = normalizeImageBase64(value);
  if (!normalized) {
    const error = new Error('imageBase64 is required.');
    error.statusCode = 400;
    throw error;
  }
  const buffer = Buffer.from(normalized, 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
    const error = new Error(`Image must be smaller than ${MAX_IMAGE_BYTES} bytes.`);
    error.statusCode = 400;
    throw error;
  }
  return buffer;
}

function baseClassifierRequest() {
  const baseUrl = configuredSpaceUrl();
  if (!baseUrl) {
    const error = new Error('TRAININGAI_CLASSIFIER_URL is not configured.');
    error.statusCode = 503;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const headers = { 'Content-Type': 'application/json' };
  const token = bearerToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return { baseUrl, controller, headers, timeout };
}

async function readClassifierResponse(response) {
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_) {
    payload = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(payload.error || payload.detail || `Classifier returned ${response.status}.`);
    error.statusCode = response.status >= 500 ? 502 : response.status;
    error.details = payload;
    throw error;
  }
  return payload;
}

async function postBase64ToClassifier(body, topK) {
  const { baseUrl, controller, headers, timeout } = baseClassifierRequest();
  try {
    const response = await fetch(`${baseUrl}/classify/base64`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        imageBase64: body.imageBase64,
        topK,
      }),
      signal: controller.signal,
    });
    return await readClassifierResponse(response);
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Classifier request timed out.');
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function postMultipartToClassifier(bodyBuffer, contentType) {
  const { baseUrl, controller, headers, timeout } = baseClassifierRequest();
  headers['Content-Type'] = contentType;
  try {
    const response = await fetch(`${baseUrl}/classify`, {
      method: 'POST',
      headers,
      body: bodyBuffer,
      signal: controller.signal,
    });
    return await readClassifierResponse(response);
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Classifier request timed out.');
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (await classifyRateLimited(req)) {
    return res.status(429).json({ ok: false, error: 'Too many classification requests.' });
  }

  try {
    const contentType = String(requestHeader(req, 'content-type') || '').toLowerCase();
    let payload;
    if (contentType.includes('multipart/form-data')) {
      const sourceBuffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.isBuffer(req.rawBody)
          ? req.rawBody
          : Buffer.alloc(0);
      if (!sourceBuffer.length || sourceBuffer.length > MAX_IMAGE_BYTES) {
        return res.status(400).json({
          ok: false,
          error: `Multipart image request must be smaller than ${MAX_IMAGE_BYTES} bytes.`,
        });
      }
      payload = await postMultipartToClassifier(sourceBuffer, requestHeader(req, 'content-type'));
    } else {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const imageBase64 = body.imageBase64 || body.image_base64 || body.image;
    const imageBuffer = decodeImageBase64(imageBase64);
    const topK = cleanTopK(body.topK ?? body.top_k);
      payload = await postBase64ToClassifier(
      {
        imageBase64: imageBuffer.toString('base64'),
      },
      topK,
    );
    }

    return res.status(200).json({
      ok: true,
      service: 'pokoin-trainingai-card-classify',
      classifier: configuredSpaceUrl(),
      publicEndpoint: configuredPublicEndpoint(),
      ...payload,
    });
  } catch (error) {
    console.error('trainingai-card-classify failed', error);
    return res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message || 'Card classification failed.',
      details: error.details,
      setupRequired: error.statusCode === 503 || undefined,
    });
  }
};
