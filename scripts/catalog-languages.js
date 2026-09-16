'use strict';

/** Title-language codes. Same set as market/src/locale.js SEARCH_LANGS. */
const UI_LANGUAGES = Object.freeze([
  'en', 'it', 'fr', 'de', 'es', 'jp', 'pt', 'nl', 'pl', 'ru',
  'ko', 'zh', 'zht', 'id', 'th', 'vi',
]);

const TCGDEX_TO_UI = Object.freeze({
  en: 'en',
  it: 'it',
  fr: 'fr',
  de: 'de',
  es: 'es',
  'es-mx': 'es',
  ja: 'jp',
  pt: 'pt',
  'pt-br': 'pt',
  'pt-pt': 'pt',
  nl: 'nl',
  pl: 'pl',
  ru: 'ru',
  ko: 'ko',
  'zh-cn': 'zh',
  'zh-tw': 'zht',
  id: 'id',
  th: 'th',
});

const UI_TO_TCGDEX = Object.freeze({
  en: 'en',
  it: 'it',
  fr: 'fr',
  de: 'de',
  es: 'es',
  jp: 'ja',
  pt: 'pt',
  nl: 'nl',
  pl: 'pl',
  ru: 'ru',
  ko: 'ko',
  zh: 'zh-cn',
  zht: 'zh-tw',
  id: 'id',
  th: 'th',
});

const POKEMONTCG_FOREIGN_LANG = Object.freeze({
  english: 'en',
  italian: 'it',
  french: 'fr',
  german: 'de',
  spanish: 'es',
  japanese: 'jp',
  portuguese: 'pt',
  'portuguese (brazil)': 'pt',
  dutch: 'nl',
  polish: 'pl',
  russian: 'ru',
  korean: 'ko',
  'chinese (simplified)': 'zh',
  'chinese simplified': 'zh',
  'mandarin': 'zh',
  'chinese (traditional)': 'zht',
  'chinese traditional': 'zht',
  indonesian: 'id',
  thai: 'th',
});

const GENERIC_RARITY = /^(card|cards|single|singles|product|unknown|pokemon|pokémon|none)$/i;
const SET_CODE_RARITY = /^[A-Z]{1,6}[0-9][A-Z0-9.]*$/;
const EVENT_STAMP = /^(?:WCD|STAFF)\s/i;
const RARITY_HINT = /rare|holo|promo|common|uncommon|illustration|secret|ultra|reverse|full.?art|radiant|amazing|legend|prime|ace.?spec|shiny|crown|diamond|star|hyper|jumbo|unnumbered/i;

const RARITY_SYNONYMS = Object.freeze({
  rareholo: 'holorare',
  rareholoex: 'holorareex',
  rareholov: 'holorarev',
  rareholovmax: 'holorarevmax',
  rareholovstar: 'holorarevstar',
  illustrationrare: 'illustrationrare',
  specialillustrationrare: 'specialillustrationrare',
  hyperrare: 'hyperrare',
  shinyrare: 'shinyrare',
});

function compactText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** pokemontcg `sv3pt5` / `sv1` ↔ TCGDex `sv03.5` / `sv01`. */
function foldSetId(id) {
  return String(id || '')
    .trim()
    .toLowerCase()
    .replace(/pt/g, '.')
    .replace(/([a-z]+)0+(\d)/g, '$1$2');
}

const SPECIES_SUFFIX = /^(ex|gx|v|vmax|vstar|break|lvx|m|mega)$/;
const POKEAPI_LANGUAGE_ID = Object.freeze({
  3: 'ko',
  4: 'zht',
  5: 'fr',
  6: 'de',
  7: 'es',
  8: 'it',
  9: 'en',
  11: 'jp',
  12: 'zh',
  13: 'pt',
});

function parsePokeApiSpeciesCsv(csvText) {
  const byId = new Map();
  for (const line of String(csvText || '').split(/\n/).slice(1)) {
    if (!line.trim()) continue;
    const [speciesId, languageId, name] = line.split(',');
    const ui = POKEAPI_LANGUAGE_ID[Number(languageId)];
    const localized = String(name || '').trim();
    if (!ui || !localized) continue;
    const row = byId.get(speciesId) || { langs: {} };
    row.langs[ui] = localized;
    byId.set(speciesId, row);
  }
  const byCompact = new Map();
  for (const row of byId.values()) {
    const english = row.langs.en;
    const key = compactText(english);
    if (!key) continue;
    byCompact.set(key, { englishName: english, langs: row.langs });
  }
  return byCompact;
}

