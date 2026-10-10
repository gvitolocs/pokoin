/**
 * Pokoin Ambassador program copy + progression, shared by /ambassadorprogram
 * and the ambassador desk on /associate. Tier rules mirror
 * pokoin-rust/crates/accounts/src/domain/ambassador.rs — the API owns the verdict.
 */
import { REFERRAL_REWARD_PKN } from './referral.js';

export const AMBASSADOR_MISSIONS_TO_UNLOCK = 3;
export const AMBASSADOR_CONTACT = 'contact@pokoin.com';

export const MISSIONS = [
  { key: 'referrals', title: 'Bring 3 collectors', text: 'Three invited collectors complete a first purchase or sale. Counts itself from Invite & Earn.', icon: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z' },
  { key: 'content', title: 'Create content', text: 'A video, post or stream about Pokoin: pulls, prices, how you sell or buy.', icon: 'M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z' },
  { key: 'bug_report', title: 'Report bugs or data errors', text: 'A wrong price, name, image or a broken flow, with enough detail to fix it.', icon: 'M20 8h-2.81a5.985 5.985 0 0 0-1.82-1.96L17 4.41 15.59 3l-2.17 2.17C12.96 5.06 12.49 5 12 5s-.96.06-1.41.17L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z' },
  { key: 'seller_onboard', title: 'Onboard a seller', text: 'Help a seller list 20+ cards on Pokoin.', icon: 'M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zm-9 4H6v-4h6v4z' },
  { key: 'community_event', title: 'Run a community event', text: 'A trade night, tournament table or league day where Pokoin is present.', icon: 'M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z' },
  { key: 'feedback', title: 'Give product feedback', text: 'A considered write-up of what should change, and why.', icon: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 12h-2v-2h2v2zm0-4h-2V6h2v4z' },
];

export const TIERS = [
  { key: 'collector', title: 'Collector', rule: 'Everyone starts here. Invite friends and earn with Invite & Earn.' },
  { key: 'ambassador', title: 'Ambassador', rule: `Complete ${AMBASSADOR_MISSIONS_TO_UNLOCK} of the 6 missions.` },
  { key: 'senior', title: 'Senior Ambassador', rule: '5 missions and 10 activated collectors.' },
  { key: 'city', title: 'City Ambassador', rule: 'Chosen by Pokoin to lead a city: events, sellers, local community.' },
];

export const PERKS = [
  { title: 'Ambassador badge', text: 'On your profile and seller shop.' },
  { title: 'Ambassador directory', text: 'Listed where collectors look for trusted people near them.' },
  { title: 'Early access', text: 'New Pokoin features before everyone else.' },
  { title: 'Direct line', text: 'A private channel with the Pokoin team.' },
  { title: 'Merch & event kits', text: 'For the events you run.' },
  { title: 'Invite & Earn still pays', text: `${REFERRAL_REWARD_PKN} PKN for you and for every collector you activate.` },
];

export const COMPARISON = [
  { label: 'For', referral: 'Everyone', ambassador: 'Active community members', distributor: 'Commercial partners' },
  { label: 'You do', referral: 'Invite collectors', ambassador: 'Complete missions', distributor: 'Bring sales and volume' },
  { label: 'You get', referral: `${REFERRAL_REWARD_PKN} PKN each side`, ambassador: 'Status, perks, early access', distributor: 'Negotiated commercial deal' },
  { label: 'How to join', referral: 'Automatic', ambassador: `${AMBASSADOR_MISSIONS_TO_UNLOCK} missions, or apply`, distributor: 'By agreement' },
];

export function tierIndex(tier) {
  const index = TIERS.findIndex((row) => row.key === tier);
  return index < 0 ? 0 : index;
}

export function tierTitle(tier) {
  return TIERS[tierIndex(tier)].title;
}

/** One line under the tier ladder: what unlocks next. */
export function nextStepLine(progress) {
  const next = progress?.next;
  if (!next) return progress?.tier === 'city' ? `You lead ${progress.city || 'your city'}.` : 'Top of the ladder.';
  if (next.tier === 'ambassador') {
    return `${next.missionsLeft} more mission${next.missionsLeft === 1 ? '' : 's'} to become an Ambassador.`;
  }
  const parts = [];
  if (next.missionsLeft) parts.push(`${next.missionsLeft} more mission${next.missionsLeft === 1 ? '' : 's'}`);
  if (next.referralsLeft) parts.push(`${next.referralsLeft} more activated collector${next.referralsLeft === 1 ? '' : 's'}`);
  return `${parts.join(' and ')} to Senior Ambassador.`;
}

export function applyMailto(username = '') {
  const subject = encodeURIComponent('Pokoin Ambassador application');
  const body = encodeURIComponent(`Hi Pokoin,\n\nI'd like to join the Ambassador program.\nPokoin username: ${username || ''}\nCity:\nWhat I do in the community:\n`);
  return `mailto:${AMBASSADOR_CONTACT}?subject=${subject}&body=${body}`;
}
