import { setAbbrev } from './identity.js';
import { TCG_ERA_CATALOG, TCG_ERA_ORDER, eraHaystack, matchTcgEra, tcgEraYears } from './tcg-eras.js';

export { TCG_ERA_ORDER };

/** Watchtower wordmarks hosted on the Pi CDN. Not set icons. */
export const WORDMARK_SLUGS = new Set([
  '151',
  'ascended-heroes',
  'black-bolt',
  'chaos-rising',
  'destined-rivals',
  'journey-together',
  'mega-evolution',
  'obsidian-flames',
  'paldea-evolved',
  'paldean-fates',
  'paradox-rift',
  'perfect-order',
  'phantasmal-flames',
  'pitch-black',
  'prismatic-evolutions',
  'scarlet-and-violet',
  'shrouded-fable',
  'stellar-crown',
  'surging-sparks',
  'temporal-forces',
  'twilight-masquerade',
  'white-flare',
]);

/** Leftover + Serebii wordmarks on /expansions/logos/{slug}.png */
export const LOGO_SLUGS = new Set([
  '30th-celebration', 'abyss-eye', 'alter-genesis', 'ancient-origins',
  'aquapolis', 'astral-radiance', 'base-set', 'battle-partners',
  'battle-styles', 'black-and-white', 'black-bolt-sv11b', 'boundaries-crossed',
  'boundaries-crossed-promos', 'breakpoint', 'breakpoint-promos', 'breakthrough',
  'brilliant-stars', 'burning-shadows', 'burning-shadows-promos', 'bw-black-star-promos',
  'call-of-legends', 'call-of-legends-promos', 'celebrations', 'celestial-storm',
  'celestial-storm-promos', 'chilling-reign', 'cosmic-eclipse', 'cosmic-eclipse-promos',
  'crimson-haze', 'crimson-invasion', 'crown-zenith', 'cyber-judge',
  'dark-explorers', 'dark-explorers-promos', 'darkness-ablaze', 'delta-reign',
  'detective-pikachu', 'diamond-and-pearl', 'diamond-and-pearl-promos', 'double-crisis',
  'dp-black-star-promos', 'dragon-majesty', 'dragon-vault', 'dragons-exalted',
  'emerging-powers', 'evolutions', 'evolutions-promos', 'evolving-skies',
  'ex-crystal-guardians', 'ex-delta-species', 'ex-deoxys', 'ex-dragon',
  'ex-dragon-frontiers', 'ex-emerald', 'ex-firered-and-leafgreen', 'ex-hidden-legends',
  'ex-holon-phantoms', 'ex-legend-maker', 'ex-power-keepers', 'ex-ruby-and-sapphire',
  'ex-sandstorm', 'ex-team-magma-vs-team-aqua', 'ex-team-rocket-returns', 'ex-unseen-forces',
  'expedition-base-set', 'fates-collide', 'flashfire', 'forbidden-light',
  'fossil', 'furious-fists', 'fusion-strike', 'generations',
  'generations-promos', 'great-encounters', 'guardians-rising', 'gym-challenge',
  'gym-heroes', 'heartgold-and-soulsilver', 'heat-wave-arena', 'hidden-fates',
  'holon-phantoms', 'inferno-x', 'jungle', 'legendary-treasures',
  'legends-awakened', 'lost-origin', 'lost-thunder', 'majestic-dawn',
  'mask-of-change', 'mega-brave', 'mega-dream-ex', 'mega-symphonia',
  'mysterious-treasures', 'neo-destiny', 'neo-discovery', 'neo-genesis',
  'neo-revelation', 'next-destinies', 'night-wanderer', 'nihil-zero',
  'ninja-spinner', 'noble-victories', 'paradise-dragona', 'phantom-forces',
  'plasma-blast', 'plasma-freeze', 'plasma-storm', 'platinum',
  'platinum-arceus', 'pokemon-tcg-pokemon-go', 'pokemon-vs', 'pop-series-1',
  'pop-series-2', 'pop-series-3', 'pop-series-4', 'pop-series-5',
  'pop-series-6', 'pop-series-7', 'pop-series-8', 'pop-series-9',
  'primal-clash', 'rebel-clash', 'rising-rivals', 'roaring-skies',
  's-p-sword-and-shield-promos', 'secret-wonders', 'shining-fates', 'shining-legends',
  'silver-tempest', 'skyridge', 'sm-black-star-promos', 'steam-siege',
  'stellar-miracle', 'stormfront', 'sun-and-moon', 'super-electric-breaker',
  'supreme-victors', 'sv-black-star-promos', 'sword-and-shield', 'swsh-black-star-promos',
  'team-rocket', 'team-up', 'terastal-festival-ex', 'the-glory-of-team-rocket',
  'triumphant', 'ultra-prism', 'unbroken-bonds', 'undaunted',
  'unified-minds', 'unleashed', 'vivid-voltage', 'vstar-universe',
  'white-flare-sv11w', 'wild-force', 'xy-black-star-promos',
]);

