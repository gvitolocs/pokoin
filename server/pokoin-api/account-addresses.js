'use strict';

/**
 * Encrypted saved shipping addresses.
 * GET/POST /api/account-addresses
 * PUT/DELETE /api/account-addresses?id=
 */

const path = require('path');
const { encryptAddressPayload, decryptAddressPayload } = require('./_address_crypto');
const { validateAddressFields, normalizeCountry } = require('./_checkout_core');

function requireHelper(name) {
  try {
    return require(path.join(__dirname, '..', 'server', name));
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return require(`./${name}`);
  }
}

const { getFirebaseAdmin, verifyBearerToken } = requireHelper('_firebase');

function addressesCol(firestore, uid) {
  return firestore.collection('users').doc(uid).collection('shipping_addresses');
}

function publicAddress(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    countryCode: normalizeCountry(data.countryCode) || '',
    isDefault: data.isDefault === true,
    label: String(data.label || '').slice(0, 80),
    createdAt: data.createdAt?.toDate?.()?.toISOString?.() || null,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() || null,
  };
}

async function decryptForOwner(doc) {
  const data = doc.data() || {};
  const plain = decryptAddressPayload(data.encryptedPayload);
  return {
    ...publicAddress(doc),
    fullName: plain.fullName || '',
    companyName: plain.companyName || '',
    addressLine1: plain.addressLine1 || '',
    addressLine2: plain.addressLine2 || '',
    postalCode: plain.postalCode || '',
    city: plain.city || '',
    stateProvinceRegion: plain.stateProvinceRegion || '',
    phoneNumber: plain.phoneNumber || '',
    deliveryInstructions: plain.deliveryInstructions || '',
  };
}

module.exports = async function handler(req, res) {
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const decoded = await verifyBearerToken(req);
    const admin = getFirebaseAdmin();
    const firestore = admin.firestore();
    const col = addressesCol(firestore, decoded.uid);
    const now = admin.firestore.FieldValue.serverTimestamp();

    if (req.method === 'GET') {
      const snap = await col.orderBy('createdAt', 'desc').limit(20).get();
      const reveal = String(req.query?.reveal || '') === '1';
      const addresses = [];
      for (const doc of snap.docs) {
        addresses.push(reveal ? await decryptForOwner(doc) : publicAddress(doc));
      }
      return res.status(200).json({ addresses });
    }

    if (req.method === 'POST') {
      const fields = validateAddressFields(req.body || {});
      const encryptedPayload = encryptAddressPayload({
        fullName: fields.fullName,
        companyName: fields.companyName,
        addressLine1: fields.addressLine1,
        addressLine2: fields.addressLine2,
        postalCode: fields.postalCode,
        city: fields.city,
        stateProvinceRegion: fields.stateProvinceRegion,
        phoneNumber: fields.phoneNumber,
        deliveryInstructions: fields.deliveryInstructions,
      });
      const isDefault = req.body?.isDefault === true;
      if (isDefault) {
        const existing = await col.where('isDefault', '==', true).get();
        const batch = firestore.batch();
        existing.docs.forEach((doc) => batch.update(doc.ref, { isDefault: false }));
        await batch.commit();
      }
      const ref = col.doc();
      await ref.set({
        countryCode: fields.countryCode,
        isDefault: isDefault || false,
        label: String(req.body?.label || fields.city || '').slice(0, 80),
        encryptedPayload,
        createdAt: now,
        updatedAt: now,
      });
      const saved = await ref.get();
      return res.status(201).json({ address: await decryptForOwner(saved) });
    }

    const id = String(req.query?.id || req.body?.id || '').trim();
    if (!id) {
      return res.status(400).json({ error: 'Address id required.' });
    }
    const ref = col.doc(id);
    const existing = await ref.get();
    if (!existing.exists) {
      return res.status(404).json({ error: 'Address not found.' });
    }

    if (req.method === 'DELETE') {
      await ref.delete();
      return res.status(200).json({ ok: true, id });
    }

    const fields = validateAddressFields(req.body || {});
    const encryptedPayload = encryptAddressPayload({
      fullName: fields.fullName,
      companyName: fields.companyName,
      addressLine1: fields.addressLine1,
      addressLine2: fields.addressLine2,
      postalCode: fields.postalCode,
      city: fields.city,
      stateProvinceRegion: fields.stateProvinceRegion,
      phoneNumber: fields.phoneNumber,
      deliveryInstructions: fields.deliveryInstructions,
    });
    const patch = {
      countryCode: fields.countryCode,
      encryptedPayload,
      label: String(req.body?.label || fields.city || '').slice(0, 80),
      updatedAt: now,
    };
    if (req.body?.isDefault === true) {
      patch.isDefault = true;
      const others = await col.where('isDefault', '==', true).get();
      const batch = firestore.batch();
      others.docs.forEach((doc) => {
        if (doc.id !== id) batch.update(doc.ref, { isDefault: false });
      });
      batch.update(ref, patch);
      await batch.commit();
    } else {
      await ref.update(patch);
    }
    const saved = await ref.get();
    return res.status(200).json({ address: await decryptForOwner(saved) });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('account-addresses', error.code || error.message);
    return res.status(status).json({ error: error.message || 'Address request failed.', code: error.code });
  }
};

module.exports._test = { publicAddress, validateAddressFields };
