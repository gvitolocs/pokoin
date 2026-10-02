'use strict';

const { canonicalPathForRow } = require('./_marketplace_canonical_path');
const { effectivePrintBucket, printBucket } = require('./_print_bucket');

function isPreviewPath(value) {
  const text = String(value || '');
  return (
    /\/previews\//i.test(text) ||
    /\/preview_/i.test(text) ||
    /(?:^|\/)preview_[^/?#]+\.(?:jpe?g|png|webp)(?:\?|$)/i.test(text)
  );
}

function preferFullImage(row = {}) {
  const candidates = [
    row.cdn_image_url,
    row.image_url,
    row.cdnImageUrl,
    row.imageUrl,
  ];
  for (const candidate of candidates) {
    const url = String(candidate || '').trim();
    if (url && !isPreviewPath(url)) {
      return url;
    }
  }
  for (const candidate of candidates) {
    const url = String(candidate || '').trim();
    if (url) {
      return url;
    }
  }
  return '';
}

function meiliMarketplaceIndexSettings() {
  return {
    searchableAttributes: [
      'name',
      'name_normalized',
      'name_compact',
      'name_group',
      'nicknames',
      'card_number',
      'expansion_name',
      'set_name',
      'expansion_aliases',
      'variation_tokens',
    ],
    displayedAttributes: [
      'doc_id',
      'card_id',
      'language',
      'name',
      'name_group',
      'name_normalized',
      'name_compact',
      'card_number',
      'rarity',
      'set_name',
      'expansion_name',
      'expansion_aliases',
      'nicknames',
      'variation_tokens',
      'cdn_image_url',
      'canonical_path',
      'search_weight',
      'updated_at_epoch',
      'nationality',
      'effective_print_bucket',
    ],
    filterableAttributes: ['language', 'card_id', 'name_group', 'effective_print_bucket', 'nationality'],
    sortableAttributes: ['search_weight', 'updated_at_epoch'],
    rankingRules: [
      'words',
      'typo',
      'proximity',
      'attribute',
      'exactness',
      // Catalog interestingness. Ties on prefixes (mimik); suggest reranks groups.
      // docs/marketplace-search-ranking.md
      'search_weight:desc',
    ],
    typoTolerance: { enabled: true },
    pagination: { maxTotalHits: 1000 },
  };
}

const MARKETPLACE_MEILI_SYNC_SELECT = `
      select
        c.card_id,
        'en'::text as language,
        c.name,
        public.marketplace_search_normalize(c.name) as name_normalized,
        public.marketplace_search_compact(c.name) as name_compact,
        c.set_name,
        c.expansion_name,
        c.card_number,
        c.rarity,
        c.cdn_image_url,
        c.image_url,
        coalesce((
          select e.nationality
          from public.pokoin_pokemon_expansions e
          where e.name = c.set_name
             or e.normalized_name = public.marketplace_search_normalize(c.set_name)
          order by case when e.name = c.set_name then 0 else 1 end
          limit 1
        ), '') as nationality,
        coalesce((
          select array_agg(alias_rows.normalized_alias order by alias_rows.min_priority asc)
          from (
            select
              ea.normalized_alias,
              min(ea.priority) as min_priority
            from public.marketplace_expansion_aliases ea
            where ea.normalized_expansion_name = public.marketplace_search_normalize(c.expansion_name)
            group by ea.normalized_alias
          ) alias_rows
        ), '{}'::text[]) as expansion_aliases,
        coalesce(cv.variation_tokens, '{}'::text[]) as variation_tokens,
        coalesce((
          select array_agg(alias order by alias)
          from (
            select unnest(coalesce(cn.nicknames, '{}'::text[])) as alias
            union
            select l.localized_name
            from public.card_name_languages l
            where l.name = c.name
              and l.language <> 'en'
              and l.localized_name <> ''
              and l.localized_name is distinct from c.name
          ) nick
        ), '{}'::text[]) as nicknames,
        c.search_weight,
        extract(epoch from coalesce(c.projected_at, c.imported_at, now()))::bigint as updated_at_epoch
      from public.marketplace_search_candidates c
      left join lateral (
        select array_agg(distinct v.variation_key order by v.variation_key) as variation_tokens
        from public.marketplace_card_variations v
        where v.card_id = c.card_id
      ) cv on true
      left join lateral (
        select array_agg(h.nickname order by h.nickname) as nicknames
        from public.marketplace_card_nickname_hits h
        where h.card_id = c.card_id
      ) cn on true
`;

function mapMarketplaceMeiliDoc(row = {}) {
  const name = String(row.name || '').trim();
  const setName = String(row.set_name || row.expansion_name || '').trim();
  const nationality = String(row.nationality || '').trim().toLowerCase();
  const mapped = {
    doc_id: `${row.language || 'en'}_${row.card_id}`,
    card_id: String(row.card_id || ''),
    language: row.language || 'en',
    name,
    name_group: name,
    name_normalized: row.name_normalized || '',
    name_compact: row.name_compact || '',
    card_number: String(row.card_number || '').trim(),
    rarity: String(row.rarity || '').trim(),
    set_name: setName,
    expansion_name: String(row.expansion_name || setName).trim(),
    expansion_aliases: Array.isArray(row.expansion_aliases) ? row.expansion_aliases : [],
    nicknames: Array.isArray(row.nicknames) ? row.nicknames : [],
    variation_tokens: Array.isArray(row.variation_tokens) ? row.variation_tokens : [],
    cdn_image_url: preferFullImage(row),
    search_weight: Number(row.search_weight || 0),
    updated_at_epoch: Number(row.updated_at_epoch || 0),
    nationality,
    // Canonical search universe. Empty expansion nationality → unknown, never western.
    effective_print_bucket: effectivePrintBucket({ nationality, set: setName }),
  };
  mapped.canonical_path = canonicalPathForRow({
    card_id: mapped.card_id,
    name: mapped.name,
    card_number: mapped.card_number,
    set_name: mapped.set_name,
    rarity: mapped.rarity,
  });
  return mapped;
}

module.exports = {
  isPreviewPath,
  preferFullImage,
  meiliMarketplaceIndexSettings,
  MARKETPLACE_MEILI_SYNC_SELECT,
  mapMarketplaceMeiliDoc,
  printBucket,
  effectivePrintBucket,
};