export const SET_CODES = {
  '151': 'MEW',
  'ascended-heroes': 'ASC',
  'black-bolt': 'BBT',
  'chaos-rising': 'ME4',
  'destined-rivals': 'SV10',
  'journey-together': 'SV9',
  'mega-evolution': 'ME1',
  'obsidian-flames': 'SV3',
  'paldea-evolved': 'SV2',
  'paldean-fates': 'PAF',
  'paradox-rift': 'SV4',
  'perfect-order': 'ME3',
  'phantasmal-flames': 'PFL',
  'pitch-black': 'ME5',
  'prismatic-evolutions': 'PRE',
  'scarlet-and-violet': 'SV1',
  'shrouded-fable': 'SFA',
  'stellar-crown': 'SV7',
  'surging-sparks': 'SV8',
  'temporal-forces': 'SV5',
  'twilight-masquerade': 'SV6',
  'white-flare': 'WHF',
  'delta-reign': 'ME6',
};

export const ERA_ORDER = [
  ...TCG_ERA_ORDER,
  'Japanese',
  'Chinese',
  'Other',
];

export const ERA_CHIPS = [
  { id: 'all', label: 'All sets' },
  { id: 'Mega Evolution', label: 'Mega Evolution' },
  { id: 'Scarlet & Violet', label: 'Scarlet & Violet' },
  { id: 'Sword & Shield', label: 'Sword & Shield' },
  { id: 'Sun & Moon', label: 'Sun & Moon' },
  { id: 'XY', label: 'XY' },
  { id: 'Black & White', label: 'Black & White' },
  { id: 'classic', label: 'Classic' },
  { id: 'Japanese', label: 'Japanese' },
  { id: 'Chinese', label: 'Chinese' },
];

const CLASSIC_ERAS = new Set([
  'Call of Legends',
  'HeartGold & SoulSilver',
  'Platinum',
  'Diamond & Pearl',
  'EX',
  'e-Card',
  'Legendary Collection',
  'VS / web',
  'Neo',
  'Original',
]);

const ERA_SORT = {
  'mega-evolution': 1,
  'phantasmal-flames': 2,
  'ascended-heroes': 3,
  'perfect-order': 4,
  'chaos-rising': 5,
  'pitch-black': 6,
  'delta-reign': 7,
  'storm-emeralda': 8,
  'scarlet-and-violet': 1,
  'paldea-evolved': 2,
  'obsidian-flames': 3,
  'paradox-rift': 4,
  '151': 5,
  'paldean-fates': 6,
  'temporal-forces': 7,
  'twilight-masquerade': 8,
  'shrouded-fable': 9,
  'stellar-crown': 10,
  'surging-sparks': 11,
  'prismatic-evolutions': 12,
  'journey-together': 13,
  'destined-rivals': 14,
  'black-bolt': 15,
  'white-flare': 16,
};

