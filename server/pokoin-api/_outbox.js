'use strict';

const INSERT_SQL = `
insert into public.marketplace_outbox (
  event_type, aggregate_id, payload, idempotency_key
) values ($1, $2, $3::jsonb, $4)
on conflict (idempotency_key) where processed_at is null and idempotency_key is not null
do nothing
returning id
`;

const CLAIM_SQL = `
update public.marketplace_outbox as outbox
set
  attempts = outbox.attempts + 1,
  available_at = now() + interval '30 seconds'
where outbox.id = (
  select id
  from public.marketplace_outbox
  where processed_at is null
    and available_at <= now()
    and attempts < 8
  order by id
  for update skip locked
  limit 1
)
returning id, event_type, aggregate_id, payload, attempts
`;

function normalizeEvent(event) {
  if (!event || !event.type || !event.aggregateId) return null;
  return {
    type: String(event.type),
    aggregateId: String(event.aggregateId),
    payload: event.payload && typeof event.payload === 'object' ? event.payload : {},
    idempotencyKey: event.idempotencyKey ? String(event.idempotencyKey) : null,
  };
}

async function insertOutbox(client, event) {
  const row = normalizeEvent(event);
  if (!row) return false;
  await client.query('savepoint pokoin_outbox');
  try {
    const inserted = await client.query(INSERT_SQL, [
      row.type,
      row.aggregateId,
      JSON.stringify(row.payload),
      row.idempotencyKey,
    ]);
    if (inserted.rows[0]?.id) {
      await client.query(`select pg_notify('pokoin_outbox', $1)`, [String(inserted.rows[0].id)]);
    }
    return true;
  } catch (error) {
    await client.query('rollback to savepoint pokoin_outbox');
    if (error.code === '42P01') return false;
    throw error;
  }
}

async function writerPool() {
  try {
    return require('./_marketplace_db').getMarketplaceWriterPool();
  } catch (_) {
    return null;
  }
}

/**
 * Run `work(client)` inside one writer transaction.
 * Returns null when the writer pool cannot be loaded so the caller can fall
 * back to a single statement. Outbox absence (42P01) does not roll back `work`.
 */
async function withWriterTransaction(work) {
  const pool = await writerPool();
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try { await client.query('rollback'); } catch (_) { /* already aborted */ }
    throw error;
  } finally {
    client.release();
  }
}

async function commitListingWrite({ sql, values, event, writeQuery }) {
  const transactional = await withWriterTransaction(async (client) => {
    const result = await client.query(sql, values);
    const queued = event ? await insertOutbox(client, typeof event === 'function' ? event(result) : event) : false;
    return { result, queued };
  });
  if (transactional) return transactional;
  const result = await writeQuery(sql, values);
  return { result, queued: false };
}

async function claimOne(client) {
  const claimed = await client.query(CLAIM_SQL);
  return claimed.rows[0] || null;
}

async function finishClaim(client, id, { error, payload, retrySeconds } = {}) {
  if (error) {
    const delay = Number(retrySeconds);
    if (Number.isFinite(delay) && delay > 0) {
      await client.query(
        `update public.marketplace_outbox
         set last_error = $2,
             payload = coalesce($3::jsonb, payload),
             available_at = now() + make_interval(secs => $4)
         where id = $1`,
        [id, String(error).slice(0, 500), payload ? JSON.stringify(payload) : null, delay],
      );
      return;
    }
    await client.query(
      `update public.marketplace_outbox set last_error = $2, payload = coalesce($3::jsonb, payload) where id = $1`,
      [id, String(error).slice(0, 500), payload ? JSON.stringify(payload) : null],
    );
    return;
  }
  await client.query(
    `update public.marketplace_outbox set processed_at = now(), last_error = null, payload = coalesce($2::jsonb, payload) where id = $1`,
    [id, payload ? JSON.stringify(payload) : null],
  );
}

module.exports = {
  INSERT_SQL,
  CLAIM_SQL,
  insertOutbox,
  withWriterTransaction,
  commitListingWrite,
  claimOne,
  finishClaim,
  normalizeEvent,
};
