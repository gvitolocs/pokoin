'use strict';

/**
 * POST /api/news-event — Pokoin News first-party reading beacons.
 * Body { events: [{ type, articleId, articlePath, pv, source?, position?, depth?, seconds? }] }
 *
 *   impression  a list card was ≥50% on screen (source = list path, position = 1-based)
 *   click       a list card link was opened (same fields)
 *   view        an article page loaded (source = referrer host)
 *   read        the reader scrolled past 25/50/75/100% of the article
 *   leave       active seconds on the article and max depth when the tab hides
 *
 * Rows land in Postgres `news_events` (scripts/sql/111_news_events.sql) on the
 * writer. No cookies: `visitor` is a daily salted hash of ip + user agent, so
 * readers are countable per day and never identifiable. Answers 204 before
 * writing, like marketplace-event, so a beacon never holds an API slot.
 * Read by the admin-only GET /api/news-stats (/news/dashboard).
 */

const crypto = require('crypto');
const path = require('path');
const { limitBestEffort } = require('./_rate_limit');

const TYPES = new Set(['impression', 'click', 'view', 'read', 'leave']);
const ARTICLE_ID_RE = /^art_[A-Za-z0-9_-]{4,120}$/;
const ARTICLE_PATH_RE = /^\/(?:[a-z0-9-]+\/)?news\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PV_RE = /^[A-Za-z0-9]{8,32}$/;
const MILESTONES = new Set([25, 50, 75, 100]);
const BOT_RE = /bot|crawl|spider|slurp|preview|headless|lighthouse|facebookexternalhit/i;
const MAX_EVENTS = 40;
const MAX_SECONDS = 7200;
const COLUMNS = ['event_type', 'article_id', 'article_path', 'pv', 'visitor', 'source', 'position', 'depth', 'seconds'];

function requireHelper(name) {
  try {
    return require(path.join(__dirname, '..', 'server', name));
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return require(`./${name}`);
  }
}

function intOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function cleanEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = String(raw.type || '').trim();
  const articleId = String(raw.articleId || '').trim();
  const articlePath = String(raw.articlePath || '').trim();
  const pv = String(raw.pv || '').trim();
  if (!TYPES.has(type) || !ARTICLE_ID_RE.test(articleId) || !ARTICLE_PATH_RE.test(articlePath) || !PV_RE.test(pv)) {
    return null;
  }
  const source = typeof raw.source === 'string' ? raw.source.trim().slice(0, 120) || null : null;
  let position = null;
  let depth = null;
  let seconds = null;
  if (type === 'impression' || type === 'click') {
    const value = intOrNull(raw.position);
    position = value != null && value >= 1 && value <= 200 ? value : null;
  }
  if (type === 'read') {
    depth = intOrNull(raw.depth);
    if (!MILESTONES.has(depth)) return null;
  }
  if (type === 'leave') {
    seconds = intOrNull(raw.seconds);
    if (seconds == null) return null;
    seconds = Math.max(0, Math.min(MAX_SECONDS, seconds));
    const value = intOrNull(raw.depth);
    depth = value == null ? null : Math.max(0, Math.min(100, value));
  }
  return { type, articleId, articlePath, pv, source, position, depth, seconds };
}

function cleanEvents(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_EVENTS).map(cleanEvent).filter(Boolean);
}

function clientIp(req) {
  const headers = req.headers || {};
  const cf = String(headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  const forwarded = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (forwarded) return forwarded;
  return String(req.socket?.remoteAddress || '');
}

/** Daily salted hash: stable for one reader within a UTC day, unlinkable across days. */
function visitorHash({ ip, ua, day, salt = process.env.NEWS_EVENT_SALT || 'pokoin-news' }) {
  return crypto.createHash('sha256').update(`${day}|${ip}|${ua}|${salt}`).digest('hex').slice(0, 24);
}

function parseBody(body) {
  if (typeof body === 'string') return JSON.parse(body);
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8'));
  return body || {};
}

// One warning per minute at most: a writer outage must not flood the Pi log.
let lastFailureLog = 0;
let failuresSinceLog = 0;

function logFailure(error) {
  failuresSinceLog += 1;
  const now = Date.now();
  if (now - lastFailureLog < 60_000) return;
  console.warn('news-event failed', { message: error?.message, code: error?.code, failures: failuresSinceLog });
  lastFailureLog = now;
  failuresSinceLog = 0;
}

/** Handler factory; tests inject writeQuery, limit and now. */
function createHandler({
  writeQuery = (...args) => requireHelper('_marketplace_db').marketplaceWriteQuery(...args),
  limit = limitBestEffort,
  now = () => new Date(),
} = {}) {
  async function insert(events, visitor) {
    const params = [];
    const rows = events.map((event) => {
      const values = [event.type, event.articleId, event.articlePath, event.pv, visitor, event.source, event.position, event.depth, event.seconds];
      const placeholders = values.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await writeQuery(`insert into public.news_events (${COLUMNS.join(', ')}) values ${rows.join(', ')}`, params);
  }

  return async function handler(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    let body;
    try {
      body = parseBody(req.body);
    } catch {
      return res.status(400).json({ error: 'Invalid news event.' });
    }
    const events = cleanEvents(body?.events);
    if (!events.length) return res.status(400).json({ error: 'Invalid news event.' });

    const ua = String(req.headers?.['user-agent'] || '');
    if (BOT_RE.test(ua)) return res.status(204).end();
    const visitor = visitorHash({ ip: clientIp(req), ua, day: now().toISOString().slice(0, 10) });

    res.status(204).end();
    try {
      const verdict = await limit({ scope: 'news-event', identity: visitor, limit: 120, windowSeconds: 600 });
      if (!verdict?.allowed) return undefined;
      await insert(events, visitor);
    } catch (error) {
      logFailure(error);
    }
    return undefined;
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports._test = { cleanEvents, visitorHash, clientIp, MAX_EVENTS };
