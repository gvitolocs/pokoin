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

/** List the caller's docs in a collection (wallet ledger feeds). REST runQuery
 * instead of the SDK so the credentialless extension iframe — no
 * firebaseAuth.currentUser — still reads with the injected bearer.
 *
 * Prefer newest-first + limit when the composite index exists; fall back to
 * the plain uid filter so a missing index never blanks the feed. */
export async function fetchOwnedCollectionDocuments(
  collection,
  uid,
  token,
  { fetchImpl = fetch, limit = 0, sinceMs = 0 } = {},
) {
  const col = String(collection || '').trim();
  const id = String(uid || '').trim();
  const bearer = String(token || '').trim();
  if (!col || !id || bearer.length <= 20) {
    return [];
  }
  const filters = [
    {
      fieldFilter: {
        field: { fieldPath: 'uid' },
        op: 'EQUAL',
        value: { stringValue: id },
      },
    },
  ];
  if (sinceMs > 0) {
    filters.push({
      fieldFilter: {
        field: { fieldPath: 'createdAt' },
        op: 'GREATER_THAN',
        value: {
          timestampValue: new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        },
      },
    });
  }
  const structuredQuery = {
    from: [{ collectionId: col }],
    where: filters.length === 1
      ? filters[0]
      : { compositeFilter: { op: 'AND', filters } },
  };
  if (limit > 0) {
    structuredQuery.orderBy = [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }];
    structuredQuery.limit = Math.min(Math.floor(limit), 200);
  }

  async function run(query) {
    const response = await fetchImpl(
      `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents:runQuery`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ structuredQuery: query }),
      },
    );
    if (!response.ok) {
      const err = new Error(`firestore query ${col} ${response.status}`);
      err.status = response.status;
      throw err;
    }
    const rows = await response.json();
    return (Array.isArray(rows) ? rows : [])
      .map((row) => row?.document)
      .filter(Boolean)
      .map((doc) => ({
        id: String(doc.name || '').split('/').pop() || '',
        ...firestoreDocumentData(doc),
      }));
  }

  try {
    return await run(structuredQuery);
  } catch (err) {
    // Missing composite index (uid + createdAt) — retry the plain uid scan.
    if (limit > 0 || sinceMs > 0) {
      return run({
        from: [{ collectionId: col }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'uid' },
            op: 'EQUAL',
            value: { stringValue: id },
          },
        },
      });
    }
    throw err;
  }
}
