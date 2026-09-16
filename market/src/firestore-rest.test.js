import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchDeskUserDocuments,
  firestoreDocumentData,
  firestoreDocumentUrl,
  firestoreFieldValue,
} from './firestore-rest.js';

test('firestore REST urls stay on the pokoin project', () => {
  assert.equal(
    firestoreDocumentUrl('users', 'desk-user'),
    'https://firestore.googleapis.com/v1/projects/pokoin/databases/(default)/documents/users/desk-user',
  );
});

test('firestore REST fields unwrap Silver and site PKN', () => {
  const data = firestoreDocumentData({
    fields: {
      role: { stringValue: 'silver' },
      admin: { booleanValue: false },
      silverUntil: { timestampValue: '2027-01-01T00:00:00Z' },
      availablePkn: { integerValue: '1840' },
    },
  });
  assert.equal(data.role, 'silver');
  assert.equal(data.admin, false);
  assert.equal(data.silverUntil, '2027-01-01T00:00:00Z');
  assert.equal(data.availablePkn, 1840);
  assert.equal(firestoreFieldValue({ nullValue: null }), null);
});

test('desk user documents load users and balances with the ID token', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, auth: options.headers.Authorization });
    if (url.includes('/users/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ fields: { role: { stringValue: 'silver' } } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ fields: { availablePkn: { integerValue: '20' } } }),
    };
  };
  const docs = await fetchDeskUserDocuments('desk-user', 'z'.repeat(24), fetchImpl);
  assert.equal(docs.user.role, 'silver');
  assert.equal(docs.balance.availablePkn, 20);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].auth, `Bearer ${'z'.repeat(24)}`);
});
