/**
 * Invite & Earn (everyone): share pokoin.com/join/<username>; when the invited
 * collector registers and completes a first purchase or first sale, both sides
 * get REFERRAL_REWARD_PKN. The server (server/pokoin-api/_referral_core.js)
 * owns the rules and pays from the Pokoin treasury; this module only carries
 * the invite code from the link to the signed-in claim.
 */

export const REFERRAL_REWARD_PKN = 20;
export const REFERRAL_CLAIM_WINDOW_DAYS = 14;
export const REFERRAL_STORAGE_KEY = 'pokoin.referral.code';
const STORE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Invite codes are Pokoin usernames: a–z / 0–9, 3–32 chars, optional @. */
export function cleanReferralCode(value) {
  const code = String(value || '').trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9]{3,32}$/.test(code) ? code : '';
}

/** Code from ?ref=… or /join/<code>, else ''. */
export function referralCodeFromLocation(pathname = '', search = '') {
  const join = /^\/join\/([^/?#]+)\/?$/.exec(String(pathname || ''));
  if (join) return cleanReferralCode(decodeURIComponent(join[1]));
  try {
    return cleanReferralCode(new URLSearchParams(search || '').get('ref'));
  } catch (_) {
    return '';
  }
}

export function inviteLink(username, origin = 'https://pokoin.com') {
  const code = cleanReferralCode(username);
  return code ? `${origin}/join/${code}` : '';
}

function storage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch (_) {
    return null;
  }
}

export function rememberReferralCode(code, nowMs = Date.now(), store = storage()) {
  const clean = cleanReferralCode(code);
  if (!clean || !store) return;
  try {
    store.setItem(REFERRAL_STORAGE_KEY, JSON.stringify({ code: clean, at: nowMs }));
  } catch (_) {
    // Private mode: the claim simply does not happen on this browser.
  }
}

export function pendingReferralCode(nowMs = Date.now(), store = storage()) {
  if (!store) return '';
  try {
    const row = JSON.parse(store.getItem(REFERRAL_STORAGE_KEY) || 'null');
    if (!row || nowMs - Number(row.at || 0) > STORE_TTL_MS) return '';
    return cleanReferralCode(row.code);
  } catch (_) {
    return '';
  }
}

export function forgetReferralCode(store = storage()) {
  try {
    store?.removeItem(REFERRAL_STORAGE_KEY);
  } catch (_) {
    // ignore
  }
}

/** Claim outcomes that end the attempt (anything else retries next visit). */
export function claimIsFinal(error) {
  if (!error) return true;
  const status = Number(error.status || 0);
  return status >= 400 && status < 500 && status !== 401 && status !== 429;
}

export const INVITE_STATUS_LABEL = {
  pending: 'Joined · waiting for a first purchase or sale',
  rewarded: 'Activated',
};
