'use strict';

/**
 * Pokoin Invite & Earn + Ambassador progress.
 *
 *   GET  /api/marketplace-referral              your invite code, invited
 *                                               collectors, rewards, ambassador tier
 *   POST /api/marketplace-referral {action: 'claim', code}
 *                                               attach this new account to an inviter
 *
 * Both need a Firebase bearer. Rewards (20 PKN each side) are paid by
 * _referral_core.settleReferral — on every GET for the caller's own
 * referrals, and every 10 minutes for everyone by referral-reconcile.js
 * (pokoin-referral-reconcile.timer on the Pi).
 *
 * Canonical source for the Pi overlay; deploy with scripts/deploy-referral-api.sh.
 * Sibling requires (_firebase, _marketplace_db, _marketplace_react_card) come
 * from the live Pi release.
 */

const { marketplaceQuery } = require('./_marketplace_db');
const { authErrorResponse, getFirebaseAdmin, verifyBearerToken } = require('./_firebase');
const { setCorsHeaders } = require('./_marketplace_react_card');
const core = require('./_referral_core');
const { ambassadorProgress } = require('./_ambassador_core');

function cors(res) {
  setCorsHeaders(res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Cache-Control', 'private, no-store');
}

async function rosterAndContributions(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return { roster: null, contributions: [] };
  try {
    const [roster, contributions] = await Promise.all([
      marketplaceQuery(
        `select role, display_name, city, active from public.marketplace_associates where lower(email) = $1 limit 1`,
        [clean],
      ),
      marketplaceQuery(
        `select mission, note, link, verified_at from public.marketplace_ambassador_contributions
          where lower(email) = $1 order by verified_at desc limit 100`,
        [clean],
      ),
    ]);
    return { roster: roster.rows[0] || null, contributions: contributions.rows || [] };
  } catch (error) {
    // Missing tables (before 093) must not break Invite & Earn.
    if (error.code !== '42P01' && error.code !== '42703') console.error('referral ambassador lookup failed', error.message);
    return { roster: null, contributions: [] };
  }
}

async function payload(firestore, FieldValue, decoded) {
  const uid = decoded.uid;
  // Pay anything the caller is owed before showing it.
  await core.settleReferral({ firestore, FieldValue, referredUid: uid }).catch((error) => {
    console.error('referral settle (self) failed', error.message);
  });
  await core.settlePending({ firestore, FieldValue, onlyReferrerUid: uid, limit: 50 }).catch((error) => {
    console.error('referral settle (invited) failed', error.message);
  });
  const [summary, { roster, contributions }] = await Promise.all([
    core.referralSummary({ firestore, uid }),
    rosterAndContributions(decoded.email),
  ]);
  return {
    ok: true,
    ...summary,
    ambassador: {
      ...ambassadorProgress({ activatedReferrals: summary.stats.activated, contributions, roster }),
      contributions: contributions.slice(0, 20).map((row) => ({
        mission: row.mission,
        note: row.note || '',
        link: row.link || '',
        verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
      })),
    },
  };
}

async function accountCreatedMs(admin, uid) {
  const user = await admin.auth().getUser(uid);
  const created = Date.parse(user?.metadata?.creationTime || '');
  return Number.isNaN(created) ? 0 : created;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  let decoded;
  try {
    decoded = await verifyBearerToken(req);
  } catch (error) {
    const out = authErrorResponse ? authErrorResponse(error) : { statusCode: 401, body: { error: 'Sign in first.' } };
    return res.status(out.statusCode || 401).json(out.body || { error: 'Sign in first.' });
  }
  try {
    const admin = getFirebaseAdmin();
    const firestore = admin.firestore();
    const { FieldValue } = admin.firestore;
    if (req.method === 'POST') {
      const action = String(req.body?.action || '').trim();
      if (action !== 'claim') return res.status(400).json({ error: 'Unknown action.' });
      const claim = await core.claimReferral({
        firestore,
        FieldValue,
        uid: decoded.uid,
        code: req.body?.code,
        accountCreatedMs: await accountCreatedMs(admin, decoded.uid),
      });
      return res.status(200).json({ ...(await payload(firestore, FieldValue, decoded)), claim: claim.status });
    }
    return res.status(200).json(await payload(firestore, FieldValue, decoded));
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    if (status >= 500) console.error('marketplace-referral failed', error.message);
    return res.status(status).json({ error: error.message || 'Invite & Earn failed.', code: error.code || '' });
  }
};

module.exports._test = { payload, rosterAndContributions };
