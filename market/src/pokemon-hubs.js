/** Pokémon species hubs: one landing per National Dex entry. */
import SPECIES from './data/pokedex-species.js';
import { pokedexNumber } from './pokedex.js';

const LABELS = {
  nidoranf: 'Nidoran♀',
  nidoranm: 'Nidoran♂',
  nidoran: 'Nidoran♀',
  mrmime: 'Mr. Mime',
  mimejr: 'Mime Jr.',
  mrime: 'Mr. Rime',
  farfetchd: "Farfetch'd",
  sirfetchd: "Sirfetch'd",
  hooh: 'Ho-Oh',
  porygon2: 'Porygon2',
  porygonz: 'Porygon-Z',
  flabebe: 'Flabébé',
  typenull: 'Type: Null',
  tapukoko: 'Tapu Koko',
  tapulele: 'Tapu Lele',
  tapubulu: 'Tapu Bulu',
  tapufini: 'Tapu Fini',
  jangmoo: 'Jangmo-o',
  hakamoo: 'Hakamo-o',
  kommoo: 'Kommo-o',
  wooper: 'Wooper',
  wochien: 'Wo-Chien',
  chienpao: 'Chien-Pao',
  tinglu: 'Ting-Lu',
  chiyu: 'Chi-Yu',
  greattusk: 'Great Tusk',
  screamtail: 'Scream Tail',
  brutebonnet: 'Brute Bonnet',
  fluttermane: 'Flutter Mane',
  slitherwing: 'Slither Wing',
  sandyshocks: 'Sandy Shocks',
  irontreads: 'Iron Treads',
  ironbundle: 'Iron Bundle',
  ironhands: 'Iron Hands',
  ironjugulis: 'Iron Jugulis',
  ironmoth: 'Iron Moth',
  ironthorns: 'Iron Thorns',
  roaringmoon: 'Roaring Moon',
  ironvaliant: 'Iron Valiant',
  walkingwake: 'Walking Wake',
  ironleaves: 'Iron Leaves',
  gougingfire: 'Gouging Fire',
  ragingbolt: 'Raging Bolt',
  ironboulder: 'Iron Boulder',
  ironcrown: 'Iron Crown',
};

const GENS = [
  { id: 1, start: 1, end: 151, title: 'Kanto' },
  { id: 2, start: 152, end: 251, title: 'Johto' },
  { id: 3, start: 252, end: 386, title: 'Hoenn' },
  { id: 4, start: 387, end: 493, title: 'Sinnoh' },
  { id: 5, start: 494, end: 649, title: 'Unova' },
  { id: 6, start: 650, end: 721, title: 'Kalos' },
  { id: 7, start: 722, end: 809, title: 'Alola' },
  { id: 8, start: 810, end: 905, title: 'Galar' },
  { id: 9, start: 906, end: 1025, title: 'Paldea' },
];

export function speciesLabel(compact) {
  const key = String(compact || '').toLowerCase();
  if (LABELS[key]) {
    return LABELS[key];
  }
  if (!key) {
    return '';
  }
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function speciesSlug(compact) {
  const key = String(compact || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return key;
}

export function pokedexSpeciesList() {
  const byNumber = new Map();
  for (const [key, number] of Object.entries(SPECIES)) {
    const n = Number(number);
    if (!Number.isInteger(n) || n < 1 || byNumber.has(n)) {
      continue;
    }
    byNumber.set(n, {
      n,
      key,
      slug: speciesSlug(key),
      name: speciesLabel(key),
    });
  }
  return [...byNumber.values()].sort((a, b) => a.n - b.n);
}

const ALL_SPECIES = pokedexSpeciesList();
const BY_SLUG = new Map(ALL_SPECIES.map((row) => [row.slug, row]));
const BY_NUMBER = new Map(ALL_SPECIES.map((row) => [row.n, row]));

export function speciesFromSlug(slug) {
  return BY_SLUG.get(speciesSlug(slug)) || null;
}

export function speciesFromCard(card) {
  const n = pokedexNumber(card);
  return n ? BY_NUMBER.get(n) || null : null;
}

export function pokemonHref(cardOrSlug, lang = 'en') {
  const language = String(lang || 'en').toLowerCase() || 'en';
  if (typeof cardOrSlug === 'string') {
    const row = speciesFromSlug(cardOrSlug);
    return row ? `/marketplace/${language}/pokemon/${row.slug}` : `/marketplace/${language}/pokemon`;
  }
  const row = speciesFromCard(cardOrSlug);
  return row ? `/marketplace/${language}/pokemon/${row.slug}` : '';
}

export function pokemonGenerations() {
  const all = pokedexSpeciesList();
  return GENS.map((gen) => ({
    ...gen,
    rows: all.filter((row) => row.n >= gen.start && row.n <= gen.end),
  }));
}
