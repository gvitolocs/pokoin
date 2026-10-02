'use strict';

const { canonicalPathForRow } = require('./_marketplace_canonical_path');
const { preferFullImage } = require('./_meili_document');
const { hasCollectorNumber } = require('./_marketplace_row');

// Popup group order (base name before GX on a plain prefix).
// Catalog search_weight is only an intra-tier tie-break.
// docs/marketplace-search-ranking.md

const VARIANT_WORDS = new Set([
  'ex',
  'v',
  'vmax',
  'vstar',
  'gx',
  'lvx',
  'lv',
  'mega',
  'break',
  'radiant',
  'shining',
  'shiny',
  'prime',
  'tagteam',
]);

const PRODUCT_WORDS = new Set([
  'collection',
  'pin',
  'coin',
  'tin',
  'box',
  'bundle',
  'deck',
  'etb',
  'pack',
  'premium',
  'merchandise',
  'blister',
  'case',
  'display',
  'figure',
  'plush',
]);

function nameWords(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/v\s*[-.]?\s*star/g, 'vstar')
    .replace(/lv\s*\.?\s*x/g, 'lvx')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function compactName(value) {
  return nameWords(value).join('');
}

function isVariantPrefixToken(token) {
  const text = String(token || '');
  if (!text) {
    return false;
  }
  return [...VARIANT_WORDS].some((word) => word === text || word.startsWith(text));
}

function leftoverQueryTokens(query, groupName) {
  const unusedNameWords = [...nameWords(groupName)];
  const leftover = [];
  for (const word of nameWords(query)) {
    const index = unusedNameWords.findIndex((nameWord) => (
      nameWord === word
      || nameWord.startsWith(word)
      || word.startsWith(nameWord)
    ));
    if (index >= 0) {
      unusedNameWords.splice(index, 1);
    } else {
      leftover.push(word);
    }
  }
  return leftover;
}

function suggestGroupTier(query, groupName) {
  const q = compactName(query);
  const n = compactName(groupName);
  if (!q || !n) {
    return 50;
  }
  const nWords = nameWords(groupName);
  const nameIsVariant = nWords.some((word) => VARIANT_WORDS.has(word));
  const nameIsProduct = nWords.some((word) => PRODUCT_WORDS.has(word));
  const leftover = leftoverQueryTokens(query, groupName);
  const leftoverIsVariantPrefix = leftover.some(isVariantPrefixToken);

  if (n === q) {
    return 0;
  }
  // Query is still inside the card name: "mimikyu g" continues into "Mimikyu GX".
  if (n.startsWith(q)) {
    if (nameIsProduct) {
      return 4;
    }
    if (nameIsVariant) {
      return leftover.length === 0 || leftoverIsVariantPrefix ? 1 : 3;
    }
    return 1;
  }
  // Extra query tokens beyond this group name.
  if (q.startsWith(n)) {
    if (leftoverIsVariantPrefix) {
      return 5;
    }
    if (nameIsProduct) {
      return 4;
    }
    if (!nameIsVariant) {
      return 2;
    }
    return 3;
  }
  return 6;
}

function nicknameMatchTier(query, nicknames = []) {
  const q = compactName(query);
  if (!q) {
    return 50;
  }
  let best = 50;
  for (const nickname of nicknames) {
    const n = compactName(nickname);
    if (!n) {
      continue;
    }
    if (n === q) {
      return 0;
    }
    if (q.length >= 4 && n.startsWith(q) && best > 1) {
      best = 1;
    }
  }
  return best;
}

function suggestGroupSortKey(query, group) {
  const name = String(group?.name || '');
  const compact = compactName(name);
  const weight = Number(group?._weight || 0);
  const nameTier = suggestGroupTier(query, name);
  const nickTier = nicknameMatchTier(query, group?._nicknames || []);
  return {
    tier: Math.min(nameTier, nickTier),
    length: compact.length,
    weight: -weight,
    name,
  };
}

function sortSuggestGroups(groups, query) {
  const q = String(query || '').trim();
  if (!q) {
    return groups;
  }
  return [...groups].sort((left, right) => {
    const a = suggestGroupSortKey(q, left);
    const b = suggestGroupSortKey(q, right);
    return a.tier - b.tier
      || a.length - b.length
      || a.weight - b.weight
      || a.name.localeCompare(b.name);
  });
}

function printingAliasCompacts(printing) {
  const aliases = Array.isArray(printing?._aliases) ? printing._aliases : [];
  return aliases.map((value) => compactName(value)).filter(Boolean);
}

