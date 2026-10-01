'use strict';

/**
 * Title-language display overlay (LangToggle), not print language.
 * Meili stays English-identity (`language = "en"`). After grouping, stamp
 * localized_name / localized_set / localized_rarity from the tall catalog
 * tables so the searchbar copy changes when Italiano / 日本語 / … is picked.
 * English `name` / `set` / `rarity` stay on the row for ranking and matching.
 */

const TTL_MS = 10 * 60 * 1000;
const TITLE_LANGS = new Set([
  'en', 'it', 'fr', 'de', 'es', 'jp', 'pt', 'nl', 'pl', 'ru',
  'ko', 'zh', 'zht', 'id', 'th', 'vi',
]);

const caches = new Map();

function cacheKey(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanTitleLanguage(value) {
  const language = String(value || 'en').trim().toLowerCase();
  if (TITLE_LANGS.has(language)) {
    return language;
  }
  if (language === 'ja') {
    return 'jp';
  }
  if (language === 'zh-cn' || language === 'zh-hans') {
    return 'zh';
  }
  if (language === 'zh-tw' || language === 'zh-hant') {
    return 'zht';
  }
  return 'en';
}

function lookup(map, value) {
  if (!map) {
    return '';
  }
  return map.get(cacheKey(value)) || '';
}

function putLocalized(map, english, localized) {
  const key = cacheKey(english);
  const loc = String(localized || '').trim();
  if (!key || !loc) {
    return;
  }
  map.set(key, loc);
}

function mapsFromRows({ names = [], sets = [], rarities = [] } = {}) {
  const maps = {
    names: new Map(),
    sets: new Map(),
    rarities: new Map(),
  };
  for (const row of names) {
    if (Array.isArray(row)) {
      putLocalized(maps.names, row[0], row[1]);
    } else {
      putLocalized(maps.names, row.name, row.localized_name);
    }
  }
  for (const row of sets) {
    if (Array.isArray(row)) {
      putLocalized(maps.sets, row[0], row[1]);
    } else {
      putLocalized(maps.sets, row.name, row.localized_name);
      putLocalized(maps.sets, row.normalized_name, row.localized_name);
    }
  }
  for (const row of rarities) {
    if (Array.isArray(row)) {
      putLocalized(maps.rarities, row[0], row[1]);
    } else {
      putLocalized(maps.rarities, row.rarity, row.localized_name);
    }
  }
  return maps;
}

async function loadTitleLanguageMaps(queryFn, language) {
  const lang = cleanTitleLanguage(language);
  if (lang === 'en' || typeof queryFn !== 'function') {
    return null;
  }
  const hit = caches.get(lang);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit;
  }
  const [nameResult, rarityResult, setResult] = await Promise.all([
    queryFn(
      'select name, localized_name from public.card_name_languages where language = $1',
      [lang],
    ),
    queryFn(
      'select rarity, localized_name from public.rarity_languages where language = $1',
      [lang],
    ),
    queryFn(
      `
        select e.name, e.normalized_name, l.localized_name
        from public.expansion_languages l
        join public.pokoin_pokemon_expansions e on e.expansion_id = l.expansion_id
        where l.language = $1
      `,
      [lang],
    ),
  ]);
  const maps = mapsFromRows({
    names: nameResult?.rows || [],
    rarities: rarityResult?.rows || [],
    sets: setResult?.rows || [],
  });
  maps.at = Date.now();
  caches.set(lang, maps);
  return maps;
}

function titleLanguageFromSearchParams(searchParams) {
  const params = searchParams && typeof searchParams.get === 'function'
    ? searchParams
    : new URLSearchParams();
  return cleanTitleLanguage(
    params.get('search_language')
      || params.get('lang')
      || params.get('language')
      || 'en',
  );
}

function overlayPrinting(printing, maps) {
  if (!maps || !printing) {
    return printing;
  }
  const localizedName = lookup(maps.names, printing.name);
  const localizedSet = lookup(
    maps.sets,
    printing.set || printing.set_name || printing.expansion_name,
  );
  const localizedRarity = lookup(maps.rarities, printing.rarity);
  if (!localizedName && !localizedSet && !localizedRarity) {
    return printing;
  }
  return {
    ...printing,
    ...(localizedName ? { localized_name: localizedName } : {}),
    ...(localizedSet ? { localized_set: localizedSet } : {}),
    ...(localizedRarity ? { localized_rarity: localizedRarity } : {}),
  };
}

function overlayExpansion(expansion, maps) {
  if (!maps || !expansion) {
    return expansion;
  }
  const localizedName = lookup(maps.sets, expansion.name)
    || lookup(maps.sets, expansion.normalized_name)
    || lookup(maps.sets, expansion.set);
  if (!localizedName) {
    return expansion;
  }
  return {
    ...expansion,
    localized_name: localizedName,
    localized_set: localizedName,
  };
}

function overlayTitleLanguageOnGroups(groups, maps) {
  const list = Array.isArray(groups) ? groups : [];
  if (!maps) {
    return list;
  }
  return list.map((group) => {
    const localizedName = lookup(maps.names, group.name);
    return {
      ...group,
      ...(localizedName ? { localized_name: localizedName } : {}),
      printings: (group.printings || []).map((printing) => overlayPrinting(printing, maps)),
    };
  });
}

function overlayTitleLanguageOnRows(rows, maps) {
  const list = Array.isArray(rows) ? rows : [];
  if (!maps) {
    return list;
  }
  return list.map((row) => overlayPrinting({
    ...row,
    set: row.set || row.set_name || row.expansion_name,
  }, maps));
}

async function attachTitleLanguageOnGroups(groups, language, queryFn) {
  const list = Array.isArray(groups) ? groups : [];
  const lang = cleanTitleLanguage(language);
  if (lang === 'en' || !list.length || typeof queryFn !== 'function') {
    return list;
  }
  let maps;
  try {
    maps = await loadTitleLanguageMaps(queryFn, lang);
  } catch {
    return list;
  }
  return overlayTitleLanguageOnGroups(list, maps);
}

async function attachTitleLanguageOnRows(rows, language, queryFn) {
  const list = Array.isArray(rows) ? rows : [];
  const lang = cleanTitleLanguage(language);
  if (lang === 'en' || !list.length || typeof queryFn !== 'function') {
    return list;
  }
  let maps;
  try {
    maps = await loadTitleLanguageMaps(queryFn, lang);
  } catch {
    return list;
  }
  return overlayTitleLanguageOnRows(list, maps);
}

async function attachTitleLanguageOnExpansions(expansions, language, queryFn) {
  const list = Array.isArray(expansions) ? expansions : [];
  const lang = cleanTitleLanguage(language);
  if (lang === 'en' || !list.length || typeof queryFn !== 'function') {
    return list;
  }
  let maps;
  try {
    maps = await loadTitleLanguageMaps(queryFn, lang);
  } catch {
    return list;
  }
  return list.map((row) => overlayExpansion(row, maps));
}

function resetTitleLanguageCache() {
  caches.clear();
}

module.exports = {
  attachTitleLanguageOnExpansions,
  attachTitleLanguageOnGroups,
  attachTitleLanguageOnRows,
  cleanTitleLanguage,
  mapsFromRows,
  overlayExpansion,
  overlayTitleLanguageOnGroups,
  overlayTitleLanguageOnRows,
  resetTitleLanguageCache,
  titleLanguageFromSearchParams,
};
