'use strict';

/**
 * Sellers can opt out of being paid in PKN (Profile → Seller setup →
 * "Get paid in PKN"). users/{uid}.acceptsPkn === false means buyers pay that
 * seller by card (Stripe, EUR) only: the PKN checkout refuses carts with
 * their listings, and their own listing forms default to local currency.
 * Missing field = accepts PKN (the default).
 */

function acceptsPknFrom(data) {
  return !data || data.acceptsPkn !== false;
}

function cleanUids(uids) {
  return [...new Set((uids || []).map((uid) => String(uid || '').trim()).filter(Boolean))].slice(0, 50);
}

/** [{ uid, name }] for the sellers among `uids` who do not take PKN. */
async function sellersRefusingPkn(firestore, uids) {
  const list = cleanUids(uids);
  const docs = await Promise.all(list.map((uid) => firestore.collection('users').doc(uid).get()));
  return docs
    .map((doc, index) => ({ uid: list[index], data: doc.exists ? doc.data() || {} : null }))
    .filter((row) => row.data && !acceptsPknFrom(row.data))
    .map((row) => ({
      uid: row.uid,
      name: String(row.data.username || row.data.displayName || 'This seller').trim(),
    }));
}

async function assertSellersAcceptPkn(firestore, uids) {
  const refusing = await sellersRefusingPkn(firestore, uids);
  if (!refusing.length) return;
  const names = refusing.map((row) => row.name).join(', ');
  const error = new Error(`${names} ${refusing.length === 1 ? 'accepts' : 'accept'} card payments only. Pay by card (Stripe) for ${refusing.length === 1 ? 'this seller' : 'these sellers'}.`);
  error.statusCode = 409;
  error.code = 'seller_no_pkn';
  error.sellers = refusing;
  throw error;
}

module.exports = { acceptsPknFrom, sellersRefusingPkn, assertSellersAcceptPkn };
