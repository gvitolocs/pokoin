'use strict';

/**
 * Pokoin News reader comments.
 * GET  /api/news-comments?articleId=art_…          public: visible comments, oldest first
 *                                                   (+ the caller's own pending/held ones when signed in)
 * POST /api/news-comments { articleId, articlePath, body }   signed-in Pokoin users
 *
 * New comments are stored as `pending`. The newsroom moderation worker
 * (Hermes, DeepSeek V4.1 Flash) publishes, holds or rejects them; nothing a
 * reader writes is shown before moderation. Stored in Firestore
 * `news_comments` (one document per comment, queried by articleId only so no
 * composite index is needed).
 */

const path = require('path');
const { limitBestEffort } = require('./_rate_limit');

const COLLECTION = 'news_comments';
const ARTICLE_ID_RE = /^art_[A-Za-z0-9_-]{4,120}$/;
const ARTICLE_PATH_RE = /^\/(?:[a-z0-9-]+\/)?news\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIN_BODY = 2;
const MAX_BODY = 1500;
const MAX_READ = 500;

function requireHelper(name) {
  try {
    return require(path.join(__dirname, '..', 'server', name));
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return require(`./${name}`);
  }
}

function cleanBody(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function authorName(profile, decoded) {
  const username = String(profile?.username || '').trim();
  if (username) return username.slice(0, 40);
  const displayName = String(profile?.displayName || decoded?.name || '').trim();
  return (displayName || 'Pokoin user').slice(0, 40);
}

function isoOf(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function publicComment(id, data) {
  return { id, authorName: data.authorName || 'Pokoin user', body: data.body || '', createdAt: isoOf(data.createdAt) };
}

/** Handler factory; tests inject firestore, verify and limit. */
function createHandler({
  firestore = () => requireHelper('_firebase').getFirebaseAdmin().firestore(),
  verify = (req) => requireHelper('_firebase').verifyBearerToken(req),
  limit = limitBestEffort,
  now = () => new Date(),
} = {}) {
  async function optionalUid(req) {
    if (!String(req.headers?.authorization || '').startsWith('Bearer ')) return null;
    try {
      return (await verify(req))?.uid || null;
    } catch {
      return null;
    }
  }

  async function list(req, res) {
    const articleId = String(req.query?.articleId || '').trim();
    if (!ARTICLE_ID_RE.test(articleId)) return res.status(400).json({ error: 'articleId is required.' });
    const uid = await optionalUid(req);
    const snapshot = await firestore().collection(COLLECTION).where('articleId', '==', articleId).limit(MAX_READ).get();
    const visible = [];
    const mine = [];
    for (const doc of snapshot.docs) {
      const data = doc.data() || {};
      if (data.status === 'visible') visible.push(publicComment(doc.id, data));
      else if (uid && data.uid === uid && (data.status === 'pending' || data.status === 'held')) {
        mine.push({ ...publicComment(doc.id, data), status: data.status });
      }
    }
    const byDate = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));
    visible.sort(byDate);
    mine.sort(byDate);
    // Signed-in responses carry private pending comments: never cache them.
    res.setHeader('Cache-Control', uid ? 'private, no-store' : 'public, max-age=30');
    return res.status(200).json({ articleId, count: visible.length, comments: visible, mine });
  }

  async function create(req, res) {
    let decoded;
    try {
      decoded = await verify(req);
    } catch {
      return res.status(401).json({ error: 'Sign in to comment.' });
    }
    const articleId = String(req.body?.articleId || '').trim();
    const articlePath = String(req.body?.articlePath || '').trim();
    const body = cleanBody(req.body?.body);
    if (!ARTICLE_ID_RE.test(articleId) || !ARTICLE_PATH_RE.test(articlePath)) {
      return res.status(400).json({ error: 'Unknown article.' });
    }
    if (body.length < MIN_BODY || body.length > MAX_BODY) {
      return res.status(400).json({ error: `Comments are ${MIN_BODY}–${MAX_BODY} characters.` });
    }
    const verdict = await limit({ scope: 'news-comments', identity: decoded.uid, limit: 5, windowSeconds: 600 });
    if (!verdict.allowed) {
      res.setHeader('Retry-After', String(verdict.retryAfterSec || 600));
      return res.status(429).json({ error: 'You are commenting too fast. Try again in a few minutes.' });
    }
    const db = firestore();
    const profileSnap = await db.collection('users').doc(decoded.uid).get().catch(() => null);
    const createdAt = now().toISOString();
    const record = {
      articleId,
      articlePath,
      uid: decoded.uid,
      authorName: authorName(profileSnap?.exists ? profileSnap.data() : null, decoded),
      body,
      status: 'pending',
      createdAt,
      moderation: null,
    };
    const ref = await db.collection(COLLECTION).add(record);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(202).json({ comment: { ...publicComment(ref.id, record), status: 'pending' } });
  }

  return async function handler(req, res) {
    try {
      if (req.method === 'GET') return await list(req, res);
      if (req.method === 'POST') return await create(req, res);
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed.' });
    } catch (error) {
      console.error('news-comments failed', error?.message || error);
      return res.status(500).json({ error: 'Comments are unavailable right now.' });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports._test = { cleanBody, authorName, ARTICLE_ID_RE, ARTICLE_PATH_RE };
