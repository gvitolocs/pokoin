import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  REFERRAL_REWARD_PKN,
  REFERRAL_CLAIM_WINDOW_DAYS,
  claimIsFinal,
  cleanReferralCode,
  forgetReferralCode,
  inviteLink,
  pendingReferralCode,
  referralCodeFromLocation,
  rememberReferralCode,
} from './referral.js';
import { nextStepLine, tierTitle } from './ambassador-program.js';

function memoryStore() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

test('web reward and window match the server', () => {
  const server = readFileSync(new URL('../../pokoin-rust/crates/accounts/src/domain/referral.rs', import.meta.url), 'utf8');
  assert.equal(Number(/pub const REWARD_PKN: i64 = (\d+);/.exec(server)[1]), REFERRAL_REWARD_PKN);
  assert.equal(Number(/pub const CLAIM_WINDOW_DAYS: i64 = (\d+);/.exec(server)[1]), REFERRAL_CLAIM_WINDOW_DAYS);
});

test('codes come from /join/<code> or ?ref=', () => {
  assert.equal(cleanReferralCode('@PeppeV'), 'peppev');
  assert.equal(cleanReferralCode('no such!'), '');
  assert.equal(referralCodeFromLocation('/join/PeppeV', ''), 'peppev');
  assert.equal(referralCodeFromLocation('/join/peppev/', ''), 'peppev');
  assert.equal(referralCodeFromLocation('/marketplace', '?ref=bob123'), 'bob123');
  assert.equal(referralCodeFromLocation('/marketplace', '?q=x'), '');
  assert.equal(inviteLink('PeppeV'), 'https://pokoin.com/join/peppev');
});

test('the code survives until claimed, and expires after 30 days', () => {
  const store = memoryStore();
  rememberReferralCode('peppev', 1000, store);
  assert.equal(pendingReferralCode(2000, store), 'peppev');
  assert.equal(pendingReferralCode(1000 + 31 * 86400e3, store), '');
  forgetReferralCode(store);
  assert.equal(pendingReferralCode(2000, store), '');
});

test('only definitive answers stop retrying the claim', () => {
  assert.equal(claimIsFinal(null), true);
  assert.equal(claimIsFinal({ status: 409 }), true);
  assert.equal(claimIsFinal({ status: 404 }), true);
  assert.equal(claimIsFinal({ status: 401 }), false);
  assert.equal(claimIsFinal({ status: 503 }), false);
  assert.equal(claimIsFinal(new Error('offline')), false);
});

test('ambassador next-step line', () => {
  assert.equal(tierTitle('senior'), 'Senior Ambassador');
  assert.equal(nextStepLine({ tier: 'collector', next: { tier: 'ambassador', missionsLeft: 1 } }), '1 more mission to become an Ambassador.');
  assert.equal(nextStepLine({ tier: 'ambassador', next: { tier: 'senior', missionsLeft: 2, referralsLeft: 0 } }), '2 more missions to Senior Ambassador.');
  assert.equal(nextStepLine({ tier: 'city', city: 'Milano', next: null }), 'You lead Milano.');
});

test('the referral cache only answers the same account, within a week', async () => {
  const { readReferralCache, writeReferralCache } = await import('./referral.js');
  const store = memoryStore();
  writeReferralCache('alice', { code: 'peppev' }, 1000, store);
  assert.deepEqual(readReferralCache('alice', 2000, store), { code: 'peppev' });
  assert.equal(readReferralCache('bob', 2000, store), null);
  assert.equal(readReferralCache('alice', 1000 + 8 * 86400e3, store), null);
  assert.equal(readReferralCache('', 2000, store), null);
});
