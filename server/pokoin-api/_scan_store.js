'use strict';

// Scan Connect persistence. Every read and write goes to the Postgres
// **writer**: a stream reading the replica would miss the row it was just
// told about. `pool` is injected so integration tests run on a throwaway
// Postgres. Spec: pokoin-web docs/SCAN_CONNECT.md.

const rules = require('./_scan_connect');

const MAX_BATCH_ROWS = 10_000;

const {
  PAIRING_TTL_MS,
  EXPIRY_UPLOAD_GRACE_MS,
  LIMITS,
  DEFAULT_BATCH_DEFAULTS,
  httpError,
} = rules;

const ITEM_COLUMNS = `
  id, batch_id, seller_uid, scan_event_id, session_id, client_sequence, captured_at, received_at,
  recognition_state, recognition, defaults_version, defaults_snapshot, (image is not null) as has_image,
  timings, seq, position, status, merged_into, reviewed, card_id, card_name, set_name, collector_number,
  image_url, nationality, condition, language, foil_state, first_edition, signed, altered, graded,
  grading_company, grade, certification_id, location, quantity, price_pkn, price_suggested,
  seller_comment, listing_id, updated_at
`;

/** Listing location: bare box + slotText (`box1·47` or `box1·2·5`). */
function listingLocationOf(row, slot) {
  if (!String(row.location || '').trim()) return row.location || '';
  if (!slot) return row.location;
  return `${row.location}${rules.slotText(slot)}`;
}

async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch (_) {
      // connection already broken; release below discards it
    }
    throw error;
  } finally {
    client.release();
  }
}

function windowStart(nowMs, windowMs) {
  return new Date(Math.floor(nowMs / windowMs) * windowMs);
}

async function limitHits(client, bucket, limit, nowMs) {
  const result = await client.query(
    'select hits from public.scan_rate_limits where bucket = $1 and window_start = $2',
    [bucket, windowStart(nowMs, limit.windowMs)],
  );
  return Number(result.rows[0]?.hits || 0);
}

async function limitIncrement(client, bucket, limit, nowMs) {
  const result = await client.query(
    `insert into public.scan_rate_limits (bucket, window_start, hits)
     values ($1, $2, 1)
     on conflict (bucket, window_start) do update set hits = public.scan_rate_limits.hits + 1
     returning hits`,
    [bucket, windowStart(nowMs, limit.windowMs)],
  );
  return Number(result.rows[0].hits);
}

function retryAfter(limit, nowMs) {
  const start = windowStart(nowMs, limit.windowMs).getTime();
  return Math.max(1, Math.ceil((start + limit.windowMs - nowMs) / 1000));
}

function tooMany(limit, nowMs) {
  return httpError(429, 'Too many attempts. Wait a moment and try again.', {
    code: 'rate_limited',
    retryAfterSec: retryAfter(limit, nowMs),
  });
}

async function enforceLimit(client, bucket, limit, nowMs) {
  const hits = await limitIncrement(client, bucket, limit, nowMs);
  if (hits > limit.max) throw tooMany(limit, nowMs);
  return hits;
}

async function bumpBatch(client, batchId, { positions = 0 } = {}) {
  const result = await client.query(
    `update public.scan_batches
       set item_seq = item_seq + 1, item_position = item_position + $2, updated_at = now()
     where id = $1
     returning item_seq, item_position`,
    [batchId, positions],
  );
  return { seq: Number(result.rows[0].item_seq), position: Number(result.rows[0].item_position) };
}

async function lockBatch(client, sellerUid, batchId, { open = true } = {}) {
  if (!rules.isUuid(batchId)) throw httpError(404, 'Batch not found.');
  const result = await client.query(
    'select * from public.scan_batches where id = $1 and seller_uid = $2 for update',
    [batchId, sellerUid],
  );
  const batch = result.rows[0];
  if (!batch) throw httpError(404, 'Batch not found.');
  if (open && batch.status !== 'open') throw httpError(409, 'This batch is closed.', { code: 'batch_closed' });
  return batch;
}

async function createPairing(client, sessionId, nowMs, randomInt) {
  await client.query('delete from public.scan_pairings where session_id = $1', [sessionId]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pin = rules.randomPin(randomInt);
    const qrSecret = rules.randomSecret(24);
    const expiresAt = new Date(nowMs + PAIRING_TTL_MS);
    // Free a PIN only once it is expired; a live PIN is never reused.
    await client.query('delete from public.scan_pairings where pin = $1 and expires_at <= now()', [pin]);
    const inserted = await client.query(
      `insert into public.scan_pairings (pin, session_id, qr_secret, expires_at)
       values ($1, $2, $3, $4)
       on conflict (pin) do nothing
       returning pin, qr_secret, expires_at`,
      [pin, sessionId, qrSecret, expiresAt],
    );
    if (inserted.rows[0]) {
      return { pin, qrSecret, expiresAt: expiresAt.toISOString() };
    }
  }
  throw httpError(503, 'No free pairing code. Try again.', { code: 'pin_exhausted' });
}

async function endSessionRow(client, sessionId, reason) {
  await client.query('delete from public.scan_pairings where session_id = $1', [sessionId]);
  const result = await client.query(
    `update public.scan_sessions
       set status = 'ended', end_reason = $2, ended_at = now(), phone_token_hash = null, version = version + 1
     where id = $1 and status <> 'ended'
     returning *`,
    [sessionId, reason],
  );
  return result.rows[0] || null;
}

