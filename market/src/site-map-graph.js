/**
 * pokoin.com/sitemap model over market/public/data/site-map.json
 * (built by scripts/build-site-map.mjs). Pure: no DOM, no React.
 *
 * A node ref is { kind, i } with kind page | era | set | card | species | artist.
 * Card stars are not stored with coordinates: star k of a set sits at
 * golden-angle step k around the set centre, same as the builder's layout.
 */

export const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export const KINDS = ['page', 'set', 'card', 'species', 'artist'];

export const KIND_LABEL = {
  page: 'Page',
  era: 'Era',
  set: 'Set',
  card: 'Card desk',
  species: 'Pokémon',
  artist: 'Artist',
};

export const KIND_PLURAL = {
  page: 'pages',
  era: 'eras',
  set: 'sets',
  card: 'card desks',
  species: 'Pokémon',
  artist: 'artists',
};

/** Line cap for one selection — the Card template alone fans out to every desk. */
export const MAX_LINES = 6000;

const TEMPLATE_KIND = {
  '/marketplace/sets/:slug': 'set',
  '/marketplace/eras/:eraId': 'era',
  '/marketplace/:lang/pokemon/:slug': 'species',
  '/marketplace/:lang/artists/:artistSlug': 'artist',
  '/marketplace/:lang/cards/:cardId/:slug?': 'card',
};

const INDEX_KIND = {
  '/marketplace/sets': 'set',
  '/marketplace/eras': 'era',
  '/marketplace/:lang/pokemon': 'species',
  '/marketplace/:lang/artists': 'artist',
};

function groupBy(values, size) {
  const out = Array.from({ length: size }, () => []);
  values.forEach((value, i) => {
    if (value >= 0 && value < size) out[value].push(i);
  });
  return out;
}

export function buildModel(data) {
  const { cards, sets, pages } = data;
  const count = cards.id.length;
  const cx = new Float32Array(count);
  const cy = new Float32Array(count);
  const cardSet = new Int32Array(count);
  const setStart = new Int32Array(sets.length);
  let at = 0;
  sets.forEach((set, s) => {
    setStart[s] = at;
    for (let k = 0; k < set.n; k += 1, at += 1) {
      const d = cards.spacing * Math.sqrt(k + 0.5);
      cx[at] = set.x + Math.cos(k * GOLDEN) * d;
      cy[at] = set.y + Math.sin(k * GOLDEN) * d;
      cardSet[at] = s;
    }
  });
  if (at !== count) {
    throw new Error(`site map cards ${count} do not fill sets (${at})`);
  }
  const setR = sets.map((set) => cards.spacing * Math.sqrt(Math.max(set.n, 1)) + 1.2);
  const pageById = new Map(pages.map((page, i) => [page.id, i]));
  const pageOut = pages.map(() => []);
  const pageIn = pages.map(() => []);
  for (const [a, b] of data.pageLinks) {
    pageOut[a].push(b);
    pageIn[b].push(a);
  }
  const rarityPages = data.rarities || [];
  const languagePage = data.languages || {};
  const pageRarity = new Map(rarityPages.map((page, r) => [page, r]));
  const pageNationality = new Map(Object.entries(languagePage).map(([nat, page]) => [page, nat]));
  const bySlug = (rows) => new Map(rows.map((row, i) => [row.slug ?? row.id, i]));
  return {
    data,
    count,
    cx,
    cy,
    cardSet,
    setStart,
    setR,
    pageById,
    pageOut,
    pageIn,
    shell: pageById.get('chrome'),
    bySpecies: groupBy(cards.sp, data.species.length),
    byArtist: groupBy(cards.ar, data.artists.length),
    byRarity: groupBy(cards.ra, rarityPages.length),
    setsOnEra: data.eras.map((_, e) => sets.flatMap((set, s) => (set.on.includes(e) ? [s] : []))),
    pageRarity,
    pageNationality,
    languagePage,
    setIndex: bySlug(sets),
    speciesIndex: bySlug(data.species),
    artistIndex: bySlug(data.artists),
    eraIndex: bySlug(data.eras),
    cardIndex: new Map(Array.from(cards.id, (id, i) => [id, i])),
    extent: data.radii.artists + 70,
  };
}

