'use strict';

/**
 * Stripe Connect Express onboarding for sellers.
 * POST /api/stripe-connect-onboard  { refreshUrl?, returnUrl? }
 * GET  /api/stripe-connect-onboard  → status
 */

const Stripe = require('stripe');
const path = require('path');
const { normalizeCountry } = require('./_checkout_core');
const { shipFromCountryFromRequest } = require('./_client_country');

function requireHelper(name) {
  try {
    return require(path.join(__dirname, '..', 'server', name));
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return require(`./${name}`);
  }
}

const { getFirebaseAdmin, verifyBearerToken } = requireHelper('_firebase');

function stripeClient() {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    const error = new Error('Stripe is not configured yet.');
    error.statusCode = 500;
    throw error;
  }
  const options = process.env.STRIPE_API_VERSION ? { apiVersion: process.env.STRIPE_API_VERSION } : {};
  return new Stripe(secret, options);
}

function siteUrl() {
  return String(process.env.PUBLIC_SITE_URL || 'https://pokoin.com').replace(/\/$/, '');
}

async function syncConnectStatus(firestore, uid, accountId, stripe) {
  const account = await stripe.accounts.retrieve(accountId);
  const ready = account.charges_enabled === true && account.payouts_enabled === true;
  const status = ready ? 'READY' : (account.details_submitted ? 'pending' : 'onboarding');
  await firestore.collection('users').doc(uid).set({
    stripeConnectAccountId: accountId,
    stripeConnectStatus: status,
    updatedAt: getFirebaseAdmin().firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { stripeConnectAccountId: accountId, stripeConnectStatus: status, ready };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  try {
    const decoded = await verifyBearerToken(req);
    const admin = getFirebaseAdmin();
    const firestore = admin.firestore();
    const stripe = stripeClient();
    const userRef = firestore.collection('users').doc(decoded.uid);
    const snap = await userRef.get();
    const data = snap.exists ? snap.data() || {} : {};
    let accountId = String(data.stripeConnectAccountId || '');

    if (req.method === 'GET') {
      if (!accountId) {
        return res.status(200).json({
          stripeConnectAccountId: '',
          stripeConnectStatus: 'not_started',
          ready: false,
        });
      }
      const status = await syncConnectStatus(firestore, decoded.uid, accountId, stripe);
      return res.status(200).json(status);
    }

    if (!accountId) {
      const country = normalizeCountry(data.shipFromCountry)
        || shipFromCountryFromRequest(req.headers)
        || '';
      if (!country) {
        const error = new Error('Set ship-from country on Profile before Stripe Connect.');
        error.statusCode = 400;
        throw error;
      }
      const account = await stripe.accounts.create({
        type: 'express',
        country,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: { pokoinUid: decoded.uid },
      });
      accountId = account.id;
      await userRef.set({
        stripeConnectAccountId: accountId,
        stripeConnectStatus: 'onboarding',
        shipFromCountry: normalizeCountry(data.shipFromCountry) || country,
        shipFromCountrySource: data.shipFromCountry ? (data.shipFromCountrySource || 'user') : 'ip',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    const returnUrl = String(req.body?.returnUrl || `${siteUrl()}/profile?stripe=return`);
    const refreshUrl = String(req.body?.refreshUrl || `${siteUrl()}/profile?stripe=refresh`);
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });
    return res.status(200).json({
      url: link.url,
      stripeConnectAccountId: accountId,
      stripeConnectStatus: 'onboarding',
    });
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    let message = error.message || 'Connect onboard failed.';
    if (/signed up for Connect/i.test(message)) {
      message = 'Stripe Connect is not enabled on this platform account yet. Complete Connect setup in the Stripe Dashboard (Connect → Get started), then retry.';
    }
    if (status >= 500) console.error('stripe-connect-onboard', error.message);
    return res.status(status).json({ error: message });
  }
};

module.exports.syncConnectStatus = syncConnectStatus;
