'use strict';

/**
 * PowerTools-style pricing strategies + pricer settings on users/{uid}.
 *
 * GET    /api/marketplace-pricing-strategies            → { strategies, pricerSettings }
 * POST   /api/marketplace-pricing-strategies            → { strategy } upserts (id required,
 *                                                         empty id mints one); { pricerSettings }
 *                                                         saves the pricer defaults.
 * DELETE /api/marketplace-pricing-strategies?id=...     → removes one strategy
 *
 * Strategies are evaluated CLIENT-side against /api/marketplace-price-check
 * comps; this handler only stores them. Fields:
 *   { id, name, source: pokoin|cardtrader, action: match|undercut|premium,
 *     amountPct, amountPkn, minPkn, rounding: none|integer,
 *     condition, language, enabled, createdAt, updatedAt }
 */

const queryFirestore = (...args) => require('./_firebase').getFirebaseAdmin(...args);
const verifyBearer = (...args) => require('./_firebase').verifyBearerToken(...args);

const SOURCES = new Set(['pokoin', 'cardtrader']);
const ACTIONS = new Set(['match', 'undercut', 'premium']);
const ROUNDINGS = new Set(['none', 'integer']);
const CONDITIONS = new Set(['', 'NM', 'SP', 'MP', 'PL', 'Poor']);

function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function numberOr(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Validate + normalize one strategy. Throws statusCode-carrying errors. */
function sanitizeStrategy(input, existing = null) {
  const fail = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  };
  const now = new Date().toISOString();
  const id = cleanText(input?.id, 40) || existing?.id || `st_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const name = cleanText(input?.name, 80);
  if (!name) fail('Strategy name is required.');
  const source = cleanText(input?.source, 20).toLowerCase();
  if (!SOURCES.has(source)) fail('Pricer source must be pokoin or cardtrader.');
  const action = cleanText(input?.action, 20).toLowerCase();
  if (!ACTIONS.has(action)) fail('Strategy action must be match, undercut or premium.');
  const amountPct = numberOr(input?.amountPct, 0, { min: 0, max: 90 });
  const amountPkn = numberOr(input?.amountPkn, 0, { min: 0, max: 1_000_000 });
  const minPkn = numberOr(input?.minPkn, 0, { min: 0, max: 1_000_000 });
  const rounding = ROUNDINGS.has(cleanText(input?.rounding, 20).toLowerCase())
    ? cleanText(input?.rounding, 20).toLowerCase()
    : 'none';
  const condition = cleanText(input?.condition, 8).toUpperCase();
  if (!CONDITIONS.has(condition)) fail('Condition scope is invalid.');
  const language = cleanText(input?.language, 8).toUpperCase();
  return {
    ...(existing || {}),
    id,
    name,
    source,
    action,
    amountPct: Number(amountPct.toFixed(4)),
    amountPkn: Number(amountPkn.toFixed(6)),
    minPkn: Number(minPkn.toFixed(6)),
    rounding,
    condition,
    language,
    enabled: input?.enabled === undefined ? (existing?.enabled ?? true) : input?.enabled === true,
    createdAt: existing?.createdAt || input?.createdAt || now,
    updatedAt: now,
  };
}

function sanitizeSettings(input) {
  const raw = input || {};
  const source = cleanText(raw.defaultSource, 20).toLowerCase();
  return {
    defaultSource: SOURCES.has(source) ? source : 'cardtrader',
    autoMarketColumn: raw.autoMarketColumn === true,
  };
}

/** Target PKN for a comp under this strategy — the same math the SPA applies. */
function evaluateStrategyTarget(compPkn, strategy) {
  if (!(Number(compPkn) > 0)) return null;
  let target = Number(compPkn);
  const pct = Number(strategy.amountPct) || 0;
  const flat = Number(strategy.amountPkn) || 0;
  if (strategy.action === 'undercut') target = target * (1 - pct / 100) - flat;
  else if (strategy.action === 'premium') target = target * (1 + pct / 100) + flat;
  if (strategy.rounding === 'integer') target = Math.round(target);
  const min = Number(strategy.minPkn) || 0;
  if (min > 0) target = Math.max(target, min);
  if (!(target > 0)) return null;
  return Number(target.toFixed(6));
}

function strategyMatchesRow(strategy, row) {
  if (strategy.enabled === false) return false;
  if (strategy.condition && String(row?.condition || 'NM').toUpperCase() !== strategy.condition) return false;
  if (strategy.language && String(row?.language || '').toUpperCase() !== strategy.language) return false;
  return true;
}

async function readProfileDoc(firestore, uid) {
  const snap = await firestore.collection('users').doc(uid).get();
  const data = snap.exists ? snap.data() || {} : {};
  const strategies = Array.isArray(data.pricingStrategies) ? data.pricingStrategies : [];
  return {
    strategies: strategies.map((strategy) => sanitizeStrategy(strategy, strategy)),
    pricerSettings: sanitizeSettings(data.pricerSettings),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  try {
    const decoded = await verifyBearer(req);
    const admin = queryFirestore();
    const firestore = admin.firestore();
    const docRef = firestore.collection('users').doc(decoded.uid);

    if (req.method === 'GET') {
      const settings = await readProfileDoc(firestore, decoded.uid);
      return res.status(200).json(settings);
    }

    const body = req.body || {};

    if (req.method === 'DELETE') {
      const id = cleanText(req.query?.id, 40);
      if (!id) return res.status(400).json({ error: 'id query param required.' });
      const { strategies } = await readProfileDoc(firestore, decoded.uid);
      const next = strategies.filter((strategy) => strategy.id !== id);
      await docRef.set({ pricingStrategies: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return res.status(200).json({ strategies: next });
    }

    // POST: pricer settings, a strategy upsert, or both.
    const patch = {};
    if (body.pricerSettings !== undefined) {
      patch.pricerSettings = sanitizeSettings(body.pricerSettings);
    }
    if (body.strategy !== undefined) {
      const { strategies } = await readProfileDoc(firestore, decoded.uid);
      const existing = body.strategy.id
        ? strategies.find((strategy) => strategy.id === body.strategy.id)
        : null;
      const sanitized = sanitizeStrategy(body.strategy, existing);
      const next = existing
        ? strategies.map((strategy) => (strategy.id === sanitized.id ? sanitized : strategy))
        : [...strategies, sanitized];
      patch.pricingStrategies = next;
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'strategy or pricerSettings body required.' });
    }
    patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await docRef.set(patch, { merge: true });
    const settings = await readProfileDoc(firestore, decoded.uid);
    return res.status(200).json(settings);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error('marketplace-pricing-strategies failed', error);
    return res.status(500).json({ error: error.message || 'Pricing strategies failed.' });
  }
};

module.exports.sanitizeStrategy = sanitizeStrategy;
module.exports.sanitizeSettings = sanitizeSettings;
module.exports.evaluateStrategyTarget = evaluateStrategyTarget;
module.exports.strategyMatchesRow = strategyMatchesRow;
module.exports._test = { sanitizeStrategy, sanitizeSettings, evaluateStrategyTarget, strategyMatchesRow };