function suggestPrintingSortScore(query, groupName, printing) {
  const leftover = leftoverQueryTokens(query, groupName);
  if (!leftover.length) {
    return 0;
  }
  const nameTokens = nameWords(printing?.name);
  const setTokens = nameWords(printing?.set || printing?.set_name);
  const setCompact = compactName(printing?.set || printing?.set_name);
  const aliases = printingAliasCompacts(printing);
  const number = String(printing?.number || printing?.card_number || '').toLowerCase();
  let score = 0;
  for (const token of leftover) {
    const variantish = isVariantPrefixToken(token);
    const nameHit = nameTokens.some((word) => word === token || word.startsWith(token));
    const numberHit = number.includes(token);
    const aliasExact = aliases.includes(token) || aliases.some((alias) => alias === compactName(token));
    const aliasPrefix = token.length >= 2 && aliases.some((alias) => alias.startsWith(token));
    const setCompactHit = token.length >= 2 && setCompact.startsWith(token);
    const setHit = setTokens.some((word) => word === token || word.startsWith(token));
    if (nameHit) {
      score -= 100;
    } else if (aliasExact) {
      score -= 80;
    } else if (aliasPrefix) {
      score -= 50;
    } else if (numberHit) {
      score -= 40;
    } else if ((setHit || setCompactHit) && variantish) {
      score += 25;
    } else if (setCompactHit) {
      score -= 40;
    } else if (setHit && token.length >= 2) {
      score -= 10;
    }
  }
  return score;
}

function sortSuggestPrintings(printings, query, groupName) {
  const q = String(query || '').trim();
  if (!q) {
    return printings;
  }
  return [...printings].sort((left, right) => (
    suggestPrintingSortScore(q, groupName, left)
    - suggestPrintingSortScore(q, groupName, right)
    || String(left.number || '').localeCompare(String(right.number || ''))
  ));
}

function mapSuggestPrinting(hit = {}) {
  const id = String(hit.card_id || hit.id || '').trim();
  const name = String(hit.name || '').trim();
  const setName = String(hit.set_name || hit.expansion_name || hit.set || '').trim();
  const number = String(hit.card_number || hit.number || '').trim();
  const rarity = String(hit.rarity || '').trim();
  const href = String(hit.canonical_path || hit.canonicalPath || '').trim()
    || canonicalPathForRow({
      card_id: id,
      name,
      card_number: number,
      set_name: setName,
      rarity,
    });
  const printing = {
    id,
    card_id: id,
    name,
    set: setName,
    set_name: setName,
    number,
    card_number: number,
    rarity,
    image: preferFullImage(hit),
    href,
    canonicalPath: href,
    canonical_path: href,
  };
  // Same verdict as _marketplace_row.normalizeMarketplaceRow: a genuine
  // printed n/m fraction is a single. Typeahead Singles/Product trust this
  // instead of re-classifying names client-side on every keystroke.
  if (hasCollectorNumber(number)) {
    printing.item_kind = 'single';
    printing.product_type = 'card';
  }
  const aliases = Array.isArray(hit.expansion_aliases) ? hit.expansion_aliases : [];
  if (aliases.length) {
    printing._aliases = aliases.map((value) => String(value || '').trim()).filter(Boolean);
  }
  const rank = Number(hit._rankingScore || hit._rank);
  if (Number.isFinite(rank) && rank > 0) {
    printing._rank = rank;
  }
  const nationality = String(hit.nationality || '').trim().toLowerCase();
  if (nationality) {
    printing.nationality = nationality;
  } else if (hit.effective_print_bucket && hit.effective_print_bucket !== 'unknown') {
    // Indexed canonical bucket when the raw nationality field was empty.
    printing.nationality = String(hit.effective_print_bucket).trim().toLowerCase();
  }
  return printing;
}

function groupSuggestHits(hits = [], maxGroups = 8, maxPrintings = 20, query = '') {
  const groups = [];
  const byName = new Map();
  for (const hit of hits) {
    const printing = mapSuggestPrinting(hit);
    if (!printing.id) {
      continue;
    }
    const name = String(hit.name_group || printing.name || '').trim() || printing.id;
    let group = byName.get(name);
    if (!group) {
      group = { name, printings: [], _weight: 0 };
      byName.set(name, group);
      groups.push(group);
    }
    group._weight = Math.max(group._weight, Number(hit.search_weight || 0));
    const nicknames = Array.isArray(hit.nicknames) ? hit.nicknames : [];
    if (nicknames.length) {
      group._nicknames = [...new Set([...(group._nicknames || []), ...nicknames.map((value) => String(value || '').trim()).filter(Boolean)])];
    }
    if (group.printings.some((row) => row.id === printing.id)) {
      continue;
    }
    group.printings.push(printing);
  }
  const printingCap = Math.max(1, Number(maxPrintings) || 20);
  return sortSuggestGroups(
    groups.filter((group) => group.printings.length > 0),
    query,
  ).slice(0, Math.max(1, Number(maxGroups) || 8)).map(({ name, printings }) => ({
    name,
    printings: sortSuggestPrintings(printings, query, name).slice(0, printingCap),
  }));
}

function capSuggestRows(groups = [], maxRows = 20) {
  let left = Math.max(1, Number(maxRows) || 20);
  const out = [];
  for (const group of groups) {
    if (left <= 0) {
      break;
    }
    const printings = (group.printings || []).slice(0, left);
    if (!printings.length) {
      continue;
    }
    out.push({ ...group, printings });
    left -= printings.length;
  }
  return out;
}

function suggestMeiliHitLimit(groupLimit) {
  return Math.min(Math.max(Number(groupLimit) * 8, 48), 96);
}

module.exports = {
  mapSuggestPrinting,
  groupSuggestHits,
  capSuggestRows,
  sortSuggestGroups,
  suggestGroupTier,
  leftoverQueryTokens,
  isVariantPrefixToken,
  suggestMeiliHitLimit,
};
