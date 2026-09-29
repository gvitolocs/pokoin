'use strict';

/**
 * POST /api/unlock-silver — one year of Silver for SILVER_PRICE_PKN site PKN,
 * paid to the Pokoin treasury as balanced ledger entries.
 *
 * Pokoin-owned copy of the CardVault handler (the Pi release overlays it with
 * scripts/deploy-silver-api.sh). The web label reads the same price from
 * market/src/silver.js — change both together.
 */
const { getFirebaseAdmin, verifyBearerToken } = require('../server/_firebase');

function tokenHasAdminAccess(decoded) {
  const email = String(decoded?.email || '').trim().toLowerCase();
  if (email === 'vitologiuseppe17@gmail.com' || email === 'pokoinpos@gmail.com') {
    return true;
  }
  const role = String(decoded?.role || '').trim().toLowerCase();
  return decoded?.admin === true || decoded?.isAdmin === true || role === 'admin';
}

const SILVER_PRICE_PKN = 100;
const SILVER_DURATION_MS = 365 * 24 * 60 * 60 * 1000;
const POKOIN_TREASURY_USERNAME = 'pokoin';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const decoded = await verifyBearerToken(req);
    const admin = getFirebaseAdmin();
    const firestore = admin.firestore();
    const userRef = firestore.collection('users').doc(decoded.uid);
    const balanceRef = firestore.collection('balances').doc(decoded.uid);
    const treasuryUsernameRef = firestore.collection('usernames').doc(POKOIN_TREASURY_USERNAME);

    let silverUntil = null;
    let remainingPkn = 0;
    await firestore.runTransaction(async (transaction) => {
      const [userDoc, balanceDoc, treasuryUsernameDoc] = await Promise.all([
        transaction.get(userRef),
        transaction.get(balanceRef),
        transaction.get(treasuryUsernameRef),
      ]);
      const profile = userDoc.data() || {};
      const hasAdminAccess = tokenHasAdminAccess(decoded);
      const currentSilverUntil = profile.silverUntil?.toDate?.() || null;
      if (
        hasAdminAccess ||
        String(profile.role || '').trim().toLowerCase() === 'silver' ||
        (currentSilverUntil && currentSilverUntil.getTime() > Date.now())
      ) {
        silverUntil = currentSilverUntil || new Date(Date.now() + SILVER_DURATION_MS);
        remainingPkn = Number(balanceDoc.data()?.availablePkn || 0);
        return;
      }

      const available = Number(balanceDoc.data()?.availablePkn || 0);
      if (available < SILVER_PRICE_PKN) {
        throw Object.assign(new Error('Your site balance is too low for Silver.'), {
          statusCode: 400,
        });
      }
      const treasuryUid = String(treasuryUsernameDoc.data()?.uid || '').trim();
      if (!treasuryUid) {
        throw Object.assign(new Error('Pokoin treasury account is not configured.'), {
          statusCode: 500,
        });
      }
      if (treasuryUid === decoded.uid) {
        throw Object.assign(new Error('Pokoin treasury account cannot unlock Silver for itself.'), {
          statusCode: 400,
        });
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      silverUntil = new Date(Date.now() + SILVER_DURATION_MS);
      remainingPkn = available - SILVER_PRICE_PKN;
      const treasuryBalanceRef = firestore.collection('balances').doc(treasuryUid);
      transaction.set(
        balanceRef,
        {
          availablePkn: admin.firestore.FieldValue.increment(-SILVER_PRICE_PKN),
          updatedAt: now,
        },
        { merge: true },
      );
      transaction.set(
        treasuryBalanceRef,
        {
          availablePkn: admin.firestore.FieldValue.increment(SILVER_PRICE_PKN),
          updatedAt: now,
        },
        { merge: true },
      );
      transaction.set(
        userRef,
        {
          role: 'silver',
          silverUntil: admin.firestore.Timestamp.fromDate(silverUntil),
          silverUnlockedAt: now,
          updatedAt: now,
        },
        { merge: true },
      );
      const ledger = firestore.collection('ledger_entries');
      transaction.set(ledger.doc(), {
        uid: decoded.uid,
        type: 'silver_unlock_payment_sent',
        amountPkn: -SILVER_PRICE_PKN,
        counterpartyUid: treasuryUid,
        counterpartyUsername: POKOIN_TREASURY_USERNAME,
        purpose: 'silver_membership',
        silverUntil: admin.firestore.Timestamp.fromDate(silverUntil),
        createdAt: now,
      });
      transaction.set(ledger.doc(), {
        uid: treasuryUid,
        type: 'silver_unlock_payment_received',
        amountPkn: SILVER_PRICE_PKN,
        counterpartyUid: decoded.uid,
        purpose: 'silver_membership',
        silverUntil: admin.firestore.Timestamp.fromDate(silverUntil),
        createdAt: now,
      });
    });

    return res.status(200).json({
      ok: true,
      pricePkn: SILVER_PRICE_PKN,
      availablePkn: remainingPkn,
      silverUntil: silverUntil?.toISOString?.() || null,
    });
  } catch (error) {
    console.error('unlock-silver failed', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Silver unlock failed.',
    });
  }
};

module.exports.SILVER_PRICE_PKN = SILVER_PRICE_PKN;
