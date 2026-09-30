'use strict';

/**
 * Seller stock CSV import / export (PowerTools, Cardmarket, CardTrader).
 * GET  ?format=powertools|cardmarket|cardtrader  → CSV file
 * POST { format?, stackSize?, priceMode?, dryRun?, csv } → JSON preview/result
 */

const { marketplaceQuery, marketplaceWriteQuery } = require('./_marketplace_db');
const { verifyBearerToken } = require('./_firebase');
const stock = require('./_stock_csv');

function cleanText(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

function sellerDisplayName(decoded) {
  return cleanText(decoded?.name || decoded?.email || 'Pokoin seller', 120) || 'Pokoin seller';
}

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

/**
 * Resolve a normalized import row to a marketplace card_id.
 * Returns { cardId, cardName, setName, collectorNumber, imageUrl } or { error }.
 */
async function resolveCard(row) {
  const name = cleanText(row.name, 240);
  const cn = cleanText(row.collectorNumber, 40);
  const setName = cleanText(row.setName, 240);
  if (!name) return { error: 'Missing card name' };

  // Prefer exact name + collector (strip /total and "Holo Rare |" prefixes).
  const cnCore = cn.replace(/^.*\|\s*/, '').replace(/\/\d+.*$/, '').trim();
  const params = [name];
  let sql = `
    select card_id, name, set_name, card_number, image_url, cdn_image_url
      from public.marketplace_cards
     where name = $1
       and set_name not ilike '%Poké Ball%'
       and set_name not ilike '%Master Ball%'
  `;
  if (cnCore) {
    params.push(cnCore);
    sql += ` and (
      card_number = $2
      or card_number like $2 || '/%'
      or card_number like '%| ' || $2
      or card_number like '%| ' || $2 || '/%'
    )`;
  }
  if (setName) {
    params.push(`%${setName}%`);
    sql += ` order by case when set_name ilike $${params.length} then 0 else 1 end, card_id`;
  } else {
    sql += ' order by card_id';
  }
  sql += ' limit 5';

  const result = await marketplaceQuery(sql, params).catch(() => ({ rows: [] }));
  const rows = result.rows || [];
  if (!rows.length) return { error: `No catalog match for ${name} ${cn}`.trim() };
  if (rows.length > 1 && setName) {
    const narrowed = rows.filter((r) => String(r.set_name || '').toLowerCase().includes(setName.toLowerCase()));
    if (narrowed.length === 1) {
      const hit = narrowed[0];
      return {
        cardId: String(hit.card_id),
        cardName: hit.name,
        setName: hit.set_name,
        collectorNumber: hit.card_number,
        imageUrl: hit.cdn_image_url || hit.image_url || '',
      };
    }
    if (narrowed.length !== 1 && rows.length > 1) {
      return {
        error: `Ambiguous match for ${name} (${rows.map((r) => r.card_id).join(', ')})`,
        candidates: rows.map((r) => ({ cardId: String(r.card_id), setName: r.set_name, number: r.card_number })),
      };
    }
  }
  if (rows.length > 1) {
    return {
      error: `Ambiguous match for ${name} (${rows.map((r) => r.card_id).join(', ')})`,
      candidates: rows.map((r) => ({ cardId: String(r.card_id), setName: r.set_name, number: r.card_number })),
    };
  }
  const hit = rows[0];
  return {
    cardId: String(hit.card_id),
    cardName: hit.name,
    setName: hit.set_name,
    collectorNumber: hit.card_number,
    imageUrl: hit.cdn_image_url || hit.image_url || '',
  };
}

async function insertListing(decoded, row, resolved, format) {
  const source = stock.sourceForFormat(format);
  const sourceListingId = stock.sourceListingIdFor(format, row);
  // Idempotent: skip if same source id already exists for this seller.
  if (sourceListingId) {
    const existing = await marketplaceQuery(
      `
        select id from public.marketplace_user_listings
         where seller_uid = $1 and source = $2 and source_listing_id = $3
         limit 1
      `,
      [decoded.uid, source, sourceListingId],
    ).catch(() => ({ rows: [] }));
    if (existing.rows?.[0]) {
      return { skipped: true, id: existing.rows[0].id, reason: 'already_imported' };
    }
  }

  const values = [
    resolved.cardId,
    decoded.uid,
    sellerDisplayName(decoded),
    'EU',
    'New',
    row.condition || 'NM',
    row.language || 'EN',
    row.pricePkn,
    row.quantity || 1,
    row.signed === true,
    row.reverse === true,
    row.firstEdition === true,
    row.foilState || 'standard',
    row.variantState || '',
    false,
    false,
    null,
    null,
    null,
    true,
    false,
    false,
    row.sellerComment || '',
    source,
    sourceListingId,
    resolved.cardName || row.name,
    resolved.imageUrl || '',
    resolved.setName || row.setName || 'Pokemon',
    resolved.collectorNumber || row.collectorNumber || resolved.cardId,
    row.location || '',
    row.altered === true,
  ];
  const result = await marketplaceWriteQuery(
    `
      insert into public.marketplace_user_listings (
        card_id, seller_uid, seller_name, seller_country, seller_reputation_label,
        condition, language, price_pkn, quantity_available, signed, reverse,
        first_edition, foil_state, variant_state, sealed, graded,
        grading_company, grade, certification_id, shipping_available,
        reserve_available, nft_available, seller_comment, source,
        source_listing_id, card_name, card_image_url, set_name, collector_number,
        location, altered
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31
      )
      returning id, card_id, location
    `,
    values,
  );
  return { created: true, id: result.rows[0]?.id, cardId: result.rows[0]?.card_id, location: result.rows[0]?.location };
}

async function handleExport(req, res, decoded) {
  const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
  const format = cleanText(url.searchParams.get('format'), 40) || 'powertools';
  if (!stock.FORMATS.includes(format)) {
    return res.status(400).json({ error: 'format must be powertools, cardmarket, or cardtrader.' });
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

  let parsed;
  try {
    parsed = stock.importCsvText(csvText, { format: formatOpt, stackSize, priceMode });
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
      const out = await insertListing(decoded, row, resolved, parsed.format);
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
