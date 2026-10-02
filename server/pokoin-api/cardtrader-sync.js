'use strict';

const { getFirebaseAdmin, verifyBearerToken } = require('../server/_firebase');
const { parseEncryptionKey } = require('./_cardtrader_crypto');
const { readIntegrationDoc, safeStatusFromDoc } = require('./_cardtrader_integration');
const {
  reconcileCardTraderInventory,
} = require('./_cardtrader_inventory_sync');
const {
  enqueueCardTraderInventorySync,
  readInventorySyncProgress,
} = require('./_cardtrader_inventory_async');
const { importCsvText } = require('./_stock_csv');
const {
  reconcilePowerToolsWithCardTrader,
  gamesFromCardTraderProducts,
} = require('./_powertools_ct_match');
const { marketplaceGameForProduct, normalizeProduct } = require('./_cardtrader_inventory_sync_core');

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

function powerToolsImportOptions(body = {}) {
  const rawParse = String(body.locationParse || 'auto');
  return {
    format: 'powertools',
    powerToolsSync: true,
    // 0 / missing → importCsvText uses a high ceiling until the seller confirms capacity
    stackSize: Number(body.stackSize) > 0 ? Number(body.stackSize) : 0,
    numberedInStack: body.numberedInStack === true,
    locationParse: ['as_is', 'trailing_stack', 'structured', 'auto'].includes(rawParse)
      ? rawParse
      : 'auto',
    priceMode: body.priceMode || 'eur_to_pkn',
  };
}

function parsePowerToolsByGame(body = {}) {
  const raw = body.powerToolsCsv || body.powerToolsByGame || null;
  if (!raw || typeof raw !== 'object') {
    return {
      byGame: null,
      overflows: [],
      occupancy: [],
      suggestedStackSize: 1,
      locationDetection: null,
    };
  }
  const opts = powerToolsImportOptions(body);
  const out = {};
  const overflows = [];
  const occupancy = [];
  let suggestedStackSize = 1;
  let locationDetection = null;
  for (const [game, csvText] of Object.entries(raw)) {
    const text = String(csvText || '');
    if (!text.trim()) continue;
    const imported = importCsvText(text, opts);
    const rows = imported.results
      .filter((entry) => entry.ok && entry.row)
      .map((entry) => entry.row);
    if (rows.length) out[String(game)] = rows;
    for (const overflow of imported.overflows || []) {
      overflows.push({ game: String(game), ...overflow });
    }
    for (const row of imported.occupancy || []) {
      occupancy.push({ game: String(game), ...row });
    }
    if (Number(imported.suggestedStackSize) > suggestedStackSize) {
      suggestedStackSize = Number(imported.suggestedStackSize);
    }
    if (!locationDetection && imported.locationDetection) {
      locationDetection = imported.locationDetection;
    } else if (imported.locationDetection?.locationExamples?.length) {
      // Merge unique examples across games
      const seen = new Set(locationDetection?.locationExamples || []);
      const merged = [...(locationDetection?.locationExamples || [])];
      for (const ex of imported.locationDetection.locationExamples) {
        if (seen.has(ex) || merged.length >= 6) continue;
        seen.add(ex);
        merged.push(ex);
      }
      locationDetection = {
        ...(locationDetection || imported.locationDetection),
        locationExamples: merged,
        locationParse: locationDetection?.locationParse || imported.locationDetection.locationParse,
      };
    }
  }
  occupancy.sort((a, b) => b.count - a.count || String(a.label || '').localeCompare(String(b.label || '')));
  return {
    byGame: Object.keys(out).length ? out : null,
    overflows,
    occupancy,
    suggestedStackSize: Math.max(1, suggestedStackSize),
    locationDetection,
  };
}

