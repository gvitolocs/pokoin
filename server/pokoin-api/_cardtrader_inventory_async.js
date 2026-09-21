'use strict';

/**
 * Background CardTrader inventory sync jobs.
 * Connect/sync return immediately; progress lives in seller_sync.last_sync_summary.
 */

const {
  reconcileCardTraderInventory,
  recordSellerSync,
  readSellerSync,
} = require('./_cardtrader_inventory_sync');

const running = new Map(); // sellerUid -> { promise, startedAt }

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function progressSummary(partial = {}) {
  return {
    running: true,
    phase: cleanText(partial.phase, 40) || 'starting',
    processed: Math.max(0, Math.trunc(Number(partial.processed) || 0)),
    total: Math.max(0, Math.trunc(Number(partial.total) || 0)),
    imported: Math.max(0, Math.trunc(Number(partial.imported) || 0)),
    updated: Math.max(0, Math.trunc(Number(partial.updated) || 0)),
    matchedExisting: Math.max(0, Math.trunc(Number(partial.matchedExisting) || 0)),
    pokemonInventory: Math.max(0, Math.trunc(Number(partial.pokemonInventory) || 0)),
    inventory: Math.max(0, Math.trunc(Number(partial.inventory) || 0)),
  };
}

async function markRunning(sellerUid, partial) {
  await recordSellerSync(sellerUid, {
    ok: false,
    incomplete: true,
    error: '',
    summary: progressSummary(partial),
    complete: false,
    exportCount: Math.max(0, Math.trunc(Number(partial.total) || 0)),
  });
}

/**
 * Start a background reconcile. Safe to call twice — second call is a no-op.
 * @returns {{ started: boolean, alreadyRunning: boolean }}
 */
function enqueueCardTraderInventorySync(args = {}) {
  const sellerUid = cleanText(args.uid, 160);
  if (!sellerUid) {
    const error = new Error('Missing seller uid.');
    error.statusCode = 400;
    throw error;
  }
  if (running.has(sellerUid)) {
    return { started: false, alreadyRunning: true };
  }

  const startedAt = Date.now();
  const promise = (async () => {
    await markRunning(sellerUid, { phase: 'starting', processed: 0, total: 0 });
    let lastWrite = 0;
    const result = await reconcileCardTraderInventory({
      ...args,
      uid: sellerUid,
      onProgress: async (partial) => {
        const now = Date.now();
        // Throttle progress writes (~4/sec) so PG isn't the progress bottleneck.
        if (now - lastWrite < 250 && partial.phase === 'import' && partial.processed < partial.total) {
          return;
        }
        lastWrite = now;
        await markRunning(sellerUid, partial);
      },
    });
    return result;
  })()
    .catch(async (error) => {
      console.error('cardtrader inventory sync job failed', {
        uid: sellerUid,
        message: error.message,
      });
      try {
        await recordSellerSync(sellerUid, {
          ok: false,
          incomplete: true,
          error: error.message || 'CardTrader inventory sync failed.',
          summary: {
            running: false,
            phase: 'failed',
            processed: 0,
            total: 0,
          },
          complete: false,
        });
      } catch (_) {
        // ignore secondary write failures
      }
      return {
        ok: false,
        incomplete: true,
        error: error.message || 'CardTrader inventory sync failed.',
      };
    })
    .finally(() => {
      running.delete(sellerUid);
    });

  running.set(sellerUid, { promise, startedAt });
  return { started: true, alreadyRunning: false };
}

function isInventorySyncRunning(sellerUid) {
  return running.has(cleanText(sellerUid, 160));
}

async function readInventorySyncProgress(sellerUid) {
  const row = await readSellerSync(sellerUid);
  const summary = row?.last_sync_summary || {};
  const live = isInventorySyncRunning(sellerUid);
  const flagged = summary && summary.running === true;
  return {
    row,
    running: live || flagged,
    phase: summary.phase || (live ? 'running' : ''),
    processed: Number(summary.processed || 0),
    total: Number(summary.total || 0),
    summary,
  };
}

module.exports = {
  enqueueCardTraderInventorySync,
  isInventorySyncRunning,
  readInventorySyncProgress,
};
