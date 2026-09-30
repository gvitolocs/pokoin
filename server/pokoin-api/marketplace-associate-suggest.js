'use strict';

/**
 * GET /api/marketplace-associate-suggest?q=<name or email prefix>
 *
 * Public Users-search supplement: matches the active associates roster by
 * display name or email prefix so partners are findable before they have
 * listings. Returns only public facts — display name, claimed username, and
 * the role badge. Never the roster emails.
 *
 * Canonical source for the Pi overlay. Deploy with
 * `scripts/deploy-associate-api.sh` from an origin/main commit (the script
 * patches both associate routes into the Pi manifest).
 */

function marketplaceQuery(...args) {
  return require('./_marketplace_db').marketplaceQuery(...args);
}

function getFirebaseAdmin(...args) {
  return require('./_firebase').getFirebaseAdmin(...args);
}

function setCorsHeaders(res) {
  return require('./_marketplace_react_card').setCorsHeaders(res);
}

const SUGGEST_MAX = 5;

function cors(res) {
  setCorsHeaders(res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

function cleanQuery(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 64);
}

function cleanUsername(value) {
  return String(value || '').trim().toLowerCase();
}

async function usernameForUid(firestore, uid) {
  if (!uid) return '';
  const doc = await firestore.collection('users').doc(uid).get();
  const data = doc.data() || {};
  return cleanUsername(data.username || data.usernameLower || '');
}

async function readAssociateSuggestions(query) {
  const q = cleanQuery(query);
  if (q.length < 2) return [];
  const result = await marketplaceQuery(
    `
      select email, role, display_name
      from public.marketplace_associates
      where active
        and (lower(coalesce(display_name, '')) like $1 || '%'
          or lower(email) like $1 || '%')
      order by display_name, email
      limit $2
    `,
    [q.replace(/[%_]/g, ''), SUGGEST_MAX],
  );
  const firestore = getFirebaseAdmin().firestore();
  const out = [];
  const seen = new Set();
  for (const row of result.rows) {
    try {
      const user = await getFirebaseAdmin().auth().getUserByEmail(cleanText0(row.email));
      const username = await usernameForUid(firestore, user.uid);
      if (!username || seen.has(username)) continue;
      seen.add(username);
      out.push({
        name: String(row.display_name || '').trim() || username,
        username,
        role: String(row.role || 'associate').trim().toLowerCase(),
      });
    } catch (error) {
      // Roster row without an account (or auth hiccup) — not suggestable yet.
      if (error?.code !== 'auth/user-not-found') {
        console.warn('associate suggest lookup failed', error.message);
      }
    }
    if (out.length >= SUGGEST_MAX) break;
  }
  return out;
}

function cleanText0(value) {
  return String(value || '').trim().toLowerCase();
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'GET only.' });
  }
  try {
    const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
    const query = String(url.searchParams.get('q') || '').slice(0, 64);
    const associates = await readAssociateSuggestions(query);
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json({ query, associates });
  } catch (error) {
    console.error('marketplace-associate-suggest failed', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Associate suggest failed.',
    });
  }
};

module.exports.readAssociateSuggestions = readAssociateSuggestions;
module.exports._test = { cleanQuery, cleanUsername };