/** Dry-run: map CSV locations + optional CT match samples (no import write). */
async function previewPowerToolsMatch({ firestore, uid, sellerName, body }) {
  const { byGame, overflows, occupancy, suggestedStackSize, locationDetection } = parsePowerToolsByGame(body);
  if (!byGame) {
    return {
      ok: false,
      error: 'Upload at least one Power Tools CSV.',
      samples: [],
      overflows: [],
      occupancy: [],
      suggestedStackSize: 1,
      locationDetection: null,
    };
  }

  let exportProducts = [];
  try {
    const { fetchProductsExport } = require('./_cardtrader_client');
    const { decryptIntegrationToken } = require('./_cardtrader_integration');
    const token = await decryptIntegrationToken(firestore, uid);
    const raw = await fetchProductsExport(token);
    exportProducts = (Array.isArray(raw) ? raw : []).map(normalizeProduct).filter((p) => p.id);
  } catch (_) {
    exportProducts = [];
  }

  const samples = [];
  const byGameProducts = new Map();
  for (const product of exportProducts) {
    const game = marketplaceGameForProduct(product);
    if (!game) continue;
    const bucket = byGameProducts.get(game) || [];
    bucket.push(product);
    byGameProducts.set(game, bucket);
  }

  for (const [game, ptRows] of Object.entries(byGame)) {
    const gameProducts = byGameProducts.get(game) || [];
    const paired = gameProducts.length
      ? reconcilePowerToolsWithCardTrader(gameProducts, ptRows, game)
      : { matched: [], ctOnly: [], ptOnly: ptRows };
    for (const hit of paired.matched.slice(0, 3)) {
      if (samples.length >= 3) break;
      samples.push({
        game,
        name: hit.product.name || hit.powerTools.name,
        condition: hit.product.condition,
        language: hit.product.language,
        reverse: hit.product.reverse === true,
        sourceLocation: hit.powerTools.sourceLocation || hit.powerTools.raw?.location || '',
        location: hit.location,
        matched: true,
      });
    }
    if (samples.length < 3) {
      for (const row of ptRows.slice(0, 3 - samples.length)) {
        samples.push({
          game,
          name: row.name,
          condition: row.condition,
          language: row.language,
          reverse: row.reverse === true,
          sourceLocation: row.sourceLocation || '',
          location: row.location,
          matched: false,
          note: gameProducts.length ? 'No CardTrader twin yet' : 'CardTrader export unavailable for match preview',
        });
      }
    }
    if (samples.length >= 3) break;
  }

  const totalPt = Object.values(byGame).reduce((n, rows) => n + rows.length, 0);
  const resolvedParse = locationDetection?.locationParse
    || powerToolsImportOptions(body).locationParse;
  return {
    ok: true,
    previewPowerTools: true,
    stackSize: Number(body.stackSize) > 0 ? Number(body.stackSize) : suggestedStackSize,
    numberedInStack: powerToolsImportOptions(body).numberedInStack,
    locationParse: resolvedParse === 'auto' ? 'as_is' : resolvedParse,
    totalPowerToolsRows: totalPt,
    samples: samples.slice(0, 3),
    overflows,
    occupancy: occupancy.slice(0, 20),
    suggestedStackSize,
    locationDetection,
    locationExamples: locationDetection?.locationExamples || [],
    games: gamesFromCardTraderProducts(exportProducts, marketplaceGameForProduct),
  };
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
    const previewPowerTools = body.previewPowerTools === true;

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

    if (previewPowerTools) {
      try {
        const preview = await previewPowerToolsMatch({
          firestore,
          uid: decoded.uid,
          sellerName: String(sellerName),
          body,
        });
        return res.status(preview.ok === false ? 400 : 200).json({
          ...preview,
          connected: true,
          status,
        });
      } catch (error) {
        return res.status(error.statusCode || 400).json({
          error: error.message || 'Power Tools preview failed.',
          code: error.code || 'powertools_preview',
        });
      }
    }

    let powerToolsByGame = null;
    let overflows = [];
    try {
      const parsed = parsePowerToolsByGame(body);
      powerToolsByGame = parsed.byGame;
      overflows = parsed.overflows;
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Invalid Power Tools CSV.',
        code: error.code || 'powertools_csv',
      });
    }

    const job = await enqueueCardTraderInventorySync({
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
      overflows,
      error: null,
      summary: { running: true, phase: 'starting', processed: 0, total: 0, overflows },
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
