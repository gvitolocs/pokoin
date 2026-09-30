'use strict';

/**
 * Pokoin Ambassador program: missions and progression.
 *
 * Referrals reward who you bring; Ambassadors are recognised for what they
 * contribute. "Bring 3 collectors" counts itself from rewarded referrals;
 * every other mission is verified by the Pokoin team and stored in
 * public.marketplace_ambassador_contributions (scripts/sql/096_ambassador_program.sql).
 *
 * Tiers: Collector → Ambassador (3 missions, or named on the roster) →
 * Senior Ambassador (5 missions and 10 activated referrals) → City
 * Ambassador (an ambassador the roster assigns to a city).
 *
 * Roster role `founder_ambassador` is an ambassador with the one-off Founder
 * title (Pokoin's first ambassador); it progresses like any ambassador.
 */

const MISSION_KEYS = ['referrals', 'content', 'bug_report', 'seller_onboard', 'community_event', 'feedback'];
const REFERRAL_MISSION_TARGET = 3;
const AMBASSADOR_MISSIONS = 3;
const SENIOR_MISSIONS = 5;
const SENIOR_REFERRALS = 10;
const AMBASSADOR_ROLES = new Set(['ambassador', 'founder_ambassador']);

/**
 * { tier, completed: [keys], progress: { referrals, missions }, next }
 * from rewarded referral count, verified contribution rows and the roster row.
 */
function ambassadorProgress({ activatedReferrals = 0, contributions = [], roster = null } = {}) {
  const verified = new Set(
    (contributions || [])
      .map((row) => String(row.mission || '').trim())
      .filter((key) => MISSION_KEYS.includes(key) && key !== 'referrals'),
  );
  if (activatedReferrals >= REFERRAL_MISSION_TARGET) verified.add('referrals');
  const completed = MISSION_KEYS.filter((key) => verified.has(key));
  const role = String(roster?.role || '').trim().toLowerCase();
  const onRoster = Boolean(roster) && roster.active !== false && AMBASSADOR_ROLES.has(role);
  const city = onRoster ? String(roster.city || '').trim() : '';

  let tier = 'collector';
  if (onRoster || completed.length >= AMBASSADOR_MISSIONS) tier = 'ambassador';
  if (tier === 'ambassador' && completed.length >= SENIOR_MISSIONS && activatedReferrals >= SENIOR_REFERRALS) tier = 'senior';
  if (tier !== 'collector' && city) tier = 'city';

  let next = null;
  if (tier === 'collector') {
    next = { tier: 'ambassador', missionsLeft: AMBASSADOR_MISSIONS - completed.length };
  } else if (tier === 'ambassador') {
    next = {
      tier: 'senior',
      missionsLeft: Math.max(0, SENIOR_MISSIONS - completed.length),
      referralsLeft: Math.max(0, SENIOR_REFERRALS - activatedReferrals),
    };
  }
  return {
    tier,
    city,
    completed,
    activatedReferrals,
    referralTarget: REFERRAL_MISSION_TARGET,
    onRoster,
    founder: onRoster && role === 'founder_ambassador',
    next,
  };
}

module.exports = {
  MISSION_KEYS,
  REFERRAL_MISSION_TARGET,
  AMBASSADOR_MISSIONS,
  SENIOR_MISSIONS,
  SENIOR_REFERRALS,
  AMBASSADOR_ROLES,
  ambassadorProgress,
};
