'use strict';

// Shared Firestore ownership for Pokoin collection (physical + helpers for
// scan submit and paid-sale decrement). Docs are deterministic for scan items:
// `scan:{scan_item_id}` — set/merge with absolute quantity, never increment.

const COLLECTION = 'user_card_collections';
const SOURCE_SCAN = 'pokoin_scan_batch';

function scanOwnershipDocId(scanItemId) {
  const id = String(scanItemId || '').trim();
  if (!id) throw new Error('scan ownership requires a scan item id');
  return id.startsWith('scan:') ? id : `scan:${id}`;
}

function foilFlags(foilState, reverse) {
  const foil = String(foilState || 'standard').toLowerCase();
  return {
    holo: foil === 'holo',
    reverse: foil === 'reverse' || reverse === true,
  };
}

function physicalPayloadFromScanRow({
  uid,
  row,
  batchId,
  listingId = null,
  admin,
  existing = false,
}) {
  const foil = foilFlags(row.foil_state, row.reverse);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const docId = scanOwnershipDocId(row.id);
  const data = {
    uid,
    cardId: String(row.card_id || ''),
    blueprintId: String(row.card_id || ''),
    quantity: Math.max(1, Number(row.quantity) || 1),
    condition: row.condition || 'NM',
    language: row.language || 'EN',
    firstEdition: row.first_edition === true,
    holo: foil.holo,
    reverse: foil.reverse,
    graded: row.graded === true,
    gradingCompany: row.grading_company || null,
    grade: row.grade || null,
    certificationId: row.certification_id || null,
    cardName: row.card_name || String(row.card_id || ''),
    cardImageUrl: row.image_url || '',
    setName: row.set_name || 'Pokemon',
    collectorNumber: row.collector_number || '',
    ownershipType: 'physical',
    nftStatus: '',
    fulfillmentMode: 'physical',
    physicalShippingStatus: '',
    physicalShippingRequestId: '',
    source: SOURCE_SCAN,
    sourceOrderId: '',
    sourceListingId: docId,
    sourceScanBatchId: batchId,
    sourceScanItemId: String(row.id),
    listingId: listingId || null,
    updatedAt: now,
  };
  if (!existing) data.createdAt = now;
  return { docId, data };
}