export function position(model, ref) {
  const { data } = model;
  switch (ref.kind) {
    case 'card': return [model.cx[ref.i], model.cy[ref.i]];
    case 'set': return [data.sets[ref.i].x, data.sets[ref.i].y];
    case 'era': return [data.eras[ref.i].x, data.eras[ref.i].y];
    case 'species': return [data.species[ref.i].x, data.species[ref.i].y];
    case 'artist': return [data.artists[ref.i].x, data.artists[ref.i].y];
    default: return [data.pages[ref.i].x, data.pages[ref.i].y];
  }
}

function cardTail(num) {
  return String(num || '').split('|').pop().trim();
}

export function nodeInfo(model, ref) {
  const { data } = model;
  if (ref.kind === 'card') {
    const set = data.sets[model.cardSet[ref.i]];
    const num = cardTail(data.cards.num[ref.i]);
    return {
      label: data.names[data.cards.name[ref.i]],
      sub: [num, set.name].filter(Boolean).join(' · '),
      href: `/marketplace/en/cards/${data.cards.id[ref.i]}`,
      kind: data.cards.sealed[ref.i] ? 'Product desk' : KIND_LABEL.card,
    };
  }
  if (ref.kind === 'set') {
    const set = data.sets[ref.i];
    return {
      label: set.name,
      sub: `${set.n.toLocaleString('en-US')} card desks · ${data.eras[set.era].name}`,
      href: `/marketplace/sets/${set.slug}`,
      kind: KIND_LABEL.set,
    };
  }
  if (ref.kind === 'era') {
    const era = data.eras[ref.i];
    return {
      label: era.name,
      sub: `${model.setsOnEra[ref.i].length} sets on the era page`,
      href: `/marketplace/eras/${era.id}`,
      kind: KIND_LABEL.era,
    };
  }
  if (ref.kind === 'species') {
    const row = data.species[ref.i];
    return {
      label: row.name,
      sub: `#${String(row.dex).padStart(4, '0')} · ${row.n.toLocaleString('en-US')} card desks`,
      href: `/marketplace/en/pokemon/${row.slug}`,
      kind: KIND_LABEL.species,
    };
  }
  if (ref.kind === 'artist') {
    const row = data.artists[ref.i];
    return {
      label: row.name,
      sub: `${row.n.toLocaleString('en-US')} card desks`,
      href: `/marketplace/en/artists/${row.slug}`,
      kind: KIND_LABEL.artist,
    };
  }
  const page = data.pages[ref.i];
  if (page.id === 'chrome') {
    return { label: page.label, sub: 'On every page', href: '', kind: 'Site chrome' };
  }
  return {
    label: page.label,
    sub: page.path,
    href: page.template ? '' : page.path,
    kind: page.template ? 'Page template' : KIND_LABEL.page,
  };
}

const refs = (kind, list) => list.map((i) => ({ kind, i }));

function templatePages(model, kind) {
  const ids = Object.entries(TEMPLATE_KIND).filter(([, k]) => k === kind).map(([id]) => id);
  return ids.map((id) => model.pageById.get(id)).filter((i) => i != null);
}

function indexPage(model, kind) {
  const id = Object.entries(INDEX_KIND).find(([, k]) => k === kind)?.[0];
  return id ? model.pageById.get(id) : undefined;
}

/**
 * Links out of / into a node, grouped for the panel. Each group is
 * { key, title, refs } where refs are node refs; `instances` holds the
 * pages built from a template (not links, but what the template fans out to).
 */
