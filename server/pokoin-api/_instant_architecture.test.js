'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { finishClaim, insertOutbox } = require('./_outbox');
const { readArtistSummary } = require('./_artist_summary');

function client() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push(String(sql));
      if (sql.includes('insert into public.marketplace_outbox')) {
        return { rows: [{ id: 4 }] };
      }
      return { rows: [] };
    },
  };
}

test('a missing outbox table does not fail the listing transaction', async () => {
  const db = client();
  db.query = async (sql) => {
    db.queries.push(String(sql));
    if (sql.includes('insert into public.marketplace_outbox')) {
      const error = new Error('relation does not exist');
      error.code = '42P01';
      throw error;
    }
    return { rows: [] };
  };
  const queued = await insertOutbox(db, {
    type: 'listing.changed',
    aggregateId: '9',
    payload: { cardId: '1' },
    idempotencyKey: 'listing.changed:9:1',
  });
  assert.equal(queued, false);
  assert.ok(db.queries.some((sql) => sql.includes('rollback to savepoint')));
});

test('a failed side effect stays pending and keeps the partial payload', async () => {
  const db = client();
  await finishClaim(db, 4, { error: 'cardtrader down', payload: { steps: { price: true } } });
  assert.match(db.queries[0], /last_error/);
  assert.doesNotMatch(db.queries[0], /processed_at = now\(\)/);
});

test('artist summaries read the projection and fall open when it is absent', async () => {
  const rows = await readArtistSummary(async () => ({
    rows: [{ artist_slug: 'ken-sugimori', artist_card_count: 3 }],
  }), 10);
  assert.equal(rows[0].artist_slug, 'ken-sugimori');
  const missing = await readArtistSummary(async () => {
    const error = new Error('missing');
    error.code = '42P01';
    throw error;
  }, 10);
  assert.equal(missing, null);
});