function nationalitySortKey(row = {}) {
  const nationality = setNationality(row);
  if (nationality === 'japanese' || nationality === 'korean') return 1;
  if (nationality === 'chinese') return 2;
  return 0;
}

function sortEraRows(rows) {
  return [...rows].sort((a, b) => {
    const na = nationalitySortKey(a);
    const nb = nationalitySortKey(b);
    if (na !== nb) return na - nb;
    const as = ERA_SORT[a.slug] || 500;
    const bs = ERA_SORT[b.slug] || 500;
    if (as !== bs) return as - bs;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function setNationality(row = {}) {
  return String(row.nationality || '').toLowerCase();
}

function setIndexEra(row = {}) {
  return tcgEra({
    slug: row.slug,
    name: row.name,
    set: row.name,
  }) || 'Other';
}

/** Year range from the TCG block, for Chinese set-index headings. */
export function chineseYearHeading(row = {}) {
  const era = setIndexEra(row);
  if (!era || era === 'Other') return 'Other';
  return tcgEraYears(era) || 'Other';
}

function yearHeadingSortKey(heading) {
  const match = String(heading || '').match(/(\d{4})/);
  return match ? Number(match[1]) : 0;
}

function chineseCodeParts(row = {}) {
  const hay = eraHaystack(`${row.slug || ''} ${row.name || ''}`);
  if (/^csv/.test(hay)) {
    const match = hay.match(/^csv(\d+)?([a-z]*)/);
    return { family: 2, n: Number(match?.[1] || 0), tail: match?.[2] || '' };
  }
  if (/^mep(?:-|$)/.test(hay) || /^me-p(?:-|$)/.test(hay)) {
    return { family: 1, n: 0, tail: 'p' };
  }
  const mega = hay.match(/^me(\d+)/);
  if (mega) return { family: 1, n: Number(mega[1]), tail: '' };
  if (/^csm/.test(hay)) {
    const match = hay.match(/^csm(\d+)?([a-z]*)/);
    return { family: 4, n: Number(match?.[1] || 0), tail: match?.[2] || '' };
  }
  const swsh = hay.match(/^cs(\d+)(?:-(\d+)|([a-z]*))?/);
  if (swsh) {
    const minor = swsh[2] ? Number(swsh[2]) : 0;
    return { family: 3, n: Number(swsh[1]) * 10 + minor, tail: swsh[3] || '' };
  }
  return { family: 9, n: 0, tail: hay };
}

function compareChineseRows(left, right) {
  const a = chineseCodeParts(left);
  const b = chineseCodeParts(right);
  if (a.family !== b.family) return a.family - b.family;
  if (a.n !== b.n) return b.n - a.n;
  if (a.tail !== b.tail) return b.tail.localeCompare(a.tail);
  return String(left.name || '').localeCompare(String(right.name || ''));
}

function headingForRow(row, chip) {
  if (chip === 'Chinese' || (chip === 'all' && setNationality(row) === 'chinese')) {
    return chineseYearHeading(row);
  }
  return setIndexEra(row);
}

function matchesSetChip(row, chip) {
  if (!chip || chip === 'all') return true;
  const nationality = setNationality(row);
  if (chip === 'Japanese') return nationality === 'japanese';
  if (chip === 'Chinese') return nationality === 'chinese';
  if (nationality === 'chinese') return false;
  return expansionMatchesChip(setIndexEra(row), chip);
}

/** Sets index h2 → era page. Year ranges (Chinese) map back to the TCG block. */
export function headingHref(heading) {
  const text = String(heading || '');
  if (ERA_ORDER.includes(text) || TCG_ERA_ORDER.includes(text)) {
    return eraHref(text);
  }
  const block = TCG_ERA_CATALOG.find((era) => era.years === text);
  return block ? eraHref(block.id) : '/marketplace/sets';
}

export function expansionEra(row = {}) {
  const nationality = String(row.nationality || '').toLowerCase();
  if (nationality === 'japanese') return 'Japanese';
  if (nationality === 'chinese') return 'Chinese';
  return matchTcgEra(`${row.slug || ''} ${row.name || ''}`) || 'Other';
}

/**
 * TCG block for a printing. JP/EN/CN of the same generation stay together.
 * Catalog + mapping rules: docs/TCG_ERAS.md
 * Mixed-era dumps (League Promos, Prize Pack, theme decks) stay Other as a
 * set; a printing can still match from stamp text (Perfect Order Stamped,
 * SVI 196, SVP) or CLIP same-art peers (`inheritEraFromArtwork`).
 */
const DUMP_SET_CODES = {
  SVI: 'Scarlet & Violet',
  PAL: 'Scarlet & Violet',
  OBF: 'Scarlet & Violet',
  MEW: 'Scarlet & Violet',
  PAR: 'Scarlet & Violet',
  PAF: 'Scarlet & Violet',
  TEF: 'Scarlet & Violet',
  TWM: 'Scarlet & Violet',
  SFA: 'Scarlet & Violet',
  SCR: 'Scarlet & Violet',
  SSP: 'Scarlet & Violet',
  PRE: 'Scarlet & Violet',
  JTG: 'Scarlet & Violet',
  DRI: 'Scarlet & Violet',
  BLK: 'Scarlet & Violet',
  WHT: 'Scarlet & Violet',
  SVP: 'Scarlet & Violet',
  MEG: 'Mega Evolution',
  SWSH: 'Sword & Shield',
  SSH: 'Sword & Shield',
  RCL: 'Sword & Shield',
  DAA: 'Sword & Shield',
  CPA: 'Sword & Shield',
  VIV: 'Sword & Shield',
  SHF: 'Sword & Shield',
  BST: 'Sword & Shield',
  CRE: 'Sword & Shield',
  EVS: 'Sword & Shield',
  CEL: 'Sword & Shield',
  FST: 'Sword & Shield',
  BRS: 'Sword & Shield',
  ASR: 'Sword & Shield',
  PGO: 'Sword & Shield',
  LOR: 'Sword & Shield',
  SIT: 'Sword & Shield',
  CRZ: 'Sword & Shield',
};

function eraFromDumpStamp(row = {}) {
  const numbered = String(row.number || row.card_number || '');
  const code = numbered.match(/\b([A-Z]{3,4})\b/g) || [];
  for (const token of code) {
    const era = DUMP_SET_CODES[token];
    if (era) return era;
  }
  const stamp = numbered
    .replace(/\d+\s*\/\s*\d+/g, ' ')
    .replace(/\d+/g, ' ')
    .trim();
  if (!stamp) return null;
  return matchTcgEra(stamp);
}

export function tcgEra(row = {}) {
  const raw = `${row.slug || ''} ${[row.set, row.set_name, row.expansion_name].filter(Boolean).join(' ') || row.name || ''}`;
  const key = eraHaystack(raw);
  const hit = matchTcgEra(raw);
  if (hit) return hit;
  const stamp = eraFromDumpStamp(row);
  if (stamp) return stamp;
  if (/prize-pack/.test(key)) {
    const frac = String(row.number || row.card_number || '').match(/(\d+)\s*\/\s*(\d+)/);
    const total = frac ? Number(frac[2]) : 0;
    if (total === 202 || total === 216 || total === 189) return 'Sword & Shield';
    if (total === 85 || total === 86 || total === 72) return 'Scarlet & Violet';
    if (total === 88 || total === 84 || total === 94 || total === 132) return 'Mega Evolution';
  }
  return 'Other';
}

export function tcgEraId(era) {
  return String(era || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'other';
}

export function eraHref(era) {
  return `/marketplace/eras/${tcgEraId(era)}`;
}

export function eraFromParam(param) {
  const id = tcgEraId(param);
  return ERA_ORDER.find((era) => tcgEraId(era) === id) || null;
}

export function expansionsForEraPage(rows = [], era) {
  const wanted = String(era || '');
  return sortEraRows((rows || []).filter((row) => {
    if (!wanted || isSetVariant(row)) {
      return false;
    }
    if (wanted === 'Japanese' || wanted === 'Chinese') {
      return expansionEra(row) === wanted;
    }
    return tcgEra({
      slug: row.slug,
      name: row.name,
      set: row.name,
    }) === wanted;
  }));
}

export function expansionMatchesChip(era, chip) {
  if (!chip || chip === 'all') return true;
  if (chip === 'classic') return CLASSIC_ERAS.has(era);
  return era === chip;
}

export function isSetVariant(row = {}) {
  return /reverse-holo|reverse holo|master-ball|master ball|poke-ball-reverse|poké ball reverse|poke ball reverse/i
    .test(`${row.slug || ''} ${row.name || ''}`);
}

export function expansionLogoSrc(row = {}) {
  const fromApi = String(row.logoImageUrl || '').trim();
  if (fromApi) return fromApi;
  const slug = String(row.slug || '').trim();
  if (!slug) return '';
  if (WORDMARK_SLUGS.has(slug)) return `/card-images/expansions/wordmarks/${slug}.png`;
  if (LOGO_SLUGS.has(slug)) return `/card-images/expansions/logos/${slug}.png`;
  return '';
}

/** Bust CDN `immutable` after saved code-mark plates. */
const SYMBOL_CACHE = 'cm1';

function withSymbolCache(url) {
  const src = String(url || '').trim();
  if (!src) return '';
  if (/[?&]v=/.test(src)) return src;
  return `${src}${src.includes('?') ? '&' : '?'}v=${SYMBOL_CACHE}`;
}

/** Circular set mark (desk shortcuts, expansion title). Not the wordmark. */
export function expansionSymbolSrc(row = {}) {
  const fromApi = String(
    row.defaultSymbolUrl || row.symbolImageUrl || row.expansionSymbolUrl || '',
  ).trim();
  if (fromApi) return withSymbolCache(fromApi);
  const slug = String(row.slug || '').trim();
  if (!slug) return '';
  return withSymbolCache(`/card-images/expansions/symbols/${slug}.png`);
}

export function expansionCode(row = {}) {
  const slug = String(row.slug || '').trim();
  if (SET_CODES[slug]) return SET_CODES[slug];
  return setAbbrev(row.name || slug);
}

export function groupExpansions(rows, { query = '', chip = 'all' } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  const grouped = new Map();
  for (const row of rows || []) {
    if (!needle && isSetVariant(row)) continue;
    if (needle) {
      const blob = `${row.name || ''} ${row.localized_name || ''} ${row.slug || ''}`.toLowerCase();
      if (!blob.includes(needle)) continue;
    }
    if (!matchesSetChip(row, chip)) continue;
    const heading = headingForRow(row, chip);
    if (!grouped.has(heading)) grouped.set(heading, []);
    grouped.get(heading).push(row);
  }
  const yearHeadings = [...grouped.keys()]
    .filter((heading) => !TCG_ERA_ORDER.includes(heading) && heading !== 'Other')
    .sort((a, b) => yearHeadingSortKey(b) - yearHeadingSortKey(a));
  const order = [...TCG_ERA_ORDER, ...yearHeadings, 'Other'];
  return order
    .concat([...grouped.keys()].filter((heading) => !order.includes(heading)))
    .map((heading) => {
      const list = grouped.get(heading) || [];
      const sorted = list.length && list.every((row) => setNationality(row) === 'chinese')
        ? [...list].sort(compareChineseRows)
        : sortEraRows(list);
      return [heading, sorted];
    })
    .filter(([, list]) => list.length);
}
