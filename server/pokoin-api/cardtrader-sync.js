'use strict';

const { getFirebaseAdmin, verifyBearerToken } = require('../server/_firebase');
const { parseEncryptionKey } = require('./_cardtrader_crypto');
const { readIntegrationDoc, safeStatusFromDoc } = require('./_cardtrader_integration');
const {
  readSellerSync,
  reconcileCardTraderInventory,
} = require('./_cardtrader_inventory_sync');
const {
  enqueueCardTraderInventorySync,
  readInventorySyncProgress,
} = require('./_cardtrader_inventory_async');
const { importCsvText } = require('./_stock_csv');

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

function parsePowerToolsByGame(body = {}) {
  const raw = body.powerToolsCsv || body.powerToolsByGame || null;
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const [game, csvText] of Object.entries(raw)) {
    const text = String(csvText || '');
    if (!text.trim()) continue;
    const imported = importCsvText(text, {
      format: 'powertools',
      stackSize: Number(body.stackSize) > 0 ? Number(body.stackSize) : 1,
      priceMode: body.priceMode || 'eur_to_pkn',
    });
    const rows = imported.results
      .filter((entry) => entry.ok && entry.row)
      .map((entry) => entry.row);
    if (rows.length) out[String(game)] = rows;
  }
  return Object.keys(out).length ? out : null;
}

module.exports = async function handler(req, res) {
  setNoStore(res);
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    parseEncryptionKey();
    const decoded = await verifyBearerToken(req);
    const admin = getFirebaseAdmin();
    const firestore = admin.firestore();

    if (req.method === 'GET') {
      const doc = await readIntegrationDoc(firestore, decoded.uid);
      const status = safeStatusFromDoc(doc);
      const progress = await readInventorySyncProgress(decoded.uid);
      const sync = progress.row;
      return res.status(200).json({
        ok: true,
        status,
        running: progress.running,
        phase: progress.phase || null,
        processed: progress.processed,
        total: progress.total,
        sync: sync
          ? {
            lastSyncAt: sync.last_sync_at,
            lastSyncOk: sync.last_sync_ok,
            lastSyncIncomplete: sync.last_sync_incomplete,
            lastSyncError: sync.last_sync_error,
            lastCompleteExportAt: sync.last_complete_export_at,
            lastExportProductCount: sync.last_export_product_count,
            summary: sync.last_sync_summary || {},
            running: progress.running,
            phase: progress.phase || null,
            processed: progress.processed,
            total: progress.total,
          }
          : {
            running: progress.running,
            phase: progress.phase || null,
            processed: progress.processed,
            total: progress.total,
            summary: progress.summary || {},
          },
      });
    }

    const doc = await readIntegrationDoc(firestore, decoded.uid);
    const status = safeStatusFromDoc(doc);
    if (!status?.connected) {
      return res.status(400).json({ error: 'Connect CardTrader before syncing inventory.' });
    }

    const sellerName = status?.metadata?.user?.username
      || status?.metadata?.seller?.name
      || decoded.name
      || decoded.email
      || 'Pokoin seller';

    const body = req.body || {};
    const previewGamesOnly = body.previewGames === true || body.previewGamesOnly === true;

    // Game preview is synchronous so the Power Tools upload UI can list TCGs.
    if (previewGamesOnly) {
      const preview = await reconcileCardTraderInventory({
        firestore,
        uid: decoded.uid,
        sellerName: String(sellerName),
        previewGamesOnly: true,
      });
      return res.status(200).json({
        ok: preview.ok !== false,
        connected: true,
        previewGamesOnly: true,
        games: preview.games || [],
        summary: preview.summary || {},
        status,
      });
    }

    let powerToolsByGame = null;
    try {
      powerToolsByGame = parsePowerToolsByGame(body);
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Invalid Power Tools CSV.',
        code: error.code || 'powertools_csv',
      });
    }

    const job = enqueueCardTraderInventorySync({
      firestore,
      uid: decoded.uid,
      sellerName: String(sellerName),
      powerToolsByGame,
    });

    return res.status(200).json({
      ok: true,
      connected: true,
      async: true,
      started: job.started,
      alreadyRunning: job.alreadyRunning,
      running: true,
      incomplete: true,
      destructiveSkipped: false,
      powerTools: Boolean(powerToolsByGame),
      error: null,
      summary: { running: true, phase: 'starting', processed: 0, total: 0 },
      status,
    });
  } catch (error) {
    console.error('cardtrader-sync failed', {
      code: error.code || '',
      statusCode: error.statusCode || 500,
      message: error.message,
    });
    return res.status(error.statusCode || 500).json({
      error: error.message || 'CardTrader sync failed.',
      code: error.code,
    });
  }
};
