'use strict';

/**
 * Shared read-through cache for PUBLIC seller profile fields used to enrich
 * marketplace listing/seller reads.
 *
 * DISPLAY/READ ENRICHMENT ONLY. Never use the cached values to authorize a
 * seller, check ownership, or establish payment identity: checkout re-reads
 * users/{uid} live (create-order-checkout-session, sellersRefusingPkn), and
 * webhook/ownership paths read Firestore directly. Firestore stays the
 * source of truth; this cache only saves the per-request Firestore fan-out.
 *
 * Valkey keys (TTL-only, plus best-effort DEL on server-side profile writes):
 *   seller:{uid}:profile              -> { displayName, username, acceptsPkn }
 *   seller:slug:{sha256(name)}:uid    -> { uid, displayName }
 *
 * Display names and usernames are written by the Flutter clients directly to
 * Firestore — there is no server-side write path to hook for renames, so the
 * 6h TTL is the staleness bound for those. Server-side writes that DO touch
 * cached fields (marketplace-seller-settings POST) call
 * invalidateSellerProfile. Fail-open: with Valkey down every helper falls
 * straight through to Firestore.
 */

const crypto = require('node:crypto');

const valkey = require('./_valkey');

const PUBLIC_PROFILE_TTL_SEC = 6 * 60 * 60;

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function profileKey(uid) {
  return `seller:${cleanText(uid, 160)}:profile`;
}

/** Hash the username: names are user-controlled, so they never go raw in keys. */
function slugKey(normalizedName) {
  const hash = crypto.createHash('sha256').update(String(normalizedName || '').trim().toLowerCase()).digest('hex').slice(0, 32);
  return `seller:slug:${hash}:uid`;
}

function publicProfileFromDoc(doc) {
  const data = doc?.data?.() || {};
  return {
    displayName: cleanText(data.displayName, 120),
    username: cleanText(data.username || data.usernameLower, 120),
    acceptsPkn: data.acceptsPkn !== false,
  };
}

/** Default durable loader: one users/{uid} read per uid, missing docs skipped. */
async function defaultLoadProfiles(uids) {
  const admin = require('../server/_firebase').getFirebaseAdmin();
  const firestore = admin.firestore();
  const docs = await Promise.all(uids.map((uid) => firestore.collection('users').doc(uid).get()));
  const profiles = new Map();
  docs.forEach((doc, index) => {
    if (doc?.exists === false) return;
    profiles.set(uids[index], publicProfileFromDoc(doc));
  });
  return profiles;
}

function isValidCachedProfile(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value.displayName != null || value.username != null || typeof value.acceptsPkn === 'boolean'),
  );
}

/**
 * Read public profiles for uids through the cache.
 * @returns {Promise<Map<string, {displayName, username, acceptsPkn}>>}
 */
async function getPublicSellerProfiles(uids, { loadProfiles = defaultLoadProfiles } = {}) {
  const wanted = [...new Set(uids.map((uid) => cleanText(uid, 160)).filter(Boolean))];
  if (!wanted.length) return new Map();
  const profiles = new Map();
  const missing = [];
  await Promise.all(wanted.map(async (uid) => {
    const cached = await valkey.getJson(profileKey(uid));
    if (isValidCachedProfile(cached)) {
      profiles.set(uid, cached);
    } else {
      missing.push(uid);
    }
  }));
  if (missing.length) {
    const fresh = await loadProfiles(missing);
    await Promise.all([...fresh.entries()].map(async ([uid, profile]) => {
      profiles.set(uid, profile);
      await valkey.setJson(profileKey(uid), profile, PUBLIC_PROFILE_TTL_SEC);
    }));
  }
  return profiles;
}

/**
 * Slug lookup: cached uid+displayName for a normalized seller name, or null
 * when unknown (never negatively cached).
 */
async function readSellerUidByName(normalizedName) {
  const clean = cleanText(normalizedName, 120).toLowerCase();
  if (!clean) return null;
  const cached = await valkey.getJson(slugKey(clean));
  const uidValue = String(cached?.uid || '');
  if (cached && typeof cached === 'object' && /^[A-Za-z0-9:_-]{4,160}$/.test(uidValue)) {
    return { uid: uidValue, displayName: cleanText(cached.displayName, 120) };
  }
  return null;
}

async function rememberSellerUidByName(normalizedName, { uid, displayName = '' }) {
  const clean = cleanText(normalizedName, 120).toLowerCase();
  const cleanUid = cleanText(uid, 160);
  if (!clean || !cleanUid) return;
  await valkey.setJson(slugKey(clean), { uid: cleanUid, displayName: cleanText(displayName, 120) }, PUBLIC_PROFILE_TTL_SEC);
}

/**
 * Best-effort invalidation after a durable profile write. DELs the profile
 * key and every slug key the caller knows about (current + previous names).
 * Firestore-side client renames cannot be observed here — the TTL covers them.
 */
async function invalidateSellerProfile(uid, { usernames = [] } = {}) {
  const cleanUid = cleanText(uid, 160);
  if (!cleanUid) return;
  await valkey.del(profileKey(cleanUid));
  await Promise.all(usernames.map((name) => valkey.del(slugKey(name))));
}

module.exports = {
  PUBLIC_PROFILE_TTL_SEC,
  getPublicSellerProfiles,
  readSellerUidByName,
  rememberSellerUidByName,
  invalidateSellerProfile,
  profileKey,
  slugKey,
};