async function upsertScanOwnership({
  firestore,
  admin,
  uid,
  row,
  batchId,
  listingId = null,
}) {
  if (!firestore || !admin) throw new Error('Firestore admin required for ownership write');
  if (!uid || !row?.id) throw new Error('Ownership write requires uid and scan row');

  const docId = scanOwnershipDocId(row.id);
  const ref = firestore.collection(COLLECTION).doc(docId);
  const itemId = String(row.id);
  const now = admin.firestore.FieldValue.serverTimestamp();

  // Prefer a transaction so concurrent retries cannot race-create conflicting state.
  if (typeof firestore.runTransaction === 'function') {
    return firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        const { data } = physicalPayloadFromScanRow({
          uid,
          row,
          batchId,
          listingId,
          admin,
          existing: false,
        });
        tx.set(ref, data);
        return {
          docId,
          listingId: listingId || null,
          quantity: data.quantity,
          created: true,
          already: false,
        };
      }

      const existing = snap.data() || {};
      const existingItem = String(existing.sourceScanItemId || '').trim();
      const existingBatch = String(existing.sourceScanBatchId || '').trim();
      const existingSourceListing = String(existing.sourceListingId || '').trim();
      const sameScanItem = !existingItem || existingItem === itemId
        || existingSourceListing === docId
        || ref.id === docId;

      if (!sameScanItem) {
        const err = new Error(
          `Ownership doc ${docId} has conflicting provenance (item ${existingItem || 'unknown'}).`,
        );
        err.code = 'ownership_provenance_conflict';
        throw err;
      }
      if (existingBatch && existingBatch !== String(batchId) && existingItem && existingItem !== itemId) {
        const err = new Error(
          `Ownership doc ${docId} belongs to another scan batch.`,
        );
        err.code = 'ownership_provenance_conflict';
        throw err;
      }

      // Already established for this scan item: do NOT rewrite quantity
      // (sales / corrections may have changed it).
      const patch = { updatedAt: now };
      let touched = false;
      if (listingId && !existing.listingId) {
        patch.listingId = listingId;
        touched = true;
      }
      if (!existing.sourceScanBatchId) {
        patch.sourceScanBatchId = batchId;
        touched = true;
      }
      if (!existing.sourceScanItemId) {
        patch.sourceScanItemId = itemId;
        touched = true;
      }
      if (touched) tx.set(ref, patch, { merge: true });
      return {
        docId,
        listingId: listingId || existing.listingId || null,
        quantity: Number(existing.quantity) || 0,
        created: false,
        already: true,
      };
    });
  }

  // Fallback without transactions (tests / limited stubs).
  const snap = await ref.get();
  if (!snap.exists) {
    const { data } = physicalPayloadFromScanRow({
      uid,
      row,
      batchId,
      listingId,
      admin,
      existing: false,
    });
    await ref.set(data);
    return {
      docId,
      listingId: listingId || null,
      quantity: data.quantity,
      created: true,
      already: false,
    };
  }
  const existing = snap.data() || {};
  const existingItem = String(existing.sourceScanItemId || '').trim();
  if (existingItem && existingItem !== itemId && String(existing.sourceListingId || '') !== docId) {
    const err = new Error(`Ownership doc ${docId} has conflicting provenance.`);
    err.code = 'ownership_provenance_conflict';
    throw err;
  }
  const patch = { updatedAt: now };
  if (listingId && !existing.listingId) patch.listingId = listingId;
  if (!existing.sourceScanBatchId) patch.sourceScanBatchId = batchId;
  if (!existing.sourceScanItemId) patch.sourceScanItemId = itemId;
  await ref.set(patch, { merge: true });
  return {
    docId,
    listingId: listingId || existing.listingId || null,
    quantity: Number(existing.quantity) || 0,
    created: false,
    already: true,
  };
}

/**
 * Decrement seller physical ownership after a paid physical sale.
 * Prefers `sourceListingId` of form `scan:{itemId}`, else `listingId` field.
 * NFT docs are never touched. Missing link → skip (legacy listings).
 */
