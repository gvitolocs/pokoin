'use strict';

/**
 * Satellite TCG search/suggest (Magic, One Piece, …) over each game's
 * marketplace_search_candidates. Owned by pokoin-web server/api — deployed to
 * the Pi via scripts/deploy-search-api.sh. Do not edit CardVault copies.
 */

const { marketplaceQuery } = require('./_marketplace_db');
const { toReactCards } = require('./_marketplace_react_card');
const sql = require('./_marketplace_react_sql');

function cleanQuery(value) {
  return String(value || '').trim().slice(0, 180);
}

function cleanProductType(value) {
  return String(value || '').trim().slice(0, 60);
}

/**
 * Match Pokemon marketplace-cards productTypeClause:
 * - productType=card → singles (product_type card), never force item_kind product
 * - productSearchOnly → sealed products + jumbo subtype
 * - other productType → exact product_type
 */
function appendProductUniverse(clauses, values, { productType = '', productSearchOnly = false, term = '' } = {}) {
  const typed = cleanProductType(productType);
  if (productSearchOnly) {
    clauses.push("(c.item_kind = 'product' or c.product_type = 'jumbo')");
    return;
  }
  if (typed) {
    values.push(typed);
    clauses.push(`c.product_type = $${values.length}`);
    return;
  }
  if (!term) {
    clauses.push("c.item_kind = 'single'");
    clauses.push("c.product_type = 'card'");
  }
}

/**
 * Phrase LIKE plus pg_trgm word_similarity so "relity fracture" still hits
 * Reality Fracture set_name / card names (extensions installed on satellite DBs).
 */
function appendSearchMatch(clauses, values, term) {
  const needle = String(term || '').trim().toLowerCase();
  if (!needle) {
    return { likeIdx: 0, termIdx: 0 };
  }
  values.push(`%${needle}%`);
  const likeIdx = values.length;
  values.push(needle);
  const termIdx = values.length;
  clauses.push(`(
        c.search_text like $${likeIdx}
        or word_similarity($${termIdx}, coalesce(c.set_name, '')) > 0.4
        or word_similarity($${termIdx}, coalesce(c.name, '')) > 0.4
      )`);
  return { likeIdx, termIdx };
}

function rankSql(likeIdx, termIdx, { preferSingles = true } = {}) {
  if (!likeIdx || !termIdx) {
    return preferSingles
      ? `case when c.item_kind = 'single' then 0 else 1 end, c.search_weight desc`
      : 'c.search_weight desc';
  }
  const singles = preferSingles
    ? `case when c.item_kind = 'single' then 0 else 1 end,`
    : '';
  return `
        case
          when lower(c.name) = $${termIdx} then 0
          when lower(c.set_name) = $${termIdx} then 1
          when lower(c.name) like $${likeIdx} then 2
          when lower(c.set_name) like $${likeIdx} then 3
          when word_similarity($${termIdx}, coalesce(c.set_name, '')) > 0.4 then 4
          when word_similarity($${termIdx}, coalesce(c.name, '')) > 0.4 then 5
          else 6
        end,
        ${singles}
        c.search_weight desc,
        c.imported_at desc nulls last,
        c.card_id desc
  `;
}

async function rowsForMultigameCards({
  query = '',
  limit = 48,
  offset = 0,
  productType = '',
  productSearchOnly = false,
} = {}) {
  const term = cleanQuery(query);
  const cap = Math.min(Math.max(Number(limit) || 48, 1), 100);
  const skip = Math.max(Number(offset) || 0, 0);
  const values = [];
  const clauses = [
    'coalesce(c.cdn_image_url, c.preview_image_url, c.image_url) is not null',
  ];

  appendProductUniverse(clauses, values, { productType, productSearchOnly, term });
  const { likeIdx, termIdx } = appendSearchMatch(clauses, values, term);
  const preferSingles = !productSearchOnly && cleanProductType(productType) !== 'sealed';

  values.push(cap);
  const lim = values.length;
  values.push(skip);
  const off = values.length;

  const result = await marketplaceQuery(
    `
      select
        c.card_id,
        c.ct_id,
        c.name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.homepage_image_url,
        c.set_name,
        c.rarity,
        c.card_number,
        c.product_variant,
        c.item_kind,
        c.product_type,
        c.imported_at,
        u.canonical_path
      from public.marketplace_search_candidates c
      left join public.marketplace_card_urls u
        on u.card_id = c.card_id and u.language = 'en'
      where ${clauses.join('\n        and ')}
      order by ${rankSql(likeIdx, termIdx, { preferSingles })}
      limit $${lim}
      offset $${off}
    `,
    values,
  );
  return result.rows;
}

async function suggestMultigameGroups(query, groupLimit = 12) {
  const term = cleanQuery(query);
  if (!term) {
    return [];
  }
  const cap = Math.min(Math.max(Number(groupLimit) || 12, 1), 24);
  const values = [];
  const clauses = [
    'coalesce(c.cdn_image_url, c.preview_image_url, c.image_url) is not null',
  ];
  const { likeIdx, termIdx } = appendSearchMatch(clauses, values, term);
  values.push(Math.max(cap * 8, 48));
  const lim = values.length;

  const result = await marketplaceQuery(
    `
      select
        c.card_id,
        c.ct_id,
        c.name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.homepage_image_url,
        c.set_name,
        c.rarity,
        c.card_number,
        c.product_variant,
        c.item_kind,
        c.product_type,
        u.canonical_path
      from public.marketplace_search_candidates c
      left join public.marketplace_card_urls u
        on u.card_id = c.card_id and u.language = 'en'
      where ${clauses.join('\n        and ')}
      order by ${rankSql(likeIdx, termIdx, { preferSingles: true })}
      limit $${lim}
    `,
    values,
  );
  const cards = toReactCards(result.rows);
  const groups = [];
  const byName = new Map();
  for (const card of cards) {
    const key = String(card.name || '').toLowerCase();
    if (!key) continue;
    let group = byName.get(key);
    if (!group) {
      if (groups.length >= cap) continue;
      group = {
        name: card.name,
        printings: [],
      };
      byName.set(key, group);
      groups.push(group);
    }
    if (group.printings.length < 6) {
      group.printings.push(card);
    }
  }
  return groups;
}

async function loadMultigameCardPage(cardId) {
  const row = await sql.readCandidateByCardId(cardId);
  if (!row) {
    return null;
  }
  const siblings = await sql.readSetSiblings(row, 8);
  const siblingPaths = await sql.readCanonicalPaths([
    cardId,
    ...siblings.map((entry) => entry.card_id),
  ]);
  const neighbors = await sql.readSetNeighbors(row.set_name, cardId, 3);
  const emptyCheapest = { byCardId: new Map(), byBlueprint: new Map() };
  return {
    row: sql.applyCanonicalAndCheapest([row], siblingPaths, emptyCheapest)[0],
    siblings: sql.applyCanonicalAndCheapest(siblings, siblingPaths, emptyCheapest),
    neighbors,
  };
}

module.exports = {
  rowsForMultigameCards,
  suggestMultigameGroups,
  loadMultigameCardPage,
  // test hooks
  appendProductUniverse,
  appendSearchMatch,
  cleanQuery,
};