function translateNameWithSpecies(englishName, speciesByCompact, language) {
  const compact = compactText(englishName);
  if (!compact || language === 'en') return '';
  const exact = speciesByCompact.get(compact);
  if (exact?.langs?.[language]) return exact.langs[language];
  const roots = [...speciesByCompact.keys()].sort((left, right) => right.length - left.length);
  for (const root of roots) {
    if (!compact.startsWith(root) || compact.length <= root.length) continue;
    const suffix = compact.slice(root.length);
    if (!SPECIES_SUFFIX.test(suffix)) continue;
    const row = speciesByCompact.get(root);
    const localizedRoot = row?.langs?.[language];
    if (!localizedRoot) continue;
    const originalSuffix = String(englishName).slice(row.englishName.length);
    return `${localizedRoot}${originalSuffix}`;
  }
  return '';
}

function speciesDictionaryForLanguage(speciesByCompact, language, source = 'pokeapi') {
  const dict = new Map();
  if (!language || language === 'en') return dict;
  for (const [key, row] of speciesByCompact || []) {
    const localizedName = row?.langs?.[language];
    if (!localizedName) continue;
    dict.set(key, {
      englishName: row.englishName,
      localizedName,
      source,
      sourceId: key,
      votes: 1,
      total: 1,
    });
  }
  return dict;
}

function uiLanguageFromTcgdex(code) {
  return TCGDEX_TO_UI[String(code || '').trim().toLowerCase()] || '';
}

function tcgdexLanguageFromUi(code) {
  return UI_TO_TCGDEX[String(code || '').trim().toLowerCase()] || '';
}

function uiLanguageFromPokemontcg(label) {
  return POKEMONTCG_FOREIGN_LANG[String(label || '').trim().toLowerCase()] || '';
}

function printedRarityFromVersion(value) {
  const raw = String(value || '').trim();
  const pipe = raw.indexOf('|');
  if (pipe > 0) {
    const left = raw.slice(0, pipe).trim();
    const right = raw.slice(pipe + 1).trim();
    if (left && right) return left;
  }
  return '';
}

function rarityMatchKey(value) {
  const compact = compactText(value);
  return RARITY_SYNONYMS[compact] || compact;
}

function isPrintedRarityKey(value, tcgdexKeys = new Set()) {
  const rarity = String(value || '').trim();
  if (!rarity || GENERIC_RARITY.test(rarity)) return false;
  if (SET_CODE_RARITY.test(rarity) && !/\s/.test(rarity)) return false;
  if (EVENT_STAMP.test(rarity)) return false;
  if (/^empty\s+(tin|box)$/i.test(rarity)) return false;
  if (/^\d+\s+boosters?$/i.test(rarity)) return false;
  const key = rarityMatchKey(rarity);
  if (key && tcgdexKeys instanceof Set && tcgdexKeys.has(key)) return true;
  return RARITY_HINT.test(rarity);
}

function majorityVote(values) {
  const counts = new Map();
  for (const value of values || []) {
    const name = String(value || '').trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  let second = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      second = bestCount;
      best = name;
      bestCount = count;
    } else if (count > second) {
      second = count;
    }
  }
  if (!best) return null;
  return {
    name: best,
    count: bestCount,
    total: [...counts.values()].reduce((sum, count) => sum + count, 0),
    tied: bestCount === second && counts.size > 1,
  };
}

function indexById(rows, nameKey = 'name') {
  const byId = new Map();
  for (const row of rows || []) {
    const id = String(row?.id || '').trim();
    const name = String(row?.[nameKey] || row?.name || '').trim();
    if (!id || !name) continue;
    byId.set(id, { id, name, raw: row });
  }
  return byId;
}

function nameDictionaryFromLanguageDumps(englishRows, localizedRows, source = 'tcgdex') {
  const englishById = indexById(englishRows);
  const votes = new Map();
  const englishByCompact = new Map();
  for (const row of localizedRows || []) {
    const id = String(row?.id || '').trim();
    const localized = String(row?.name || '').trim();
    const english = englishById.get(id);
    if (!id || !localized || !english) continue;
    const key = compactText(english.name);
    if (!key) continue;
    const bucket = votes.get(key) || [];
    bucket.push({ name: localized, sourceId: id });
    votes.set(key, bucket);
    if (!englishByCompact.has(key)) englishByCompact.set(key, english.name);
  }
  const dict = new Map();
  for (const [key, bucket] of votes) {
    const vote = majorityVote(bucket.map((item) => item.name));
    if (!vote || vote.tied) continue;
    const sourceId = bucket.find((item) => item.name === vote.name)?.sourceId || '';
    dict.set(key, {
      englishName: englishByCompact.get(key) || '',
      localizedName: vote.name,
      source,
      sourceId,
      votes: vote.count,
      total: vote.total,
    });
  }
  return dict;
}

