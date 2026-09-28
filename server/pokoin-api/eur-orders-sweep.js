'use strict';

/**
 * Timer job for EUR (Stripe) marketplace orders.
 *
 * The Stripe webhook is the fast path (paid / expired / payment failed). This
 * sweep is the bounded-delay path for what a webhook can miss:
 *   - pending_stripe past its 30-minute hold → expire the session, release stock
 *   - paid session whose webhook never landed → mark paid + fulfil
 *   - legacy ghost eur_* orders (no hold, abandoned) → closed as expired
 *   - paid orders whose fulfilment stopped half-way → resumed
 *
 *   node api/eur-orders-sweep.js            # apply
 *   node api/eur-orders-sweep.js --dry-run  # report only
 */

async function main(argv = process.argv.slice(2)) {
  const Stripe = require('stripe');
  const { getFirebaseAdmin } = require('../server/_firebase');
  const { sweepEurOrders } = require('./_eur_order_inventory');
  const { handleMarketplaceOrderPaid } = require('./_marketplace_order_stripe');
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured.');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, process.env.STRIPE_API_VERSION
    ? { apiVersion: process.env.STRIPE_API_VERSION }
    : {});
  const admin = getFirebaseAdmin();
  const result = await sweepEurOrders({
    admin,
    firestore: admin.firestore(),
    stripe,
    dryRun: argv.includes('--dry-run'),
    onPaid: (session) => handleMarketplaceOrderPaid({ admin, stripe, session }),
  });
  console.log('eur order sweep complete', {
    ok: result.ok,
    touched: result.results.length,
    actions: result.results.reduce((acc, row) => ({ ...acc, [row.action]: (acc[row.action] || 0) + 1 }), {}),
  });
  if (!result.ok) process.exitCode = 1;
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('eur order sweep failed', { message: error.message });
    process.exitCode = 1;
  });
}

module.exports = { main };
