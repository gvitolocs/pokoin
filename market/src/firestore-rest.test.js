import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchDeskUserDocuments,
  fetchOwnedCollectionDocuments,
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

test('owned collection queries run uid filters over REST runQuery', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => [
        {
          document: {
            name: 'projects/pokoin/databases/(default)/documents/ledger_entries/row1',
            fields: {
              uid: { stringValue: 'desk-user' },
              type: { stringValue: 'pkn_purchase_credit' },
              amountPkn: { integerValue: '500' },
            },
          },
        },
        { readTime: '2026-09-19T00:00:00Z' },
      ],
    };
  };
  const rows = await fetchOwnedCollectionDocuments('ledger_entries', 'desk-user', 'z'.repeat(24), { fetchImpl });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'row1');
  assert.equal(rows[0].amountPkn, 500);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url.includes('documents:runQuery'), true);
  assert.deepEqual(body.structuredQuery.from, [{ collectionId: 'ledger_entries' }]);
  assert.deepEqual(
    body.structuredQuery.where.fieldFilter.value,
    { stringValue: 'desk-user' },
  );
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${'z'.repeat(24)}`);
});

test('owned collection queries bail out without a uid or real token', async () => {
  assert.deepEqual(await fetchOwnedCollectionDocuments('ledger_entries', '', 'z'.repeat(24)), []);
  assert.deepEqual(await fetchOwnedCollectionDocuments('ledger_entries', 'desk-user', 'short'), []);
});
