import DATA from './data/limitless.json';

export const FLAG = (cc) => (cc ? `https://r2.limitlesstcg.net/flags/${cc}.png` : '');
export const SPRITE = (name) => (
  name ? `https://r2.limitlesstcg.net/pokemon/gen9/${name}.png` : ''
);
export const FORMAT = (id) => (
  id ? `https://limitless3.nyc3.cdn.digitaloceanspaces.com/formats/${id}.png` : ''
);

export function scanUrl(set, num) {
  const code = String(set || '').toUpperCase();
  const n = String(num || '').replace(/^0+/, '') || '0';
  return `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/${code}/${code}_${n.padStart(3, '0')}_R_EN.png`;
}

export const TYPE_LABEL = {
  worlds: 'Worlds',
  international: 'International',
  regional: 'Regional',
  special: 'Special',
  national: 'National',
  cl: 'Champions League',
};

export const FORMAT_LABEL = {
  standard: 'Standard',
  'standard-jp': 'Standard (JP)',
  'expanded-jp': 'Expanded (JP)',
};

export const REGION_LABEL = {
  EU: 'Europe',
  NA: 'North America',
  LA: 'Latin America',
  OC: 'Oceania',
  AS: 'Asia',
  OT: 'Other',
};

export const ALL_TYPES = Object.keys(TYPE_LABEL);
export const ALL_FORMATS = Object.keys(FORMAT_LABEL);
export const ALL_REGIONS = Object.keys(REGION_LABEL);

export function competitiveData() {
  return DATA;
}

export function deckById(id) {
  return DATA.decks.find((row) => row.id === String(id)) || null;
}

export function playerById(id) {
  return DATA.players.find((row) => row.id === String(id)) || null;
}

export function tournamentById(id) {
  return DATA.tournaments.find((row) => row.id === String(id))
    || DATA.cityLeagues.find((row) => row.id === String(id))
    || null;
}

export function listById(id) {
  return DATA.lists[String(id)] || null;
}

export function standingsFor(id) {
  return DATA.standings[String(id)] || [];
}

export function listsForEvent(id) {
  return Object.values(DATA.lists).filter((row) => String(row.event) === String(id));
}

export function metaFromStandings(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (!row.deck) continue;
    counts.set(row.deck, (counts.get(row.deck) || 0) + 1);
  }
  const total = rows.length || 1;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([deckId, count]) => ({
      deck: deckById(deckId),
      deckId,
      count,
      share: (count / total) * 100,
    }));
}

export function completedTournaments() {
  return DATA.tournaments.filter((row) => row.status === 'completed');
}

export function filterCompleted({ types, formats, regions }) {
  return completedTournaments().filter((row) => (
    types.has(row.type)
    && formats.has(row.format)
    && regions.has(row.region)
  ));
}

export function upcomingTournaments() {
  return DATA.tournaments.filter((row) => row.status === 'upcoming');
}

export function placeSuffix(n) {
  const value = Number(n) % 100;
  if (value >= 11 && value <= 13) {
    return 'th';
  }
  return ({ 1: 'st', 2: 'nd', 3: 'rd' }[Number(n) % 10] || 'th');
}

export function money(n) {
  return `$${Number(n || 0).toLocaleString('en-US')}`;
}

export function cardHrefForName(name) {
  const needle = String(name || '').toLowerCase();
  const hit = DATA.cards.find((card) => needle.includes(String(card.name).toLowerCase())
    || String(card.name).toLowerCase().includes(needle.split(' ')[0] || ''));
  if (hit) {
    return `/marketplace/competitive/cards/${hit.id}`;
  }
  const query = String(name || '').replace(/\s+\w{2,4}\s+\d+.*$/, '').trim();
  return `/marketplace/search?q=${encodeURIComponent(query || name || '')}`;
}

export const COMP_NAV = [
  { to: '/marketplace/competitive', label: 'Overview', match: (path) => path === '/marketplace/competitive' || path === '/marketplace/competitive/' },
  { to: '/marketplace/competitive/tournaments', label: 'Tournaments', match: (path) => path.includes('/tournaments') },
  { to: '/marketplace/competitive/decks', label: 'Decks', match: (path) => path.includes('/decks') || path.includes('/decklists') },
  { to: '/marketplace/competitive/cards', label: 'Cards', match: (path) => path.includes('/cards') },
  { to: '/marketplace/competitive/players', label: 'Rankings', match: (path) => path.includes('/players') },
];