export function neighbors(model, ref) {
  const { data } = model;
  const out = [];
  const into = [];
  let instances = null;
  const push = (list, key, title, items) => {
    if (items.length) list.push({ key, title, refs: items });
  };
  const pageRefs = (list) => refs('page', list.filter((i) => i != null));

  if (ref.kind === 'card') {
    const s = model.cardSet[ref.i];
    const sp = data.cards.sp[ref.i];
    const ar = data.cards.ar[ref.i];
    const ra = data.cards.ra[ref.i];
    const lang = model.languagePage[data.sets[s].nat];
    const up = [{ kind: 'set', i: s }, { kind: 'era', i: data.sets[s].era }];
    if (sp >= 0) up.push({ kind: 'species', i: sp });
    if (ar >= 0) up.push({ kind: 'artist', i: ar });
    push(out, 'catalog', 'Catalog', up);
    push(out, 'hubs', 'Hubs', pageRefs([ra >= 0 ? data.rarities[ra] : null, lang]));
    const back = [{ kind: 'set', i: s }];
    if (sp >= 0) back.push({ kind: 'species', i: sp });
    if (ar >= 0) back.push({ kind: 'artist', i: ar });
    push(into, 'catalog', 'Catalog', back);
    push(into, 'hubs', 'Hubs', pageRefs([ra >= 0 ? data.rarities[ra] : null]));
  } else if (ref.kind === 'set') {
    const set = data.sets[ref.i];
    const start = model.setStart[ref.i];
    const cards = Array.from({ length: set.n }, (_, k) => ({ kind: 'card', i: start + k }));
    push(out, 'cards', 'Card desks', cards);
    push(out, 'eras', 'Eras', refs('era', set.on));
    push(into, 'pages', 'Pages', pageRefs([indexPage(model, 'set'), model.languagePage[set.nat]]));
    push(into, 'eras', 'Eras', refs('era', set.on));
    push(into, 'cards', 'Card desks', cards);
  } else if (ref.kind === 'era') {
    push(out, 'sets', 'Sets', refs('set', model.setsOnEra[ref.i]));
    push(into, 'pages', 'Pages', pageRefs([indexPage(model, 'era'), indexPage(model, 'set')]));
    push(into, 'sets', 'Sets', refs('set', model.setsOnEra[ref.i]));
  } else if (ref.kind === 'species' || ref.kind === 'artist') {
    const cards = refs('card', ref.kind === 'species' ? model.bySpecies[ref.i] : model.byArtist[ref.i]);
    push(out, 'cards', 'Card desks', cards);
    push(out, 'pages', 'Pages', pageRefs([indexPage(model, ref.kind)]));
    push(into, 'pages', 'Pages', pageRefs([indexPage(model, ref.kind)]));
    push(into, 'cards', 'Card desks', cards);
  } else {
    const page = data.pages[ref.i];
    push(out, 'pages', 'Pages', pageRefs(model.pageOut[ref.i]));
    const listKind = INDEX_KIND[page.id];
    if (listKind === 'set') push(out, 'sets', 'Sets', refs('set', data.sets.map((_, i) => i)));
    if (listKind === 'era') push(out, 'eras', 'Eras', refs('era', data.eras.map((_, i) => i).filter((e) => model.setsOnEra[e].length)));
    if (listKind === 'species') push(out, 'species', 'Pokémon', refs('species', data.species.map((_, i) => i)));
    if (listKind === 'artist') push(out, 'artists', 'Artists', refs('artist', data.artists.map((_, i) => i)));
    if (model.pageRarity.has(ref.i)) push(out, 'cards', 'Card desks', refs('card', model.byRarity[model.pageRarity.get(ref.i)]));
    if (model.pageNationality.has(ref.i)) {
      const nat = model.pageNationality.get(ref.i);
      push(out, 'sets', 'Sets', refs('set', data.sets.flatMap((set, i) => (set.nat === nat ? [i] : []))));
    }
    push(into, 'pages', 'Pages', pageRefs(model.pageIn[ref.i]));
    const kind = TEMPLATE_KIND[page.id];
    if (kind) {
      const size = kind === 'card' ? model.count : data[{ set: 'sets', era: 'eras', species: 'species', artist: 'artists' }[kind]].length;
      instances = { kind, count: size, refs: kind === 'card' ? [] : refs(kind, Array.from({ length: size }, (_, i) => i)) };
    }
  }
  return { out, into, instances };
}

/** Templates the map already draws as concrete nodes (sets, eras, desks, hubs). */
function drawnTemplate(id) {
  return Boolean(TEMPLATE_KIND[id]) || /^\/marketplace\/:lang\/(rarities|languages|guides)\/:slug$/.test(id);
}

/** Template out-links an instance inherits (every Set desk links to Sets, Marketplace home, …). */
export function templateLinks(model, kind) {
  const seen = new Set();
  for (const page of templatePages(model, kind)) {
    for (const to of model.pageOut[page]) {
      if (!drawnTemplate(model.data.pages[to].id)) seen.add(to);
    }
  }
  return [...seen].map((i) => ({ kind: 'page', i }));
}

