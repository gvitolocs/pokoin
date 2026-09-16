/** Read Firestore docs with a Firebase ID token. The credentialless
 * extension desk iframe has no firebaseAuth.currentUser, so the SDK
 * snapshot path cannot load Silver / site PKN. */

export const FIRESTORE_PROJECT = 'pokoin';

export function firestoreDocumentUrl(collection = '', documentId = '') {
  const col = encodeURIComponent(String(collection || '').trim());
  const id = encodeURIComponent(String(documentId || '').trim());
  return `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/${col}/${id}`;
}

export function firestoreFieldValue(field) {
  if (field == null) {
    return undefined;
  }
  if (typeof field !== 'object') {
    return field;
  }
  if ('stringValue' in field) {
    return field.stringValue;
  }
  if ('booleanValue' in field) {
    return field.booleanValue;
  }
  if ('integerValue' in field) {
    return Number(field.integerValue);
  }
  if ('doubleValue' in field) {
    return Number(field.doubleValue);
  }
  if ('timestampValue' in field) {
    return field.timestampValue;
  }
  if ('nullValue' in field) {
    return null;
  }
  return undefined;
}

export function firestoreDocumentData(doc = {}) {
  const fields = doc?.fields && typeof doc.fields === 'object' ? doc.fields : {};
  const data = {};
  Object.keys(fields).forEach((key) => {
    data[key] = firestoreFieldValue(fields[key]);
  });
  return data;
}

export async function fetchFirestoreDocument(collection, documentId, token, fetchImpl = fetch) {
  const response = await fetchImpl(firestoreDocumentUrl(collection, documentId), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) {
    return {};
  }
  if (!response.ok) {
    throw new Error(`firestore ${collection} ${response.status}`);
  }
  return firestoreDocumentData(await response.json());
}

export async function fetchDeskUserDocuments(uid, token, fetchImpl = fetch) {
  const id = String(uid || '').trim();
  const bearer = String(token || '').trim();
  if (!id || bearer.length <= 20) {
    return { user: {}, balance: {} };
  }
  const [user, balance] = await Promise.all([
    fetchFirestoreDocument('users', id, bearer, fetchImpl),
    fetchFirestoreDocument('balances', id, bearer, fetchImpl),
  ]);
  return { user, balance };
}