async function decrementSellerOwnershipForSale({
  firestore,
  admin,
  sellerUid,
  listingId,
  quantity,
  sourceListingId = '',
}) {
  const sold = Number(quantity) || 0;
  if (!firestore || !sellerUid || sold < 1) {
    return { ok: true, skipped: true, reason: 'noop' };
  }

  let ref = null;
  let data = null;

  const source = String(sourceListingId || '').trim();
  if (source.startsWith('scan:')) {
    const snap = await firestore.collection(COLLECTION).doc(source).get();
    const row = snap.data() || {};
    if (
      snap.exists &&
      row.uid === sellerUid &&
      row.ownershipType !== 'nft' &&
      row.fulfillmentMode !== 'nft_only' &&
      row.nftStatus !== 'owned'
    ) {
      ref = snap.ref;
      data = row;
    }
  }

  if (!ref && listingId) {
    const query = await firestore
      .collection(COLLECTION)
      .where('uid', '==', sellerUid)
      .where('listingId', '==', String(listingId))
      .limit(8)
      .get();
    for (const doc of query.docs) {
      const row = doc.data() || {};
      if (
        row.ownershipType === 'nft' ||
        row.fulfillmentMode === 'nft_only' ||
        row.nftStatus === 'owned'
      ) {
        continue;
      }
      ref = doc.ref;
      data = row;
      break;
    }
  }

  if (!ref) {
    return { ok: true, skipped: true, reason: 'no_linked_ownership' };
  }

  const current = Number(data.quantity) || 0;
  const next = current - sold;
  if (next <= 0) {
    await ref.delete();
    return { ok: true, deleted: true, docId: ref.id, before: current, after: 0 };
  }
  await ref.set({
    quantity: next,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true, deleted: false, docId: ref.id, before: current, after: next };
}

/** Apply the same decrement rules inside an existing Firestore transaction. */
async function decrementSellerOwnershipInTransaction({
  transaction,
  firestore,
  admin,
  sellerUid,
  listingId,
  quantity,
  sourceListingId = '',
}) {
  const sold = Number(quantity) || 0;
  if (!sellerUid || sold < 1) return { ok: true, skipped: true, reason: 'noop' };

  let ref = null;
  let data = null;
  const source = String(sourceListingId || '').trim();
  if (source.startsWith('scan:')) {
    ref = firestore.collection(COLLECTION).doc(source);
    const snap = await transaction.get(ref);
    const row = snap.data() || {};
    if (
      !snap.exists ||
      row.uid !== sellerUid ||
      row.ownershipType === 'nft' ||
      row.fulfillmentMode === 'nft_only' ||
      row.nftStatus === 'owned'
    ) {
      ref = null;
    } else {
      data = row;
    }
  }

  if (!ref && listingId) {
    // Transactions cannot run queries reliably across all Firestore modes;
    // listingId-only legacy links without scan: id are skipped here.
    return { ok: true, skipped: true, reason: 'no_scan_link_in_tx' };
  }
  if (!ref) return { ok: true, skipped: true, reason: 'no_linked_ownership' };

  const current = Number(data.quantity) || 0;
  const next = current - sold;
  if (next <= 0) {
    transaction.delete(ref);
    return { ok: true, deleted: true, docId: ref.id, before: current, after: 0 };
  }
  transaction.set(ref, {
    quantity: next,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true, deleted: false, docId: ref.id, before: current, after: next };
}

/**
 * Remove copies of an owned physical holding (collection red-cross).
 * Removes one copy by default and deletes the doc at zero quantity.
 * NFT docs are never removable here — they track paid ownership and
 * shipping requests. A doc owned by someone else answers 404 so the
 * endpoint cannot leak other users' item ids.
 */
async function removeOwnedCollectionItem({
  firestore,
  admin,
  uid,
  itemId,
  quantity = 1,
}) {
  const owner = String(uid || '').trim();
  if (!owner) {
    const error = new Error('Authentication required.');
    error.statusCode = 401;
    throw error;
  }
  if (!firestore || !admin) {
    throw new Error('Firestore admin required for collection remove');
  }
  const id = String(itemId || '').trim();
  if (!id) {
    const error = new Error('Collection item id is required.');
    error.statusCode = 400;
    throw error;
  }
  const remove = Math.max(1, Math.floor(Number(quantity) || 1));
  const ref = firestore.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    const error = new Error('Collection item not found.');
    error.statusCode = 404;
    throw error;
  }
  const row = snap.data() || {};
  if (String(row.uid || '') !== owner) {
    const error = new Error('Collection item not found.');
    error.statusCode = 404;
    throw error;
  }
  if (isNftRow(row)) {
    const error = new Error('NFT holdings cannot be removed from the collection.');
    error.statusCode = 400;
    throw error;
  }
  const current = Math.max(0, Number(row.quantity) || 0);
  const next = Math.max(0, current - remove);
  if (next <= 0) {
    await ref.delete();
    return { ok: true, deleted: true, itemId: id, before: current, after: 0 };
  }
  await ref.set({
    quantity: next,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true, deleted: false, itemId: id, before: current, after: next };
}

/**
 * Owned holdings for the authenticated uid only. Admin read — never trust a
 * client-supplied uid; callers must pass decoded.uid from verifyIdToken.
 */
function isNftRow(row = {}) {
  return row.ownershipType === 'nft'
    || row.fulfillmentMode === 'nft_only'
    || row.nftStatus === 'owned';
}

/**
 * Firestore Timestamp | Date | ISO string -> ISO string (or null).
 * Clients sort holdings by updatedAt/createdAt, so these must survive the API.
 */
function isoTimestamp(value) {
  if (!value) {
    return null;
  }
  if (typeof value.toDate === 'function') {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function publicCollectionItem(doc) {
  const row = doc.data() || {};
  return {
    id: doc.id,
    uid: row.uid || '',
    cardId: row.cardId || row.blueprintId || '',
    blueprintId: row.blueprintId || row.cardId || '',
    quantity: Math.max(0, Number(row.quantity) || 0),
    condition: row.condition || '',
    language: row.language || '',
    firstEdition: row.firstEdition === true,
    holo: row.holo === true,
    reverse: row.reverse === true,
    graded: row.graded === true,
    gradingCompany: row.gradingCompany || null,
    grade: row.grade || null,
    certificationId: row.certificationId || null,
    cardName: row.cardName || row.name || '',
    name: row.cardName || row.name || '',
    cardImageUrl: row.cardImageUrl || '',
    setName: row.setName || '',
    collectorNumber: row.collectorNumber || '',
    ownershipType: row.ownershipType || '',
    nftStatus: row.nftStatus || '',
    fulfillmentMode: row.fulfillmentMode || '',
    physicalShippingStatus: row.physicalShippingStatus || '',
    physicalShippingRequestId: row.physicalShippingRequestId || '',
    source: row.source || '',
    sourceOrderId: row.sourceOrderId || '',
    sourceListingId: row.sourceListingId || '',
    listingId: row.listingId || null,
    createdAt: isoTimestamp(row.createdAt),
    updatedAt: isoTimestamp(row.updatedAt),
  };
}

async function listOwnedCollection({ firestore, uid }) {
  const owner = String(uid || '').trim();
  if (!owner) {
    const error = new Error('Authentication required.');
    error.statusCode = 401;
    throw error;
  }
  if (!firestore) {
    throw new Error('Firestore admin required for collection list');
  }
  const snap = await firestore.collection(COLLECTION).where('uid', '==', owner).get();
  const items = [];
  let cardsOwned = 0;
  let physicalItems = 0;
  let nftItems = 0;
  let physicalOwned = 0;
  let nftOwned = 0;
  for (const doc of snap.docs) {
    const row = doc.data() || {};
    if (String(row.uid || '') !== owner) {
      // Defense in depth: never return another owner's doc even if a query drifts.
      continue;
    }
    const item = publicCollectionItem(doc);
    items.push(item);
    const qty = item.quantity > 0 ? item.quantity : 0;
    cardsOwned += qty;
    if (isNftRow(row)) {
      nftItems += 1;
      nftOwned += qty;
    } else {
      physicalItems += 1;
      physicalOwned += qty;
    }
  }
  items.sort((a, b) => {
    const an = String(a.cardName || a.cardId || '').toLowerCase();
    const bn = String(b.cardName || b.cardId || '').toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });
  return {
    uid: owner,
    items,
    cardsOwned,
    itemCount: items.length,
    physicalItems,
    nftItems,
    physicalOwned,
    nftOwned,
  };
}

async function summarizeOwnedCollection({ firestore, uid }) {
  const listed = await listOwnedCollection({ firestore, uid });
  return {
    uid: listed.uid,
    cardsOwned: listed.cardsOwned,
    items: listed.itemCount,
    physicalItems: listed.physicalItems,
    nftItems: listed.nftItems,
    physicalOwned: listed.physicalOwned,
    nftOwned: listed.nftOwned,
  };
}

module.exports = {
  COLLECTION,
  SOURCE_SCAN,
  scanOwnershipDocId,
  physicalPayloadFromScanRow,
  upsertScanOwnership,
  decrementSellerOwnershipForSale,
  decrementSellerOwnershipInTransaction,
  removeOwnedCollectionItem,
  listOwnedCollection,
  summarizeOwnedCollection,
  publicCollectionItem,
};