function matchEnglishName(name, dictionary) {
  const key = compactText(name);
  if (!key || !dictionary) return null;
  return dictionary.get(key) || null;
}

function translationsFromForeignNames(card) {
  const englishName = String(card?.name || '').trim();
  const rows = [];
  if (!englishName) return rows;
  for (const foreign of card?.foreignNames || []) {
    const language = uiLanguageFromPokemontcg(foreign?.language);
    const localizedName = String(foreign?.name || '').trim();
    if (!language || language === 'en' || !localizedName) continue;
    rows.push({
      englishName,
      language,
      localizedName,
      source: 'pokemontcg',
      sourceId: String(card?.id || ''),
      rarity: String(foreign?.rarity || card?.rarity || '').trim(),
    });
  }
  return rows;
}

function foreignNameDictionary(cards, language) {
  const votes = new Map();
  for (const card of cards || []) {
    for (const row of translationsFromForeignNames(card)) {
      if (row.language !== language) continue;
      const key = compactText(row.englishName);
      if (!key) continue;
      const bucket = votes.get(key) || [];
      bucket.push(row.localizedName);
      votes.set(key, bucket);
    }
  }
  const dict = new Map();
  for (const [key, names] of votes) {
    const vote = majorityVote(names);
    if (!vote || vote.tied) continue;
    dict.set(key, {
      localizedName: vote.name,
      source: 'pokemontcg',
      sourceId: '',
      votes: vote.count,
      total: vote.total,
    });
  }
  return dict;
}

function mergeDictionaries(primary, fallback) {
  const out = new Map(primary || []);
  for (const [key, value] of fallback || []) {
    if (!out.has(key)) out.set(key, value);
  }
  return out;
}

function indexSets(sets) {
  const byId = new Map();
  const byCompact = new Map();
  for (const set of sets || []) {
    const id = String(set?.id || '').trim();
    const name = String(set?.name || '').trim();
    if (!id || !name) continue;
    const entry = { id, name, raw: set };
    byId.set(id.toLowerCase(), entry);
    const folded = foldSetId(id);
    if (folded && folded !== id.toLowerCase() && !byId.has(folded)) {
      byId.set(folded, entry);
    }
    const compact = compactText(name);
    if (!compact) continue;
    const bucket = byCompact.get(compact) || [];
    bucket.push(entry);
    byCompact.set(compact, bucket);
  }
  return { byId, byCompact };
}

function matchExpansion(expansion, englishSets) {
  const officialId = String(expansion?.officialId || expansion?.official_id || '').trim();
  if (officialId) {
    const byId = englishSets.byId.get(officialId.toLowerCase())
      || englishSets.byId.get(foldSetId(officialId));
    if (byId) {
      return { set: byId, reason: 'official_id' };
    }
  }
  const names = [
    expansion?.officialName,
    expansion?.official_name,
    expansion?.name,
  ].map((value) => compactText(value)).filter(Boolean);
  for (const compact of names) {
    const bucket = englishSets.byCompact.get(compact) || [];
    if (bucket.length === 1) {
      return { set: bucket[0], reason: 'english_name' };
    }
  }
  return { set: null, reason: officialId ? 'official_id_miss' : 'unmapped' };
}

function localizedSetName(setId, localizedSets) {
  if (!setId || !localizedSets) return '';
  return localizedSets.byId.get(String(setId).toLowerCase())?.name
    || localizedSets.byId.get(foldSetId(setId))?.name
    || '';
}

