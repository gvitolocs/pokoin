'use strict';

/**
 * Shared stock-import helpers extracted from marketplace-listings-csv.js so the
 * platform inventory import (cardmarket / tcgplayer) can reuse the same
 * catalog resolution and listing insert. No HTTP / Firebase here.
 */

const stock = require('./_stock_csv');

function getQuery(query) {
  if (query) return query;
  return require('./_marketplace_db').marketplaceQuery;
}

function getWriteQuery(query) {
  if (query) return query;
  return require('./_marketplace_db').marketplaceWriteQuery;
}

function cleanText(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

function sellerDisplayName(seller) {
  return cleanText(seller?.name || seller?.email || 'Pokoin seller', 120) || 'Pokoin seller';
}

/**
 * Resolve a normalized import row to a marketplace card_id.
 * Returns { cardId, cardName, setName, collectorNumber, imageUrl } or { error, candidates? }.
 */
async function resolveCard(row, query) {
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

  const result = await getQuery(query)(sql, params).catch(() => ({ rows: [] }));
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

/**
 * Insert one marketplace_user_listings row for a resolved card.
 *
 * @param {object} seller { uid, name?, email? }
 * @param {object} row    normalized import row (name, setName, collectorNumber, condition,
 *                        language, quantity, pricePkn, foilState, location, ...)
 * @param {object} resolved { cardId, cardName, setName, collectorNumber, imageUrl }
 * @param {object} opts   { source, sourceListingId }
 */
async function insertListing(seller, row, resolved, opts = {}, query) {
  const source = cleanText(opts.source, 40) || 'csv_import';
  const sourceListingId = cleanText(opts.sourceListingId, 200) || null;

  // Idempotent: skip if same source id already exists for this seller.
  if (sourceListingId) {
    const existing = await getQuery(query)(
      `
        select id from public.marketplace_user_listings
         where seller_uid = $1 and source = $2 and source_listing_id = $3
         limit 1
     `,
      [seller.uid, source, sourceListingId],
    ).catch(() => ({ rows: [] }));
    if (existing.rows?.[0]) {
      return { skipped: true, id: existing.rows[0].id, reason: 'already_imported' };
    }
  }

  const values = [
    resolved.cardId,
    seller.uid,
    sellerDisplayName(seller),
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
  const result = await getWriteQuery(query)(
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

module.exports = { cleanText, sellerDisplayName, resolveCard, insertListing };
