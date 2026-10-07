'use strict';

/**
 * Periodic order poll for every connected platform without (reliable)
 * webhooks — Cardmarket, TCGplayer, and Shopify/BinderPOS as a webhook
 * safety net. Runs from pokoin-platform-sync-poll.timer every five minutes.
 *
 * Only individual sold / cancelled order items move stock, each exactly once;
 * an incomplete read changes nothing (docs/PLATFORM_SYNC.md invariants 2 + 4).
 */

async function pollAllIntegrations({ firestore, admin, deps = {} } = {}) {
  const integrations = deps.integrations || require('./_platform_integration');
  const pollProvider = deps.pollProvider || require('./_platform_fanout').pollProvider;
  const rows = await integrations.listEnabledIntegrations(firestore);
  const results = [];
  for (const row of rows) {
    const summary = { uid: row.uid, provider: row.provider };
    if (row.state && row.state !== 'connected') {
      results.push({ ...summary, skipped: true, reason: row.state });
      continue;
    }
    try {
      const result = await pollProvider({ provider: row.provider, sellerUid: row.uid, firestore, admin });
      Object.assign(summary, {
        ok: result.ok !== false,
        skipped: result.skipped === true,
        reason: result.reason || '',
        complete: result.complete,
        applied: result.applied || 0,
      });
    } catch (error) {
      Object.assign(summary, { ok: false, error: String(error.message || error).slice(0, 300) });
    }
    console.log('platform sync poll', summary);
    results.push(summary);
  }
  const attempted = results.filter((row) => !row.skipped);
  return {
    ok: attempted.every((row) => row.ok !== false),
    integrations: results.length,
    failed: attempted.filter((row) => row.ok === false).length,
    allFailed: attempted.length > 0 && attempted.every((row) => row.ok === false),
    results,
  };
}

async function main() {
  const { getFirebaseAdmin } = require('../server/_firebase');
  const admin = getFirebaseAdmin();
  const result = await pollAllIntegrations({ admin, firestore: admin.firestore() });
  console.log(JSON.stringify({
    msg: 'platform sync poll complete',
    ok: result.ok,
    integrations: result.integrations,
    failed: result.failed,
  }));
  // One seller's broken credentials must not mark the whole timer failed.
  if (result.allFailed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('platform sync poll failed', { message: error.message });
    process.exitCode = 1;
  });
}

module.exports = { main, pollAllIntegrations };