function cardNameRowsForCatalog(englishNames, dictionariesByLanguage, speciesByCompact = new Map()) {
  const rows = [];
  const seen = new Set();
  for (const name of englishNames || []) {
    const english = String(name || '').trim();
    if (!english) continue;
    const enKey = `${english}\0en`;
    if (!seen.has(enKey)) {
      seen.add(enKey);
      rows.push({
        name: english,
        language: 'en',
        localizedName: english,
        source: 'identity',
        sourceId: '',
      });
    }
    for (const [language, dictionary] of dictionariesByLanguage || []) {
      if (language === 'en') continue;
      const hit = matchEnglishName(english, dictionary);
      let localizedName = hit?.localizedName || '';
      let source = hit?.source || 'tcgdex';
      let sourceId = hit?.sourceId || '';
      if (!localizedName) {
        localizedName = translateNameWithSpecies(english, speciesByCompact, language);
        if (localizedName) {
          source = 'pokeapi';
          sourceId = compactText(english);
        }
      }
      if (!localizedName) continue;
      const key = `${english}\0${language}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        name: english,
        language,
        localizedName,
        source,
        sourceId,
      });
    }
  }
  return rows;
}

function rarityRowsForCatalog(catalogRarities, tcgdexEnglishRarities, localizedRarityByLanguage) {
  const tcgdexKeys = new Set((tcgdexEnglishRarities || []).map(rarityMatchKey).filter(Boolean));
  const tcgdexByKey = new Map();
  for (const rarity of tcgdexEnglishRarities || []) {
    const key = rarityMatchKey(rarity);
    if (key && !tcgdexByKey.has(key)) tcgdexByKey.set(key, rarity);
  }
  const rows = [];
  const seen = new Set();
  for (const rarity of catalogRarities || []) {
    const english = String(rarity || '').trim();
    if (!isPrintedRarityKey(english, tcgdexKeys)) continue;
    const enKey = `${english}\0en`;
    if (!seen.has(enKey)) {
      seen.add(enKey);
      rows.push({
        rarity: english,
        language: 'en',
        localizedName: english,
        source: 'identity',
        sourceId: '',
      });
    }
    const matchKey = rarityMatchKey(english);
    const tcgdexEnglish = tcgdexByKey.get(matchKey);
    if (!tcgdexEnglish) continue;
    for (const [language, byEnglishRarity] of localizedRarityByLanguage || []) {
      if (language === 'en') continue;
      const localized = byEnglishRarity.get(tcgdexEnglish) || byEnglishRarity.get(english) || '';
      if (!localized) continue;
      const key = `${english}\0${language}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        rarity: english,
        language,
        localizedName: localized,
        source: 'tcgdex',
        sourceId: tcgdexEnglish,
      });
    }
  }
  return rows;
}

function expansionRowsForCatalog(expansions, englishSets, localizedSetsByLanguage) {
  const rows = [];
  const seen = new Set();
  for (const expansion of expansions || []) {
    const expansionId = Number(expansion.expansionId ?? expansion.expansion_id);
    const english = String(expansion.name || '').trim();
    if (!Number.isInteger(expansionId) || expansionId <= 0 || !english) continue;
    const enKey = `${expansionId}\0en`;
    if (!seen.has(enKey)) {
      seen.add(enKey);
      rows.push({
        expansionId,
        language: 'en',
        localizedName: english,
        source: 'identity',
        sourceId: '',
      });
    }
    const matched = matchExpansion(expansion, englishSets);
    if (!matched.set) continue;
    for (const [language, sets] of localizedSetsByLanguage || []) {
      if (language === 'en') continue;
      const localized = localizedSetName(matched.set.id, sets);
      if (!localized) continue;
      const key = `${expansionId}\0${language}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        expansionId,
        language,
        localizedName: localized,
        source: 'tcgdex',
        sourceId: matched.set.id,
      });
    }
  }
  return rows;
}

module.exports = {
  GENERIC_RARITY,
  POKEMONTCG_FOREIGN_LANG,
  TCGDEX_TO_UI,
  UI_LANGUAGES,
  UI_TO_TCGDEX,
  cardNameRowsForCatalog,
  compactText,
  expansionRowsForCatalog,
  foldSetId,
  foreignNameDictionary,
  indexById,
  indexSets,
  isPrintedRarityKey,
  localizedSetName,
  majorityVote,
  matchEnglishName,
  matchExpansion,
  mergeDictionaries,
  nameDictionaryFromLanguageDumps,
  parsePokeApiSpeciesCsv,
  printedRarityFromVersion,
  rarityMatchKey,
  rarityRowsForCatalog,
  speciesDictionaryForLanguage,
  tcgdexLanguageFromUi,
  translateNameWithSpecies,
  translationsFromForeignNames,
  uiLanguageFromPokemontcg,
  uiLanguageFromTcgdex,
};
