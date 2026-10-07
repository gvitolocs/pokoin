'use strict';

/**
 * Seller stock CSV import / export (PowerTools, Cardmarket, CardTrader).
 * GET  ?format=powertools|cardmarket|cardtrader  → CSV file
 * POST { format?, stackSize?, priceMode?, dryRun?, csv } → JSON preview/result
 */

const { marketplaceQuery } = require('./_marketplace_db');
const { verifyBearerToken } = require('./_firebase');
const stock = require('./_stock_csv');
const { cleanText, resolveCard, insertListing } = require('./_stock_listing_import');

async function loadSellerListings(uid) {
  const result = await marketplaceQuery(
    `
      select *
        from public.marketplace_user_listings
       where seller_uid = $1
         and status in ('active', 'paused', 'inactive')
       order by updated_at desc
       limit 10000
    `,
    [uid],
  );
  return (result.rows || []).map((row) => ({
    id: row.id,
    cardId: row.card_id,
    cardName: row.card_name,
    setName: row.set_name,
    collectorNumber: row.collector_number,
    condition: row.condition,
    language: row.language,
    pricePkn: Number(row.price_pkn),
    quantityAvailable: Number(row.quantity_available),
    signed: row.signed === true,
    reverse: row.reverse === true,
    firstEdition: row.first_edition === true,
    foilState: row.foil_state,
    variantState: row.variant_state,
    altered: row.altered === true,
    sellerComment: row.seller_comment,
    location: row.location,
    source: row.source,
    sourceListingId: row.source_listing_id,
    blueprintId: row.card_id,
    cardmarketId: '',
  }));
}

async function handleExport(req, res, decoded) {
  const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
  const format = cleanText(url.searchParams.get('format'), 40) || 'powertools';
  if (!stock.FORMATS.includes(format)) {
    return res.status(400).json({ error: 'format must be powertools, cardmarket, cardtrader, or tcgplayer.' });
  }
  const listings = await loadSellerListings(decoded.uid);
  const body = stock.exportListingsCsv(format, listings);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="pokoin-stock-${format}.csv"`);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).send(body);
}

async function handleImport(req, res, decoded) {
  const body = req.body || {};
  const csvText = typeof body.csv === 'string' ? body.csv : '';
  if (!csvText.trim()) {
    return res.status(400).json({ error: 'Missing csv text.' });
  }
  const stackSize = Math.max(1, Math.trunc(Number(body.stackSize)) || 1);
  const priceMode = cleanText(body.priceMode, 40) || 'eur_to_pkn';
  const dryRun = body.dryRun !== false; // default dry-run for safety
  const formatOpt = cleanText(body.format, 40) || undefined;
  const preserveLocation = body.preserveLocation === true;
  const cardtraderIntent = cleanText(body.cardtraderIntent, 20) === 'link' ? 'link' : cleanText(body.cardtraderIntent, 20) === 'import' ? 'import' : '';

  let parsed;
  try {
    parsed = stock.importCsvText(csvText, { format: formatOpt, stackSize, priceMode, preserveLocation });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message || 'CSV parse failed.' });
  }

  const created = [];
  const skipped = [];
  const failed = [];
  const preview = [];

  for (const entry of parsed.results) {
    if (!entry.ok) {
      failed.push({ line: entry.index, error: entry.error, raw: entry.raw });
      continue;
    }
    const row = entry.row;
    if (row.pricePkn == null || !(row.pricePkn > 0)) {
      failed.push({ line: entry.index, error: 'Invalid or missing price', raw: entry.raw, row });
      continue;
    }
    const resolved = await resolveCard(row);
    if (resolved.error) {
      failed.push({
        line: entry.index,
        error: resolved.error,
        candidates: resolved.candidates || [],
        raw: entry.raw,
        row,
      });
      continue;
    }
    if (dryRun) {
      preview.push({
        line: entry.index,
        cardId: resolved.cardId,
        name: resolved.cardName,
        location: row.location,
        condition: row.condition,
        language: row.language,
        pricePkn: row.pricePkn,
        quantity: row.quantity,
      });
      continue;
    }
    try {
      const out = await insertListing(decoded, row, resolved, {
        source: stock.sourceForFormat(parsed.format, cardtraderIntent),
        sourceListingId: stock.sourceListingIdFor(parsed.format, row),
      });
      if (out.skipped) skipped.push({ line: entry.index, ...out });
      else created.push({ line: entry.index, ...out });
    } catch (error) {
      failed.push({ line: entry.index, error: error.message || 'Insert failed', raw: entry.raw, row });
    }
  }

  const failedCsv = failed.length
    ? stock.toCsv(
      [...stock.headersFor(parsed.format), 'importError'],
      failed.map((f) => ({ ...(f.raw || {}), importError: f.error })),
    )
    : '';

  return res.status(200).json({
    format: parsed.format,
    dryRun,
    stackSize,
    priceMode,
    counts: {
      total: parsed.results.length,
      preview: preview.length,
      created: created.length,
      skipped: skipped.length,
      failed: failed.length,
    },
    preview,
    created,
    skipped,
    failed,
    failedCsv,
  });
}

module.exports = async function handler(req, res) {
  try {
    const decoded = await verifyBearerToken(req);
    if (req.method === 'GET') return handleExport(req, res, decoded);
    if (req.method === 'POST') return handleImport(req, res, decoded);
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (error) {
    console.error('marketplace-listings-csv failed', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Stock CSV failed.',
    });
  }
};

module.exports._test = { resolveCard, loadSellerListings };
