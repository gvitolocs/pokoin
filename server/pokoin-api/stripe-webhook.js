const Stripe = require('stripe');
const path = require('path');

function requireServerHelper(name) {
  const serverPath = path.join(__dirname, '..', 'server', name);
  try {
    return require(serverPath);
  } catch (error) {
    if (
      error.code !== 'MODULE_NOT_FOUND' ||
      !String(error.message).includes(serverPath)
    ) {
      throw error;
    }
    return require(`./${name}`);
  }
}

const { getFirebaseAdmin } = requireServerHelper('_firebase');
const { handleCompletedCheckout } = requireServerHelper('_pkn_purchase');
const {
  handleMarketplaceOrderPaid,
  handleMarketplaceOrderUnpaid,
  isEurSession,
} = requireServerHelper('_marketplace_order_stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method not allowed');
  }

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecret || !webhookSecret) {
    return res.status(500).send('Stripe webhook is not configured.');
  }

  const stripeOptions = process.env.STRIPE_API_VERSION
    ? { apiVersion: process.env.STRIPE_API_VERSION }
    : {};
  const stripe = new Stripe(stripeSecret, stripeOptions);

  let event;
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks);
    event = stripe.webhooks.constructEvent(
      rawBody,
      req.headers['stripe-signature'],
      webhookSecret,
    );
  } catch (error) {
    console.error('Stripe webhook signature failed', error);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  try {
    const session = event.data.object;
    if (event.type === 'checkout.session.completed') {
      if (isEurSession(session)) {
        await handleMarketplaceOrderPaid({
          admin: getFirebaseAdmin(),
          stripe,
          session,
        });
      } else {
        await handleCompletedCheckout({
          admin: getFirebaseAdmin(),
          session,
        });
      }
    } else if (event.type === 'checkout.session.async_payment_succeeded' && isEurSession(session)) {
      await handleMarketplaceOrderPaid({ admin: getFirebaseAdmin(), stripe, session });
    } else if (event.type === 'checkout.session.async_payment_failed' && isEurSession(session)) {
      await handleMarketplaceOrderUnpaid({ admin: getFirebaseAdmin(), session, reason: 'payment_failed' });
    } else if (event.type === 'checkout.session.expired' && isEurSession(session)) {
      // Buyer never paid inside the 30-minute hold: give the cards back.
      await handleMarketplaceOrderUnpaid({ admin: getFirebaseAdmin(), session, reason: 'expired' });
    }
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Stripe webhook handling failed', error);
    return res.status(500).send('Webhook handling failed.');
  }
};

