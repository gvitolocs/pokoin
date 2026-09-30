'use strict';

/**
 * Invite & Earn safety net: pays every pending referral whose invited
 * collector has made a first purchase or sale since the claim.
 *
 * GET /api/marketplace-referral already settles the caller's own referrals;
 * this runs for everyone every 10 minutes from pokoin-referral-reconcile.timer
 * on the Pi (`docker exec pokoin-oracle-api node /app/api/referral-reconcile.js`).
 * --dry-run reports what is pending without moving PKN.
 */

async function main(argv = process.argv.slice(2)) {
  const { getFirebaseAdmin } = require('../server/_firebase');
  const core = require('./_referral_core');
  const admin = getFirebaseAdmin();
  const firestore = admin.firestore();
  if (argv.includes('--dry-run')) {
    const snap = await firestore.collection('referrals').where('status', '==', 'pending').get();
    console.log('referral reconcile dry run', { pending: snap.docs.length });
    return { pending: snap.docs.length };
  }
  const counts = await core.settlePending({ firestore, FieldValue: admin.firestore.FieldValue });
  console.log('referral reconcile complete', counts);
  if (counts.failed) process.exitCode = 1;
  return counts;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('referral reconcile failed', { message: error.message });
    process.exitCode = 1;
  });
}

module.exports = { main };