/** Drop the phone credential; keep the session + open batch for reconnect. */
async function disconnectPhoneRow(client, sessionId, nowMs, randomInt) {
  const result = await client.query(
    `update public.scan_sessions
       set status = 'waiting', phone_token_hash = null, phone_label = '', phone_connected_at = null,
           phone_last_seen_at = null, last_scan_at = null, last_activity_at = now(), version = version + 1
     where id = $1 and status = 'connected'
     returning *`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  await createPairing(client, sessionId, nowMs, randomInt);
  return row;
}

async function liveSessionForBatch(client, sellerUid, batchId, nowMs, randomInt) {
  const result = await client.query(
    `select * from public.scan_sessions
     where seller_uid = $1 and batch_id = $2 and status <> 'ended'
     order by created_at desc
     for update`,
    [sellerUid, batchId],
  );
  let live = null;
  for (const row of result.rows) {
    if (rules.isScanIdleExpired(row, nowMs)) {
      await disconnectPhoneRow(client, row.id, nowMs, randomInt);
      // Prefer the waiting session we just opened for reconnect.
      if (!live) {
        const refreshed = (await client.query('select * from public.scan_sessions where id = $1', [row.id])).rows[0];
        live = refreshed || row;
      }
    } else if (rules.isIdleExpired(row, nowMs)) {
      await endSessionRow(client, row.id, 'expired');
    } else if (!live) {
      live = row;
    } else {
      await endSessionRow(client, row.id, 'replaced');
    }
  }
  return live;
}

async function pairingForSession(client, sessionId) {
  const result = await client.query(
    'select pin, qr_secret, expires_at from public.scan_pairings where session_id = $1 and expires_at > now()',
    [sessionId],
  );
  const row = result.rows[0];
  return row ? { pin: row.pin, qrSecret: row.qr_secret, expiresAt: new Date(row.expires_at).toISOString() } : null;
}

async function defaultUpsertScanOwnership(args) {
  const { getFirebaseAdmin } = require('./_firebase');
  const { upsertScanOwnership } = require('./_user_card_collection');
  const admin = getFirebaseAdmin();
  return upsertScanOwnership({
    firestore: admin.firestore(),
    admin,
    ...args,
  });
}

function createStore({
  pool,
  lookupCards = async () => new Map(),
  // (hitIds, topId) → catalog printings of the hits plus every member of the
  // top hit's artwork. Empty = no printing choice (per-printing rule only).
  lookupPrintings = async () => [],
  now = () => Date.now(),
  randomInt,
  onListingsCreated = async () => {},
  upsertScanOwnership = defaultUpsertScanOwnership,
} = {}) {
  if (!pool) throw new Error('scan store needs a pool');

  async function startSession({ sellerUid, batchId }) {
    const nowMs = now();
    return withTx(pool, async (client) => {
      let batch;
      if (batchId) {
        batch = await lockBatch(client, sellerUid, batchId);
      } else {
        const open = await client.query(
          `select * from public.scan_batches where seller_uid = $1 and status = 'open'
           order by updated_at desc limit 1 for update`,
          [sellerUid],
        );
        batch = open.rows[0];
      }
      if (!batch) {
        // A new box starts where the seller left off: reuse the location and
        // cards-per-stack of their most recent batch that had a location. The
        // desk advances stack/startPosition from live stock (nextFreeSlot), so
        // those stay at 1 and nothing else (condition, language, price) is copied.
        const previous = await client.query(
          `select defaults from public.scan_batches
            where seller_uid = $1 and coalesce(defaults->>'location', '') <> ''
            order by updated_at desc limit 1`,
          [sellerUid],
        );
        const last = previous.rows[0]?.defaults;
        // normalizeDefaults is the same clamp setDefaults applies, so a bad
        // stackSize in an old row cannot reach the insert.
        const defaults = last
          ? rules.normalizeDefaults({ location: last.location, stackSize: last.stackSize })
          : { ...DEFAULT_BATCH_DEFAULTS };
        const created = await client.query(
          `insert into public.scan_batches (seller_uid, defaults, defaults_history)
           values ($1, $2, $3) returning *`,
          [sellerUid, defaults, JSON.stringify(rules.appendDefaults([], defaults, 1, nowMs))],
        );
        batch = created.rows[0];
      }
      let session = await liveSessionForBatch(client, sellerUid, batch.id, nowMs, randomInt);
      if (!session) {
        // Only new sessions count; resuming in another tab or after a reload is free.
        await enforceLimit(client, `start:${sellerUid}`, LIMITS.sessionStartPerSeller, nowMs);
        const inserted = await client.query(
          'insert into public.scan_sessions (seller_uid, batch_id) values ($1, $2) returning *',
          [sellerUid, batch.id],
        );
        session = inserted.rows[0];
      }
      let pairing = null;
      if (session.status === 'waiting') {
        pairing = await pairingForSession(client, session.id) || await createPairing(client, session.id, nowMs, randomInt);
      }
      return {
        session: rules.sessionView(session, nowMs),
        batch: rules.batchView(batch),
        pairing,
        serverTime: nowMs,
      };
    });
  }

  async function lockSession(client, sellerUid, sessionId) {
    if (!rules.isUuid(sessionId)) throw httpError(404, 'Session not found.');
    const result = await client.query(
      'select * from public.scan_sessions where id = $1 and seller_uid = $2 for update',
      [sessionId, sellerUid],
    );
    const session = result.rows[0];
    if (!session) throw httpError(404, 'Session not found.');
    return session;
  }

  async function regeneratePairing({ sellerUid, sessionId }) {
    const nowMs = now();
    const out = await withTx(pool, async (client) => {
      const session = await lockSession(client, sellerUid, sessionId);
      if (session.status !== 'waiting') {
        throw httpError(409, 'A phone is already connected. Disconnect it first.', { code: 'not_waiting' });
      }
      if (rules.isIdleExpired(session, nowMs)) {
        await endSessionRow(client, session.id, 'expired');
        return { expired: true, batchId: session.batch_id };
      }
      await enforceLimit(client, `regen:${sessionId}`, LIMITS.pairingRegenPerSession, nowMs);
      await client.query('update public.scan_sessions set last_activity_at = now() where id = $1', [sessionId]);
      return { pairing: await createPairing(client, session.id, nowMs, randomInt), batchId: session.batch_id };
    });
    if (out.expired) {
      throw httpError(410, 'Session expired.', { code: 'session_expired' });
    }
    return { pairing: out.pairing, serverTime: nowMs };
  }

  async function getSession({ sellerUid, sessionId }) {
    const nowMs = now();
    const out = await withTx(pool, async (client) => {
      const session = await lockSession(client, sellerUid, sessionId);
      let row = session;
      let justExpired = false;
      let justIdleDisconnected = false;
      if (rules.isScanIdleExpired(session, nowMs)) {
        row = await disconnectPhoneRow(client, session.id, nowMs, randomInt) || session;
        justIdleDisconnected = true;
      } else if (rules.isIdleExpired(session, nowMs)) {
        row = await endSessionRow(client, session.id, 'expired') || session;
        justExpired = true;
      }
      const pairing = row.status === 'waiting' ? await pairingForSession(client, row.id) : null;
      return { session: row, pairing, justExpired, justIdleDisconnected };
    });
    if (out.justExpired || out.justIdleDisconnected) {
      require('./_scan_bus').notifyBatch(out.session.batch_id);
    }
    return {
      session: rules.sessionView(out.session, nowMs),
      pairing: out.pairing,
      serverTime: nowMs,
      justIdleDisconnected: out.justIdleDisconnected,
    };
  }

  async function updateSession({ sellerUid, sessionId, action, reason, paused }) {
    const nowMs = now();
    const row = await withTx(pool, async (client) => {
      const session = await lockSession(client, sellerUid, sessionId);
      if (session.status === 'ended') return session;
      if (action === 'end') {
        const clean = ['completed', 'logout'].includes(reason) ? reason : 'completed';
        return endSessionRow(client, session.id, clean);
      }
      if (action === 'disconnect') {
        const result = await client.query(
          `update public.scan_sessions
             set status = 'waiting', phone_token_hash = null, phone_label = '', phone_connected_at = null,
                 phone_last_seen_at = null, last_scan_at = null, last_activity_at = now(), version = version + 1
           where id = $1 returning *`,
          [session.id],
        );
        await createPairing(client, session.id, nowMs, randomInt);
        return result.rows[0];
      }
      if (action === 'pause') {
        const result = await client.query(
          `update public.scan_sessions set paused = $2, last_activity_at = now(), version = version + 1
           where id = $1 returning *`,
          [session.id, paused === true],
        );
        return result.rows[0];
      }
      throw httpError(400, 'Unknown session action.');
    });
    require('./_scan_bus').notifyBatch(row.batch_id);
    return getSession({ sellerUid, sessionId: row.id });
  }

  async function claimPairing({ pin, qr, ip, userAgent, device }) {
    const nowMs = now();
    const code = rules.isPin(pin) ? String(pin) : '';
    const secret = typeof qr === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(qr) ? qr : '';
    const outcome = await withTx(pool, async (client) => {
      const ipBucket = `pairfail:ip:${ip}`;
      const globalBucket = 'pairfail:global';
      if (await limitHits(client, globalBucket, LIMITS.pairFailGlobal, nowMs) >= LIMITS.pairFailGlobal.max) {
        return { limited: LIMITS.pairFailGlobal };
      }
      if (await limitHits(client, ipBucket, LIMITS.pairFailPerIp, nowMs) >= LIMITS.pairFailPerIp.max) {
        return { limited: LIMITS.pairFailPerIp };
      }
      const tries = await limitIncrement(client, `pairtry:ip:${ip}`, LIMITS.pairTryPerIp, nowMs);
      if (tries > LIMITS.pairTryPerIp.max) return { limited: LIMITS.pairTryPerIp };

      let claimed = null;
      if (code || secret) {
        // QR link carries PIN + secret: both must name the same live pairing.
        // Keypad sends the PIN alone. A bare secret (older links) still works.
        const result = await client.query(
          `delete from public.scan_pairings
           where expires_at > now()
             and (
               ($1 <> '' and $2 <> '' and pin = $1 and qr_secret = $2)
               or ($1 <> '' and $2 = '' and pin = $1)
               or ($1 = '' and $2 <> '' and qr_secret = $2)
             )
           returning session_id`,
          [code, secret],
        );
        claimed = result.rows[0] || null;
      }
      let session = null;
      if (claimed) {
        const locked = await client.query(
          `select s.* from public.scan_sessions s
           join public.scan_batches b on b.id = s.batch_id and b.status = 'open'
           where s.id = $1 for update of s`,
          [claimed.session_id],
        );
        session = locked.rows[0];
        if (session && (session.status !== 'waiting' || rules.isIdleExpired(session, nowMs))) session = null;
      }
      if (!session) {
        // Same answer and same writes for wrong, expired and used codes.
        await limitIncrement(client, ipBucket, LIMITS.pairFailPerIp, nowMs);
        await limitIncrement(client, globalBucket, LIMITS.pairFailGlobal, nowMs);
        return { failed: true };
      }
      const phoneToken = rules.randomSecret(32);
      const label = rules.deviceLabel(userAgent, device);
      const updated = await client.query(
        `update public.scan_sessions
           set status = 'connected', phone_token_hash = $2, phone_label = $3, phone_connected_at = now(),
               phone_last_seen_at = now(), last_scan_at = null, last_activity_at = now(), version = version + 1
         where id = $1 returning *`,
        [session.id, rules.sha256(phoneToken), label],
      );
      return { session: updated.rows[0], phoneToken };
    });
    if (outcome.limited) throw tooMany(outcome.limited, nowMs);
    if (outcome.failed) throw httpError(400, 'Code not valid or expired.', { code: 'invalid_code' });
    require('./_scan_bus').notifyBatch(outcome.session.batch_id);
    const batch = await pool.query('select defaults from public.scan_batches where id = $1', [outcome.session.batch_id]);
    return {
      phoneToken: outcome.phoneToken,
      sessionId: outcome.session.id,
      serverTime: nowMs,
      label: 'Pokoin Dashboard',
      defaultsLabel: rules.defaultsLabel(batch.rows[0]?.defaults),
      game: rules.normalizeDefaults(batch.rows[0]?.defaults || {}).game || 'pokemon',
      scanCatalog: rules.scanPhoneCatalog(rules.normalizeDefaults(batch.rows[0]?.defaults || {}).game),
    };
  }

  async function sessionForToken(client, token, { lock = false } = {}) {
    if (!token || token.length < 30 || token.length > 64) return null;
    const result = await client.query(
      `select s.*, b.status as batch_status, b.defaults as batch_defaults
       from public.scan_sessions s join public.scan_batches b on b.id = s.batch_id
       where s.phone_token_hash = $1 ${lock ? 'for update of s' : ''}`,
      [rules.sha256(token)],
    );
    return result.rows[0] || null;
  }

  function sessionGone({ idle = false } = {}) {
    if (idle) {
      return httpError(401, 'Session expired after 10 minutes without a scan. Pair again.', {
        code: 'session_idle',
      });
    }
    return httpError(401, 'This scanner is no longer connected.', { code: 'session_ended' });
  }

  async function heartbeat({ token }) {
    const nowMs = now();
    const out = await withTx(pool, async (client) => {
      const session = await sessionForToken(client, token, { lock: true });
      if (!session) return { gone: true };
      if (rules.isScanIdleExpired(session, nowMs)) {
        const dropped = await disconnectPhoneRow(client, session.id, nowMs, randomInt);
        return { gone: true, batchId: dropped?.batch_id || session.batch_id, idle: true };
      }
      if (rules.isIdleExpired(session, nowMs)) {
        const ended = await endSessionRow(client, session.id, 'expired');
        return { gone: true, batchId: ended?.batch_id };
      }
      const wasLost = !session.phone_last_seen_at
        || nowMs - new Date(session.phone_last_seen_at).getTime() >= rules.PHONE_LOST_MS;
      // Presence only — must not bump last_scan_at / last_activity_at.
      await client.query('update public.scan_sessions set phone_last_seen_at = now() where id = $1', [session.id]);
      return { session, wasLost };
    });
    if (out.gone) {
      if (out.batchId) require('./_scan_bus').notifyBatch(out.batchId);
      throw sessionGone({ idle: out.idle === true });
    }
    if (out.wasLost) require('./_scan_bus').notifyBatch(out.session.batch_id);
    const batchDefaults = rules.normalizeDefaults(out.session.batch_defaults || {});
    const phoneCatalog = rules.scanPhoneCatalog(batchDefaults.game);
    return {
      sessionId: out.session.id,
      batchId: out.session.batch_id,
      status: out.session.status,
      paused: out.session.paused === true,
      serverTime: nowMs,
      defaultsLabel: rules.defaultsLabel(batchDefaults),
      game: batchDefaults.game || 'pokemon',
      scanCatalog: phoneCatalog,
      received: Number(out.session.phone_scans || 0),
    };
  }

  async function leave({ token }) {
    const batchId = await withTx(pool, async (client) => {
      const session = await sessionForToken(client, token, { lock: true });
      if (!session) return null;
      await client.query(
        `update public.scan_sessions
           set status = 'waiting', phone_token_hash = null, phone_label = '', phone_connected_at = null,
               phone_last_seen_at = null, last_scan_at = null, version = version + 1
         where id = $1`,
        [session.id],
      );
      await createPairing(client, session.id, now(), randomInt);
      return session.batch_id;
    });
    if (batchId) require('./_scan_bus').notifyBatch(batchId);
    return { ok: true };
  }

  // Catalog rows for the printing choice; resolved against the batch language
  // later. Only a confident top hit can be a confident artwork, so weaker
  // scans skip the lookup. A failed lookup keeps today's per-printing rule.
  async function printingRowsFor(hits) {
    const scored = rules.candidatesFromHits(hits, hits.length);
    if (!scored.length || scored[0].score < rules.MATCH_SCORE) return [];
    try {
      return await lookupPrintings(scored.map((c) => c.cardId), scored[0].cardId);
    } catch (error) {
      console.error('scan printing lookup skipped', { message: error.message });
      return [];
    }
  }

  function cardFields(meta, cardId, printingRows = []) {
    const row = cardId && !meta.has(cardId)
      ? printingRows.find((r) => String(r.card_id) === String(cardId))
      : null;
    const card = cardId
      ? meta.get(cardId) || (row && {
        name: row.name,
        setName: row.set_name,
        number: row.card_number,
        imageUrl: row.image_url,
        nationality: String(row.nationality || '').toLowerCase(),
      })
      : null;
    return {
      card_id: cardId || null,
      card_name: card?.name || '',
      set_name: card?.setName || '',
      collector_number: card?.number || '',
      image_url: card?.imageUrl || '',
      nationality: card?.nationality || '',
    };
  }

  async function ingestScan({ token, body }) {
    const receivedAtMs = now();
    const event = rules.parseScanEvent(body);
    const recognition = rules.classifyRecognition(event.hits);
    let meta = new Map();
    const ids = recognition.candidates.map((c) => c.cardId);
    if (ids.length) {
      try {
        meta = await lookupCards(ids);
      } catch (error) {
        console.error('scan card lookup skipped', { message: error.message });
      }
    }
    const candidates = recognition.candidates.map((c) => ({
      ...c,
      name: meta.get(c.cardId)?.name || c.name,
      setName: meta.get(c.cardId)?.setName || '',
      number: meta.get(c.cardId)?.number || '',
      imageUrl: meta.get(c.cardId)?.imageUrl || '',
      nationality: meta.get(c.cardId)?.nationality || '',
    }));
    const printingRows = await printingRowsFor(event.hits);

    const out = await withTx(pool, async (client) => {
      const session = await sessionForToken(client, token, { lock: true });
      const prior = await client.query(
        'select id, seller_uid, status, merged_into from public.scan_items where scan_event_id = $1',
        [event.scanEventId],
      );
      if (prior.rows[0]) {
        if (!session || prior.rows[0].seller_uid !== session.seller_uid) {
          if (!session) return { gone: true };
          throw httpError(409, 'Scan id already used.', { code: 'scan_id_conflict' });
        }
        return { duplicate: true, item: prior.rows[0], session };
      }
      if (!session) return { gone: true };

      const capturedMs = rules.capturedAtServer({
        capturedAt: event.capturedAt,
        clockOffsetMs: event.clockOffsetMs,
        receivedAtMs,
        floorMs: session.phone_connected_at ? new Date(session.phone_connected_at).getTime() - 5000 : 0,
      });
      // Scan-idle: last accepted scan (or connect if none) + 10 min.
      // Heartbeat / desktop edits must not keep an idle phone alive.
      const activityMs = rules.scanIdleActivityMs(session);
      const expiryMs = Number.isFinite(activityMs)
        ? activityMs + rules.SCAN_IDLE_MS
        : new Date(session.last_activity_at).getTime() + rules.SESSION_IDLE_MS;
      const inGrace = capturedMs <= expiryMs && receivedAtMs - expiryMs <= EXPIRY_UPLOAD_GRACE_MS;
      if (session.status === 'ended') {
        if (session.end_reason !== 'expired' || !inGrace) return { gone: true };
      } else if (session.status !== 'connected') {
        return { gone: true, batchId: session.batch_id };
      } else if (receivedAtMs >= expiryMs && !inGrace) {
        await disconnectPhoneRow(client, session.id, receivedAtMs, randomInt);
        return { gone: true, batchId: session.batch_id, idle: true };
      }
      if (session.paused) {
        throw httpError(409, 'Scanning is paused on the dashboard.', { code: 'paused' });
      }
      // Return (not throw) so the counter increment commits.
      const scanBucket = `scan:${session.id}`;
      if (await limitHits(client, scanBucket, LIMITS.scanPerSession, receivedAtMs) >= LIMITS.scanPerSession.max) {
        return { limited: LIMITS.scanPerSession };
      }
      await limitIncrement(client, scanBucket, LIMITS.scanPerSession, receivedAtMs);
      if (session.batch_status !== 'open') {
        throw httpError(409, 'This batch is closed.', { code: 'batch_closed' });
      }
      const batch = (await client.query('select * from public.scan_batches where id = $1 for update', [session.batch_id])).rows[0];
      if (Number(batch.item_position) >= MAX_BATCH_ROWS) {
        throw httpError(409, 'This batch is full. Add it to inventory and start a new one.', { code: 'batch_full' });
      }
      const picked = rules.pickDefaults(batch.defaults_history, capturedMs);
      const snapshot = picked.defaults;
      // Complete artwork group across print languages. A phone
      // choice counts only if the server offers that printing too.
      const printing = printingRows.length
        ? rules.resolvePrintings({
          hits: event.hits,
          rows: printingRows,
          language: snapshot.language,
          choice: event.printingChoice,
        })
        : null;
      const decided = printing
        ? { state: printing.state, candidates: printing.candidates, topScore: printing.topScore, margin: printing.margin }
        : { ...recognition, candidates };
      let top = null;
      if (printing) top = { cardId: printing.cardId };
      else if (decided.state === 'ambiguous') top = rules.provisionalCandidate(candidates, snapshot.language);
      else if (decided.state === 'matched') top = candidates[0];

      const selectedRow = printing && printingRows.find(row => String(row.card_id) === String(top?.cardId));
      const listingLanguage = selectedRow
        ? rules.listingLanguageForPrint(selectedRow.nationality, snapshot.language)
        : snapshot.language;
      const listingSnapshot = { ...snapshot, language: listingLanguage };

      const lastRow = (await client.query(
        `select * from public.scan_items where batch_id = $1 and status <> 'removed'
         order by position desc limit 1`,
        [batch.id],
      )).rows[0];
      let head = null;
      if (lastRow?.status === 'active') head = lastRow;
      if (lastRow?.status === 'merged' && lastRow.merged_into) {
        head = (await client.query('select * from public.scan_items where id = $1 and status = $2 for update', [lastRow.merged_into, 'active'])).rows[0] || null;
      }
      const lastEvent = (await client.query(
        `select id from public.scan_items where batch_id = $1 order by position desc limit 1`,
        [batch.id],
      )).rows[0];
      // A removed row in between breaks the run.
      const consecutive = head && lastEvent && (lastEvent.id === lastRow.id);
      const merge = consecutive
        && top
        && rules.shouldMerge({ previous: head, recognition: decided, cardId: top.cardId, snapshot: listingSnapshot })
        && head.quantity + snapshot.quantity <= 99;

      const bump = await bumpBatch(client, batch.id, { positions: 1 });
      const fields = cardFields(meta, top?.cardId, printingRows);
      const recognitionJson = {
        state: decided.state,
        catalog: event.catalog,
        topScore: decided.topScore,
        margin: decided.margin,
        candidates: decided.candidates,
        ...(printing ? {
          printing: {
            artwork: printing.artwork,
            family: printing.family,
            offered: printing.choose ? printing.candidates.map((c) => c.cardId) : [],
            chosen: printing.chosen || null,
          },
        } : {}),
      };
      const inserted = await client.query(
        `insert into public.scan_items (
           batch_id, seller_uid, scan_event_id, session_id, client_sequence, captured_at, received_at,
           recognition_state, recognition, defaults_version, defaults_snapshot, image, timings,
           seq, position, status, merged_into, card_id, card_name, set_name, collector_number, image_url,
           nationality, condition, language, foil_state, first_edition, signed, altered, location, quantity
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31
         ) returning ${ITEM_COLUMNS}`,
        [
          batch.id, session.seller_uid, event.scanEventId, session.id, event.clientSequence,
          new Date(capturedMs), new Date(receivedAtMs), decided.state, recognitionJson,
          picked.version, snapshot, event.image, event.timings,
          bump.seq, bump.position, merge ? 'merged' : 'active', merge ? head.id : null,
          fields.card_id, fields.card_name, fields.set_name, fields.collector_number, fields.image_url,
          fields.nationality, snapshot.condition, listingLanguage, snapshot.foilState,
          snapshot.firstEdition, snapshot.signed, snapshot.altered, snapshot.location, snapshot.quantity,
        ],
      );
      let headRow = null;
      if (merge) {
        const headBump = await bumpBatch(client, batch.id);
        headRow = (await client.query(
          `update public.scan_items set quantity = quantity + $2, seq = $3, updated_at = now()
           where id = $1 returning ${ITEM_COLUMNS}`,
          [head.id, snapshot.quantity, headBump.seq],
        )).rows[0];
      }
      await client.query(
        `update public.scan_sessions
           set phone_last_seen_at = now(), last_scan_at = now(), last_activity_at = now(),
               phone_scans = phone_scans + 1, version = version + 1
         where id = $1`,
        [session.id],
      );
      const activeForSlots = (await client.query(
        `select id, location, quantity, defaults_snapshot
           from public.scan_items
          where batch_id = $1 and status = 'active'
          order by position`,
        [batch.id],
      )).rows;
      const slots = rules.boxSlots(activeForSlots);
      const targetId = headRow?.id || inserted.rows[0].id;
      const stackFull = Boolean(slots.get(targetId)?.filledStack);
      return { item: inserted.rows[0], head: headRow, session, recognition: decided, printing, stackFull };
    });

    if (out.gone) {
      if (out.batchId) require('./_scan_bus').notifyBatch(out.batchId);
      console.info(JSON.stringify({
        scan: 'dashboard-insert-rejected',
        reason: 'session_gone',
        scanEventId: event.scanEventId,
        batchId: out.batchId || null,
      }));
      throw sessionGone({ idle: out.idle === true });
    }
    if (out.limited) throw tooMany(out.limited, receivedAtMs);
    if (out.duplicate) {
      console.info(JSON.stringify({
        scan: 'dashboard-insert-duplicate',
        itemId: out.item.id,
        scanEventId: event.scanEventId,
        merged: out.item.status === 'merged',
      }));
      return {
        duplicate: true,
        itemId: out.item.id,
        merged: out.item.status === 'merged',
        serverTime: receivedAtMs,
      };
    }
    require('./_scan_bus').notifyBatch(out.item.batch_id);
    const insertedItem = out.item;
    console.info(JSON.stringify({
      scan: 'dashboard-insert',
      itemId: insertedItem.id,
      batchId: insertedItem.batch_id,
      sessionId: insertedItem.session_id,
      scanEventId: event.scanEventId,
      clientSequence: event.clientSequence,
      recognitionState: out.recognition.state,
      topScore: out.recognition.topScore,
      margin: out.recognition.margin,
      cardId: insertedItem.card_id || null,
      cardName: insertedItem.card_name || null,
      setName: insertedItem.set_name || null,
      collectorNumber: insertedItem.collector_number || null,
      catalog: event.catalog || null,
      printingFamily: out.printing?.family || null,
      printingOffered: out.printing?.choose ? out.printing.candidates.length : 0,
      printingChosen: out.printing?.chosen || null,
      merged: Boolean(out.head),
      headId: out.head?.id || null,
      headQuantity: out.head ? Number(out.head.quantity) : null,
      capturedAt: insertedItem.captured_at || null,
      receivedAt: insertedItem.received_at || null,
      phoneScans: Number(out.session.phone_scans || 0) + 1,
    }));
    return {
      duplicate: false,
      itemId: out.item.id,
      recognitionState: out.recognition.state,
      merged: Boolean(out.head),
      stackFull: out.stackFull === true,
      headId: out.head?.id || null,
      headQuantity: out.head ? Number(out.head.quantity) : null,
      serverTime: receivedAtMs,
      received: Number(out.session.phone_scans || 0) + 1,
    };
  }

  /**
   * Phone asks before sending a scan: which catalog printings share
   * this artwork? Read-only; the scan event is still the only
   * write, and ingest re-checks any choice made from this answer.
   */
  async function resolvePrintingsForPhone({ token, body }) {
    const nowMs = now();
    const request = rules.parsePrintingRequest(body);
    const session = await sessionForToken(pool, token);
    if (!session || session.status !== 'connected') throw sessionGone();
    const batch = (await pool.query(
      'select defaults_history from public.scan_batches where id = $1',
      [session.batch_id],
    )).rows[0];
    const capturedMs = rules.capturedAtServer({
      capturedAt: request.capturedAt,
      clockOffsetMs: request.clockOffsetMs,
      receivedAtMs: nowMs,
      floorMs: session.phone_connected_at ? new Date(session.phone_connected_at).getTime() - 5000 : 0,
    });
    const { language } = rules.pickDefaults(batch?.defaults_history, capturedMs).defaults;
    const rows = await printingRowsFor(request.hits);
    const printing = rows.length ? rules.resolvePrintings({ hits: request.hits, rows, language }) : null;
    const resolved = printing && rows.find((row) => String(row.card_id) === printing.cardId);
    return {
      serverTime: nowMs,
      language,
      family: rules.printFamily(language).id,
      state: printing ? printing.state : rules.classifyRecognition(request.hits).state,
      choose: Boolean(printing?.choose),
      cardId: printing && !printing.choose ? printing.cardId : '',
      name: resolved ? rules.cleanText(resolved.name, 160) : '',
      printings: printing?.choose ? printing.printings.map(rules.printingTile) : [],
    };
  }

  // ---- desktop: batch ----

  async function readBatchSnapshot({ sellerUid, batchId }) {
    if (!rules.isUuid(batchId)) throw httpError(404, 'Batch not found.');
    const nowMs = now();
    const client = pool;
    const batch = (await client.query(
      'select * from public.scan_batches where id = $1 and seller_uid = $2',
      [batchId, sellerUid],
    )).rows[0];
    if (!batch) throw httpError(404, 'Batch not found.');
    const items = (await client.query(
      `select ${ITEM_COLUMNS} from public.scan_items where batch_id = $1 order by position`,
      [batch.id],
    )).rows;
    const session = (await client.query(
      `select * from public.scan_sessions where batch_id = $1 order by created_at desc limit 1`,
      [batch.id],
    )).rows[0];
    return {
      batch: rules.batchView(batch),
      items: items.map(rules.itemView),
      session: rules.sessionView(session, nowMs),
      serverTime: nowMs,
    };
  }

  async function listOpenBatches({ sellerUid }) {
    const result = await pool.query(
      `select b.*, (select count(*) from public.scan_items i where i.batch_id = b.id and i.status = 'active')::int as rows,
              (select coalesce(sum(quantity), 0) from public.scan_items i where i.batch_id = b.id and i.status = 'active')::int as cards
       from public.scan_batches b where b.seller_uid = $1 and b.status = 'open'
       order by b.updated_at desc limit 20`,
      [sellerUid],
    );
    return { batches: result.rows.map((row) => ({ ...rules.batchView(row), rows: row.rows, cards: row.cards })) };
  }

  // Stream reads (writer).
  async function itemsAfter(batchId, cursor, limit = 500) {
    const result = await pool.query(
      `select ${ITEM_COLUMNS} from public.scan_items where batch_id = $1 and seq > $2 order by seq limit $3`,
      [batchId, cursor, limit],
    );
    return result.rows.map(rules.itemView);
  }

  async function batchForStream({ sellerUid, batchId }) {
    if (!rules.isUuid(batchId)) throw httpError(404, 'Batch not found.');
    const result = await pool.query(
      `select b.*, s.id as s_id from public.scan_batches b
       left join lateral (select id from public.scan_sessions where batch_id = b.id order by created_at desc limit 1) s on true
       where b.id = $1 and b.seller_uid = $2`,
      [batchId, sellerUid],
    );
    const row = result.rows[0];
    if (!row) throw httpError(404, 'Batch not found.');
    return row;
  }

  async function latestSession(batchId) {
    const nowMs = now();
    const out = await withTx(pool, async (client) => {
      const result = await client.query(
        `select * from public.scan_sessions where batch_id = $1 order by created_at desc limit 1 for update`,
        [batchId],
      );
      let row = result.rows[0];
      if (!row) return { row: null, idle: false };
      if (rules.isScanIdleExpired(row, nowMs)) {
        row = await disconnectPhoneRow(client, row.id, nowMs, randomInt) || row;
        return { row, idle: true };
      }
      return { row, idle: false };
    });
    if (out.idle && out.row) require('./_scan_bus').notifyBatch(out.row.batch_id);
    return rules.sessionView(out.row, nowMs);
  }

  async function mutateItem(sellerUid, itemId, fn) {
    if (!rules.isUuid(itemId)) throw httpError(404, 'Row not found.');
    const out = await withTx(pool, async (client) => {
      const row = (await client.query(
        `select i.*, b.status as batch_status from public.scan_items i
         join public.scan_batches b on b.id = i.batch_id
         where i.id = $1 and i.seller_uid = $2 for update of i, b`,
        [itemId, sellerUid],
      )).rows[0];
      if (!row) throw httpError(404, 'Row not found.');
      if (row.batch_status !== 'open') throw httpError(409, 'This batch is closed.', { code: 'batch_closed' });
      const changed = await fn(client, row);
      await client.query(
        `update public.scan_sessions set last_activity_at = now()
         where batch_id = $1 and status <> 'ended'`,
        [row.batch_id],
      );
      return { batchId: row.batch_id, changed };
    });
    require('./_scan_bus').notifyBatch(out.batchId);
    return { items: out.changed.map(rules.itemView) };
  }

  async function patchItem({ sellerUid, itemId, patch }) {
    const changes = rules.parseItemPatch(patch);
    const onlyIfEmptyPrice = patch?.onlyIfEmptyPrice === true;
    const cardChange = changes.find((c) => c.column === 'card_id');
    let meta = new Map();
    if (cardChange) meta = await lookupCards([cardChange.value]).catch(() => new Map());
    return mutateItem(sellerUid, itemId, async (client, row) => {
      if (row.status !== 'active') throw httpError(409, 'Only active rows can be edited.', { code: 'not_active' });
      let list = changes;
      if (onlyIfEmptyPrice && row.price_pkn != null) {
        list = list.filter((c) => c.column !== 'price_pkn' && c.column !== 'price_suggested');
      }
      if (cardChange) {
        const fields = cardFields(meta, cardChange.value);
        list = list.filter((c) => c.column !== 'card_id');
        for (const [column, value] of Object.entries(fields)) list.push({ column, value });
        list.push({ column: 'reviewed', value: true });
        if (!list.some((c) => c.column === 'price_pkn') && row.card_id !== cardChange.value) {
          list.push({ column: 'price_pkn', value: null }, { column: 'price_suggested', value: false });
        }
      }
      if (!list.length) return [row];
      const bump = await bumpBatch(client, row.batch_id);
      const values = [row.id, bump.seq];
      const sets = ['seq = $2', 'updated_at = now()'];
      for (const change of list) {
        values.push(change.value);
        sets.push(`${change.column} = $${values.length}`);
      }
      const updated = await client.query(
        `update public.scan_items set ${sets.join(', ')} where id = $1 returning ${ITEM_COLUMNS}`,
        values,
      );
      return updated.rows;
    });
  }

  async function setStatus({ sellerUid, itemId, from, to }) {
    return mutateItem(sellerUid, itemId, async (client, row) => {
      if (row.status !== from) throw httpError(409, `Row is ${row.status}.`, { code: 'wrong_status' });
      const bump = await bumpBatch(client, row.batch_id);
      const updated = await client.query(
        `update public.scan_items set status = $2, seq = $3, updated_at = now() where id = $1 returning ${ITEM_COLUMNS}`,
        [row.id, to, bump.seq],
      );
      return updated.rows;
    });
  }

  async function duplicateItem({ sellerUid, itemId }) {
    return mutateItem(sellerUid, itemId, async (client, row) => {
      if (row.status !== 'active') throw httpError(409, 'Only active rows can be copied.', { code: 'not_active' });
      const next = (await client.query(
        'select position from public.scan_items where batch_id = $1 and position > $2 order by position limit 1',
        [row.batch_id, row.position],
      )).rows[0];
      const position = next ? (Number(row.position) + Number(next.position)) / 2 : Number(row.position) + 0.5;
      const bump = await bumpBatch(client, row.batch_id);
      const inserted = await client.query(
        `insert into public.scan_items (
           batch_id, seller_uid, recognition_state, recognition, defaults_snapshot, seq, position, status,
           reviewed, card_id, card_name, set_name, collector_number, image_url, nationality, condition, language,
           foil_state, first_edition, signed, altered, graded, grading_company, grade, certification_id, location,
           quantity, price_pkn, price_suggested, seller_comment
         )
         select batch_id, seller_uid, 'manual', jsonb_build_object('copiedFrom', id), defaults_snapshot, $2, $3, 'active',
           true, card_id, card_name, set_name, collector_number, image_url, nationality, condition, language,
           foil_state, first_edition, signed, altered, graded, grading_company, grade, certification_id, location,
           1, price_pkn, price_suggested, seller_comment
         from public.scan_items where id = $1
         returning ${ITEM_COLUMNS}`,
        [row.id, bump.seq, position],
      );
      return inserted.rows;
    });
  }

  async function unmergeItem({ sellerUid, itemId }) {
    return mutateItem(sellerUid, itemId, async (client, row) => {
      if (row.status !== 'merged' || !row.merged_into) throw httpError(409, 'Row is not merged.', { code: 'not_merged' });
      const head = (await client.query('select * from public.scan_items where id = $1 for update', [row.merged_into])).rows[0];
      const out = [];
      if (head && head.status === 'active') {
        const bumpHead = await bumpBatch(client, row.batch_id);
        out.push(...(await client.query(
          `update public.scan_items set quantity = greatest(1, quantity - $2), seq = $3, updated_at = now()
           where id = $1 returning ${ITEM_COLUMNS}`,
          [head.id, row.quantity, bumpHead.seq],
        )).rows);
      }
      const bump = await bumpBatch(client, row.batch_id);
      out.push(...(await client.query(
        `update public.scan_items set status = 'active', merged_into = null, seq = $2, updated_at = now()
         where id = $1 returning ${ITEM_COLUMNS}`,
        [row.id, bump.seq],
      )).rows);
      return out;
    });
  }

  async function addManual({ sellerUid, batchId, body }) {
    const cardId = rules.cleanCardId(body?.cardId);
    if (!cardId) throw httpError(400, 'cardId must be a public card id.');
    const meta = await lookupCards([cardId]).catch(() => new Map());
    const out = await withTx(pool, async (client) => {
      const batch = await lockBatch(client, sellerUid, batchId);
      const d = rules.normalizeDefaults(body, rules.normalizeDefaults(batch.defaults));
      const bump = await bumpBatch(client, batch.id, { positions: 1 });
      const fields = cardFields(meta, cardId);
      const inserted = await client.query(
        `insert into public.scan_items (
           batch_id, seller_uid, recognition_state, defaults_version, defaults_snapshot, seq, position, status, reviewed,
           card_id, card_name, set_name, collector_number, image_url, nationality,
           condition, language, foil_state, first_edition, signed, altered, location, quantity
         ) values ($1,$2,'manual',$3,$4,$5,$6,'active',true,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         returning ${ITEM_COLUMNS}`,
        [
          batch.id, sellerUid, batch.defaults_version, d, bump.seq, bump.position,
          fields.card_id, fields.card_name, fields.set_name, fields.collector_number, fields.image_url, fields.nationality,
          d.condition, d.language, d.foilState, d.firstEdition, d.signed, d.altered, d.location, d.quantity,
        ],
      );
      return inserted.rows;
    });
    require('./_scan_bus').notifyBatch(batchId);
    return { items: out.map(rules.itemView) };
  }

  async function setDefaults({ sellerUid, batchId, defaults }) {
    const nowMs = now();
    // Fan out the same editable seller fields as market BATCH_ROW_FIELDS.
    // Qty / stack / mergeRepeats stay on the batch (capture snapshot).
    const ROW_FIELDS = [
      ['language', 'language'],
      ['condition', 'condition'],
      ['foilState', 'foil_state'],
      ['firstEdition', 'first_edition'],
      ['signed', 'signed'],
      ['altered', 'altered'],
      ['location', 'location'],
    ];
    const { batch, items } = await withTx(pool, async (client) => {
      const locked = await lockBatch(client, sellerUid, batchId);
      const prev = rules.normalizeDefaults(locked.defaults);
      const next = rules.normalizeDefaults(defaults, prev);
      const version = Number(locked.defaults_version) + 1;
      const history = rules.appendDefaults(locked.defaults_history, next, version, nowMs);
      const updated = await client.query(
        `update public.scan_batches
           set defaults = $2, defaults_version = $3, defaults_history = $4, updated_at = now()
         where id = $1 returning *`,
        [locked.id, next, version, JSON.stringify(history)],
      );
      await client.query(
        `update public.scan_sessions set last_activity_at = now() where batch_id = $1 and status <> 'ended'`,
        [locked.id],
      );
      const fieldSets = [];
      const fieldValues = [];
      for (const [key, column] of ROW_FIELDS) {
        if (prev[key] === next[key]) continue;
        fieldValues.push(next[key]);
        fieldSets.push(`${column} = $${fieldValues.length}`); // fields bind $1..$N; the batch id is last
      }
      let rows = [];
      if (fieldSets.length) {
        await bumpBatch(client, locked.id);
        rows = (await client.query(
          `update public.scan_items
              set ${fieldSets.join(', ')},
                  seq = seq + 1,
                  updated_at = now()
            where batch_id = $${fieldValues.length + 1} and status = 'active'
            returning ${ITEM_COLUMNS}`,
          [...fieldValues, locked.id],
        )).rows;
      }
      return { batch: updated.rows[0], items: rows };
    });
    require('./_scan_bus').notifyBatch(batchId);
    return {
      batch: rules.batchView(batch),
      items: (items || []).map(rules.itemView),
      serverTime: nowMs,
    };
  }

  async function submitBatch({
    sellerUid,
    batchId,
    submitKey,
    sellerName = 'Pokoin seller',
    intent: rawIntent,
    targets: rawTargets,
  }) {
    const intent = rawIntent === 'collection' ? 'collection' : 'list';
    const { normalizeTargets, pushAndLinkListing, pushListingToCardTrader } = require('./_cardtrader_seller_listings');
    const targets = intent === 'collection'
      ? { pokoin: true, cardtrader: false }
      : normalizeTargets(rawTargets || { pokoin: true, cardtrader: false });
    const key = rules.cleanText(submitKey, 80);

    // Phase 1 (Postgres): validate + upsert listings as NON-PURCHASABLE
    // (`inactive`). Purchase paths require `status = 'active'`, so there is no
    // window where a scan listing is buyable before ownership + batch finalize.
    // CardTrader-only skips Pokoin listing rows.
    const writePokoinListings = intent === 'list' && targets.pokoin;
    const prepared = await withTx(pool, async (client) => {
      const batch = await lockBatch(client, sellerUid, batchId, { open: false });
      if (batch.status === 'submitted') return { already: true, batch };
      if (batch.status !== 'open') throw httpError(409, 'This batch is closed.', { code: 'batch_closed' });
      const rows = (await client.query(
        `select * from public.scan_items where batch_id = $1 and status = 'active' order by position for update`,
        [batch.id],
      )).rows;
      const problems = rows
        .map((row) => ({ itemId: row.id, reason: rules.submitProblem(row, { intent }) }))
        .filter((p) => p.reason);
      if (!rows.length) throw httpError(409, 'Nothing to add.', { code: 'empty_batch' });
      if (problems.length) {
        throw httpError(409, `${problems.length} row(s) need attention before adding.`, {
          code: 'not_ready',
          problems,
        });
      }
      const created = [];
      // Location → Stack → Position. Snapshot may be legacy flat startPosition
      // (treated as absolute) or stack/stackSize/startPosition. Seed from live
      // inventory so a batch that got its box name after scanning continues
      // after slots already taken in that box (not ·1 again).
      let stockRows = [];
      if (writePokoinListings && rows.some((row) => String(row.location || '').trim())) {
        stockRows = (await client.query(
          `select location
             from public.marketplace_user_listings
            where seller_uid = $1
              and status in ('active', 'paused')
              and quantity_available > 0
              and nullif(location, '') is not null`,
          [sellerUid],
        )).rows;
      }
      const slotFor = rules.boxSlots(rows, { stockRows });
      for (const row of rows) {
        let listingId = null;
        let listingStatus = null;
        if (writePokoinListings) {
          const inserted = await client.query(
            `insert into public.marketplace_user_listings (
               card_id, seller_uid, seller_name, condition, language, price_pkn, quantity_available, signed, reverse,
               first_edition, foil_state, graded, grading_company, grade, certification_id, seller_comment, source,
               source_listing_id, card_name, card_image_url, set_name, collector_number, location, altered, status
             ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pokoin_scan_batch',$17,$18,$19,$20,$21,$22,$23,'inactive')
             on conflict (source_listing_id) where source = 'pokoin_scan_batch'
             do update set
               card_id = excluded.card_id,
               seller_name = excluded.seller_name,
               condition = excluded.condition,
               language = excluded.language,
               price_pkn = excluded.price_pkn,
               quantity_available = excluded.quantity_available,
               signed = excluded.signed,
               reverse = excluded.reverse,
               first_edition = excluded.first_edition,
               foil_state = excluded.foil_state,
               graded = excluded.graded,
               grading_company = excluded.grading_company,
               grade = excluded.grade,
               certification_id = excluded.certification_id,
               seller_comment = excluded.seller_comment,
               card_name = excluded.card_name,
               card_image_url = excluded.card_image_url,
               set_name = excluded.set_name,
               collector_number = excluded.collector_number,
               location = excluded.location,
               altered = excluded.altered,
               status = 'inactive',
               updated_at = now()
             where public.marketplace_user_listings.status = 'inactive'
             returning id, status`,
            [
              row.card_id, sellerUid, rules.cleanText(sellerName, 120) || 'Pokoin seller', row.condition, row.language,
              row.price_pkn, row.quantity, row.signed, row.foil_state === 'reverse', row.first_edition, row.foil_state,
              row.graded, row.grading_company, row.grade, row.certification_id, row.seller_comment,
              `scan:${row.id}`, row.card_name || row.card_id, row.image_url, row.set_name || 'Pokemon',
              row.collector_number || row.card_id, listingLocationOf(row, slotFor.get(row.id)), row.altered,
            ],
          );
          listingId = inserted.rows[0]?.id || null;
          listingStatus = inserted.rows[0]?.status || null;
          if (!listingId) {
            const existing = (await client.query(
              `select id, status from public.marketplace_user_listings
               where source = 'pokoin_scan_batch' and source_listing_id = $1`,
              [`scan:${row.id}`],
            )).rows[0];
            listingId = existing?.id || null;
            listingStatus = existing?.status || null;
          }
          if (!listingId) {
            throw httpError(500, 'Listing insert did not return an id.', { code: 'listing_missing' });
          }
          // Only inactive (pending) scan listings may continue while the batch
          // is still open. An already-active row means the batch should already
          // be submitted — fail loud rather than expose a purchasable race.
          if (listingStatus === 'active') {
            throw httpError(409, 'This scan listing is already live; refresh and retry if needed.', {
              code: 'listing_already_active',
              itemId: row.id,
              listingId,
            });
          }
          if (listingStatus !== 'inactive') {
            throw httpError(409, `Scan listing is ${listingStatus || 'unknown'}; cannot finalize.`, {
              code: 'listing_not_pending',
              itemId: row.id,
              listingId,
            });
          }
        }
        created.push({
          itemId: row.id,
          listingId,
          listingStatus,
          cardId: row.card_id,
          quantity: row.quantity,
          row,
        });
      }
      return { already: false, batch, created };
    });

    if (prepared.already) {
      require('./_scan_bus').notifyBatch(batchId);
      return {
        batch: rules.batchView(prepared.batch),
        result: prepared.batch.submit_result,
        alreadySubmitted: true,
      };
    }

    // Phase 2 (Firestore): physical ownership for every intent. Failure leaves
    // the batch open and listings inactive so a retry can converge without a
    // purchasable window. Ownership retries must not rewrite quantity.
    const ownership = [];
    try {
      for (const entry of prepared.created) {
        const written = await upsertScanOwnership({
          uid: sellerUid,
          row: entry.row,
          batchId: prepared.batch.id,
          listingId: entry.listingId,
        });
        ownership.push(written);
      }
    } catch (error) {
      require('./_scan_bus').notifyBatch(batchId);
      throw httpError(503, error.message || 'Collection ownership write failed. Retry submit.', {
        code: error.code || 'ownership_write_failed',
      });
    }

    // Phase 3 (Postgres): activate listings + mark items/batch submitted in
    // ONE transaction. Purchasable ⇒ batch is durably submitted.
    const out = await withTx(pool, async (client) => {
      const batch = await lockBatch(client, sellerUid, batchId, { open: false });
      if (batch.status === 'submitted') return { already: true, batch };
      if (batch.status !== 'open') throw httpError(409, 'This batch is closed.', { code: 'batch_closed' });
      for (const entry of prepared.created) {
        if (writePokoinListings && entry.listingId) {
          const activated = await client.query(
            `update public.marketplace_user_listings
               set status = 'active', updated_at = now()
             where id = $1
               and source = 'pokoin_scan_batch'
               and source_listing_id = $2
               and status = 'inactive'
             returning id`,
            [entry.listingId, `scan:${entry.itemId}`],
          );
          if (!activated.rows[0]) {
            throw httpError(409, 'Could not activate scan listing (not pending).', {
              code: 'listing_activate_failed',
              listingId: entry.listingId,
            });
          }
        }
        const bump = await bumpBatch(client, batch.id);
        await client.query(
          `update public.scan_items set status = 'submitted', listing_id = $2, seq = $3, updated_at = now() where id = $1`,
          [entry.itemId, entry.listingId, bump.seq],
        );
      }
      const result = {
        intent,
        targets,
        listings: writePokoinListings ? prepared.created.length : 0,
        ownership: ownership.length,
        cards: prepared.created.reduce((sum, c) => sum + Number(c.quantity), 0),
        created: prepared.created.map((c) => ({
          itemId: c.itemId,
          listingId: c.listingId,
          cardId: c.cardId,
          quantity: c.quantity,
          ownershipId: `scan:${c.itemId}`,
        })),
        submitKey: key,
      };
      const updated = await client.query(
        `update public.scan_batches
           set status = 'submitted', submit_key = $2, submit_result = $3, submitted_at = now(), updated_at = now()
         where id = $1 returning *`,
        [batch.id, key, result],
      );
      const sessions = await client.query(
        `select id from public.scan_sessions where batch_id = $1 and status <> 'ended'`,
        [batch.id],
      );
      for (const s of sessions.rows) await endSessionRow(client, s.id, 'completed');
      return { batch: updated.rows[0], result };
    });

    require('./_scan_bus').notifyBatch(batchId);
    if (!out.already && writePokoinListings) {
      const cardIds = [...new Set(out.result.created.map((c) => c.cardId))];
      await onListingsCreated(cardIds).catch((error) => {
        console.error('scan submit price summary refresh skipped', { message: error.message });
      });
    }

    let cardtrader = { ok: true, skipped: true, reason: 'not_requested' };
    if (!out.already && intent === 'list' && targets.cardtrader) {
      const { getFirebaseAdmin } = require('./_firebase');
      const firestore = getFirebaseAdmin().firestore();
      const productIds = [];
      const errors = [];
      for (const entry of prepared.created) {
        const row = entry.row;
        try {
          if (entry.listingId) {
            const pushed = await pushAndLinkListing({
              firestore,
              uid: sellerUid,
              listing: {
                id: entry.listingId,
                cardId: row.card_id,
                pricePkn: row.price_pkn,
                quantityAvailable: row.quantity,
                condition: row.condition,
                language: row.language,
                signed: row.signed,
                reverse: row.foil_state === 'reverse',
                firstEdition: row.first_edition,
                foilState: row.foil_state,
                graded: row.graded,
                altered: row.altered,
                sellerComment: row.seller_comment,
              },
            });
            productIds.push(pushed.productId);
          } else {
            const pushed = await pushListingToCardTrader({
              firestore,
              uid: sellerUid,
              listing: {
                cardId: row.card_id,
                pricePkn: row.price_pkn,
                quantityAvailable: row.quantity,
                condition: row.condition,
                language: row.language,
                signed: row.signed,
                reverse: row.foil_state === 'reverse',
                firstEdition: row.first_edition,
                foilState: row.foil_state,
                graded: row.graded,
                altered: row.altered,
                sellerComment: row.seller_comment,
              },
            });
            productIds.push(pushed.productId);
          }
        } catch (error) {
          errors.push({ itemId: entry.itemId, error: error.message || 'CardTrader create failed.' });
        }
      }
      cardtrader = {
        ok: errors.length === 0,
        productIds,
        errors: errors.length ? errors : undefined,
      };
      if (out.result && typeof out.result === 'object') {
        out.result.cardtrader = cardtrader;
        try {
          await pool.query(
            `update public.scan_batches set submit_result = $2, updated_at = now() where id = $1`,
            [batchId, out.result],
          );
        } catch (error) {
          console.error('scan submit cardtrader result persist skipped', { message: error.message });
        }
      }
    }

    const batch = rules.batchView(out.batch);
    return {
      batch,
      result: out.already ? out.batch.submit_result : out.result,
      alreadySubmitted: out.already === true,
      cardtrader,
    };
  }

  async function discardBatch({ sellerUid, batchId }) {
    const batch = await withTx(pool, async (client) => {
      const locked = await lockBatch(client, sellerUid, batchId);
      const sessions = await client.query(
        `select id from public.scan_sessions where batch_id = $1 and status <> 'ended'`,
        [locked.id],
      );
      for (const s of sessions.rows) await endSessionRow(client, s.id, 'discarded');
      return (await client.query(
        `update public.scan_batches set status = 'discarded', updated_at = now() where id = $1 returning *`,
        [locked.id],
      )).rows[0];
    });
    require('./_scan_bus').notifyBatch(batchId);
    return { batch: rules.batchView(batch) };
  }

  async function readImage({ sellerUid, itemId }) {
    if (!rules.isUuid(itemId)) throw httpError(404, 'Image not found.');
    const result = await pool.query(
      'select image from public.scan_items where id = $1 and seller_uid = $2 and image is not null',
      [itemId, sellerUid],
    );
    if (!result.rows[0]) throw httpError(404, 'Image not found.');
    return result.rows[0].image;
  }

  async function purgeExpired() {
    await pool.query("delete from public.scan_pairings where expires_at < now() - interval '5 minutes'");
    await pool.query("delete from public.scan_rate_limits where window_start < now() - interval '1 hour'");
  }

  return {
    startSession,
    regeneratePairing,
    getSession,
    updateSession,
    claimPairing,
    heartbeat,
    leave,
    resolvePrintingsForPhone,
    ingestScan,
    readBatchSnapshot,
    listOpenBatches,
    itemsAfter,
    batchForStream,
    latestSession,
    patchItem,
    removeItem: ({ sellerUid, itemId }) => setStatus({ sellerUid, itemId, from: 'active', to: 'removed' }),
    restoreItem: ({ sellerUid, itemId }) => setStatus({ sellerUid, itemId, from: 'removed', to: 'active' }),
    duplicateItem,
    unmergeItem,
    addManual,
    setDefaults,
    submitBatch,
    discardBatch,
    readImage,
    purgeExpired,
  };
}

// Production card metadata: catalog is static, so the replica is fine here.
async function lookupCardsFromCatalog(cardIds) {
  const ids = [...new Set((cardIds || []).map(rules.cleanCardId).filter(Boolean))];
  if (!ids.length) return new Map();
  const { marketplaceQuery } = require('./_marketplace_db');
  const result = await marketplaceQuery(
    `select v.card_id::text as card_id, v.name, v.expansion_name, v.expansion_number,
            coalesce(nullif(v.cdn_image_url, ''), nullif(v.image_url, ''), '') as image_url,
            coalesce(e.nationality, '') as nationality
     from public.marketplace_card_versions v
     left join public.pokoin_pokemon_expansions e on lower(e.name) = lower(v.expansion_name)
     where v.card_id = any($1::bigint[])`,
    [ids.map(Number)],
  );
  const map = new Map();
  for (const row of result.rows) {
    map.set(String(row.card_id), {
      name: row.name || '',
      setName: row.expansion_name || '',
      number: row.expansion_number || '',
      imageUrl: row.image_url || '',
      nationality: String(row.nationality || '').toLowerCase(),
    });
  }
  return map;
}

// Printings of the hits plus every single-card member of the top hit's CLIP
// artwork (`pokoin_version_sets`, the key GET /api/marketplace-version-set
// reads), with the expansion's print nationality and mark. One indexed query
// on the replica (card_id pkey + version index); energies top out near 130 rows.
const PRINTING_ROWS_SQL = `
  select c.card_id::text as card_id, c.name, c.set_name, c.card_number, c.version,
         coalesce(nullif(c.cdn_image_url, ''), nullif(c.image_url, ''), '') as image_url,
         coalesce(e.nationality, '') as nationality, coalesce(e.kind, '') as kind,
         coalesce(e.code, '') as code, coalesce(e.symbol_image_url, '') as symbol_image_url
  from public.marketplace_search_candidates c
  left join public.pokoin_pokemon_expansions e on lower(e.name) = lower(c.set_name)
  where c.item_kind = 'single'
    and c.product_type = 'card'
    and (
      c.card_id = any($1::bigint[])
      or c.version = (select version from public.marketplace_search_candidates where card_id = $2::bigint)
    )
`;

async function lookupPrintingsFromCatalog(cardIds, topId) {
  const ids = [...new Set((cardIds || []).map(rules.cleanCardId).filter(Boolean))];
  const top = rules.cleanCardId(topId);
  if (!ids.length || !top) return [];
  const { marketplaceQuery } = require('./_marketplace_db');
  const result = await marketplaceQuery(PRINTING_ROWS_SQL, [ids.map(Number), Number(top)]);
  return result.rows;
}

let defaultStore = null;

function getScanStore() {
  if (!defaultStore) {
    const { getMarketplaceWriterPool } = require('./_marketplace_db');
    const { marketplaceWriteQuery } = require('./_marketplace_db');
    defaultStore = createStore({
      pool: getMarketplaceWriterPool(),
      lookupCards: lookupCardsFromCatalog,
      lookupPrintings: lookupPrintingsFromCatalog,
      // Same refresh createListing runs after a POST.
      onListingsCreated: async (cardIds) => {
        for (const cardId of cardIds) {
          await marketplaceWriteQuery('select public.refresh_marketplace_blueprint_price_summary($1)', [cardId]);
        }
      },
    });
  }
  return defaultStore;
}

function setScanStoreForTests(store) {
  defaultStore = store;
}

module.exports = {
  createStore,
  getScanStore,
  setScanStoreForTests,
  lookupCardsFromCatalog,
  lookupPrintingsFromCatalog,
  PRINTING_ROWS_SQL,
  withTx,
};