export function refKey(model, ref) {
  const { data } = model;
  switch (ref.kind) {
    case 'card': return `card:${data.cards.id[ref.i]}`;
    case 'set': return `set:${data.sets[ref.i].slug}`;
    case 'era': return `era:${data.eras[ref.i].id}`;
    case 'species': return `pokemon:${data.species[ref.i].slug}`;
    case 'artist': return `artist:${data.artists[ref.i].slug}`;
    default: return `page:${data.pages[ref.i].id}`;
  }
}

export function refFromKey(model, key) {
  const text = String(key || '');
  const at = text.indexOf(':');
  if (at < 0) return null;
  const kind = text.slice(0, at);
  const value = text.slice(at + 1);
  const lookup = {
    card: () => model.cardIndex.get(Number(value)),
    set: () => model.setIndex.get(value),
    era: () => model.eraIndex.get(value),
    pokemon: () => model.speciesIndex.get(value),
    artist: () => model.artistIndex.get(value),
    page: () => model.pageById.get(value),
  }[kind];
  const i = lookup ? lookup() : undefined;
  if (i == null) return null;
  return { kind: kind === 'pokemon' ? 'species' : kind, i };
}

export function sameRef(a, b) {
  return Boolean(a && b && a.kind === b.kind && a.i === b.i);
}

export function normalizeQuery(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, ' ')
    .trim();
}

function matchScore(hay, q) {
  if (hay === q) return 0;
  if (hay.startsWith(q)) return 1;
  if (hay.includes(` ${q}`)) return 2;
  if (hay.includes(q)) return 3;
  return -1;
}

/** Hubs first (pages, eras, sets, Pokémon, artists), then card desks by name. */
export function createSearch(model) {
  const { data } = model;
  const hubs = [];
  data.pages.forEach((page, i) => hubs.push({ ref: { kind: 'page', i }, text: normalizeQuery(`${page.label} ${page.path}`), weight: 1e6 }));
  data.eras.forEach((era, i) => {
    if (model.setsOnEra[i].length) hubs.push({ ref: { kind: 'era', i }, text: normalizeQuery(era.name), weight: 1e6 });
  });
  data.sets.forEach((set, i) => hubs.push({ ref: { kind: 'set', i }, text: normalizeQuery(set.name), weight: set.n }));
  data.species.forEach((row, i) => hubs.push({ ref: { kind: 'species', i }, text: normalizeQuery(row.name), weight: row.n }));
  data.artists.forEach((row, i) => hubs.push({ ref: { kind: 'artist', i }, text: normalizeQuery(row.name), weight: row.n }));
  const names = data.names.map(normalizeQuery);
  const cardsByName = groupBy(Array.from(data.cards.name), names.length);

  function cardHits(q, budget) {
    const named = [];
    names.forEach((name, n) => {
      const score = matchScore(name, q);
      if (score >= 0) named.push({ n, score });
    });
    named.sort((a, b) => a.score - b.score || cardsByName[b.n].length - cardsByName[a.n].length);
    const out = [];
    for (const { n } of named) {
      for (const i of cardsByName[n]) {
        if (out.length >= budget) return out;
        out.push({ kind: 'card', i });
      }
    }
    return out;
  }

  /** Exact/prefix hubs, then a few card desks, then looser hub matches, then more desks. */
  return function search(query, limit = 10) {
    const q = normalizeQuery(query);
    if (!q) return [];
    const hits = [];
    for (const hub of hubs) {
      const score = matchScore(hub.text, q);
      if (score >= 0) hits.push({ ref: hub.ref, score, weight: hub.weight });
    }
    hits.sort((a, b) => a.score - b.score || b.weight - a.weight);
    const strong = hits.filter((hit) => hit.score <= 1).map((hit) => hit.ref);
    const loose = hits.filter((hit) => hit.score > 1).map((hit) => hit.ref);
    const cards = cardHits(q, limit);
    const out = strong.slice(0, limit - Math.min(4, cards.length));
    const take = (list, n) => out.push(...list.slice(0, Math.max(0, n)));
    const firstCards = Math.min(4, cards.length, limit - out.length);
    take(cards, firstCards);
    take(loose, limit - out.length);
    take(cards.slice(firstCards), limit - out.length);
    return out;
  };
}
