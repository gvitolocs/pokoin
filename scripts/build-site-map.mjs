#!/usr/bin/env node
/**
 * pokoin.com/sitemap graph: every page template, catalog hub and card desk,
 * and the links between them. Writes market/public/data/site-map.json.
 *
 *   node scripts/build-site-map.mjs [--cards cards.tsv] [--expansions exp.json]
 *
 * Page→page links come from the SPA source (App.jsx routes, <Link to>, href,
 * navigate(), APP.*, and the *Href helpers). Catalog links come from the
 * 15T marketplace Postgres (read-only SELECT via `docker exec`) and the public
 * expansion list. Needs nezopt, so it is not part of the Vercel build — rerun
 * it and commit the JSON when the catalog moves. See docs/SEO.md.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ERA_ORDER, TCG_ERA_ORDER, expansionEra, isSetVariant, tcgEra, tcgEraId } from '../market/src/set-logos.js';
import { LANGUAGE_HUBS, RARITY_HUBS, SEO_GUIDES, raritySlug } from '../market/src/seo.js';
import { pokedexSpeciesList } from '../market/src/pokemon-hubs.js';
import { artistSlug } from '../market/src/artist-name.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'market/src');
const OUT = join(ROOT, 'market/public/data/site-map.json');
/** Card thumbnails load on first hover, so the graph file stays small. */
const OUT_IMAGES = join(ROOT, 'market/public/data/site-map-images.json');
const CDN = 'https://cdn.pokoin.com/';
const PG_CONTAINER = process.env.SITE_MAP_PG_CONTAINER || 'pokoin-marketplace-postgres-15t';

const args = process.argv.slice(2);
const argValue = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : '';
};

const round = (n) => Math.round(n * 100) / 100;

/** Same as api.js setSlug — api.js pulls in the browser runtime, so it is not imported here. */
function setSlug(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
}

/* ------------------------------------------------------------------ routes */

const LABELS = {
  '/': 'Landing',
  '/marketplace': 'Marketplace home',
  '/marketplace/search': 'Search',
  '/marketplace/explore': 'Explore',
  '/marketplace/portfolio': 'Portfolio',
  '/marketplace/portfolio/:listingId': 'Portfolio item',
  '/marketplace/watchlist': 'Watchlist',
  '/favorites': 'Favorites',
  '/product/:kind': 'Products',
  '/marketplace/signal': 'Signal',
  '/marketplace/competitive': 'Competitive',
  '/marketplace/competitive/tournaments': 'Tournaments',
  '/marketplace/competitive/tournaments/:id': 'Tournament',
  '/marketplace/competitive/decks': 'Decks',
  '/marketplace/competitive/decks/:deckId': 'Deck',
  '/marketplace/competitive/decklists/:decklistId': 'Decklist',
  '/marketplace/competitive/players': 'Players',
  '/marketplace/competitive/players/:playerId': 'Player',
  '/marketplace/competitive/cards': 'Competitive cards',
  '/marketplace/competitive/cards/:cardId': 'Competitive card',
  '/marketplace/sets': 'Sets',
  '/marketplace/eras': 'Eras',
  '/marketplace/eras/:eraId': 'Era',
  '/marketplace/sets/:slug': 'Set',
  '/marketplace/:lang/artists': 'Artists',
  '/marketplace/:lang/artists/:artistSlug': 'Artist',
  '/marketplace/:lang/users/:username': 'Seller shop',
  '/marketplace/:lang/pokemon': 'Pokémon',
  '/marketplace/:lang/pokemon/:slug': 'Pokémon species',
  '/marketplace/:lang/rarities': 'Rarities',
  '/marketplace/:lang/rarities/:slug': 'Rarity',
  '/marketplace/:lang/languages': 'Languages',
  '/marketplace/:lang/languages/:slug': 'Language',
  '/marketplace/:lang/guides': 'Guides',
  '/marketplace/:lang/guides/:slug': 'Guide',
  '/marketplace/:lang/cards/:cardId/:slug/versions': 'Card versions',
  '/marketplace/:lang/cards/:cardId/versions': 'Card versions',
  '/marketplace/:lang/cards/:cardId/:slug?': 'Card',
  '/messages/:username': 'Conversation',
  '/forum/category/:categoryId': 'Forum category',
  '/forum/topic/:topicId': 'Forum topic',
  '/inventory/scan': 'Scan desk',
  '/email-preferences': 'Email preferences',
  '/extension/auth-bridge': 'Extension auth bridge',
  '/ocr/artists': 'OCR artists',
  '/marketplace/admin': 'Admin',
  '/marketplace/admin/edit': 'Admin edit',
  '/protection': 'Buyer protection',
  '/buy': 'Buy PKN',
};

/**
 * Not on the map: review boards live on test.pokoin.com only (vercel.json
 * redirects them off pokoin.com), and the extension auth bridge is plumbing.
 */
const OFF_MAP = new Set(['/tests', '/sanitize', '/espurr', '/ocr', '/ocr/artists', '/artwork', '/jumbos', '/extension/auth-bridge']);
const INTERNAL = new Set(['/admin', '/marketplace/admin', '/marketplace/admin/edit']);
const ACCOUNT = /^\/(auth|profile|cart|wallet|exchange|messages|checkout|orders|collection|inventory|scan|cardscan|scancard|buy|email-preferences|favorites|nft)\b|^\/marketplace\/(portfolio|watchlist)/;
const INFO = /^\/(docs|about|careers|contact|privacy|protection|earn|whitepaper|health)$/;

function routeGroup(path) {
  if (path === '/') return 'landing';
  if (INTERNAL.has(path)) return 'internal';
  if (/^\/marketplace\/competitive/.test(path)) return 'competitive';
  if (/^\/(forum|marketplace\/signal)/.test(path)) return 'community';
  if (INFO.test(path)) return 'info';
  if (ACCOUNT.test(path)) return 'account';
  return 'catalog';
}

function labelFor(path) {
  if (LABELS[path]) return LABELS[path];
  const last = path.split('/').filter((s) => s && !s.startsWith(':')).pop() || path;
  return last.charAt(0).toUpperCase() + last.slice(1).replace(/-/g, ' ');
}

function parseRoutes() {
  const app = readFileSync(join(SRC, 'App.jsx'), 'utf8');
  const componentFile = new Map();
  for (const m of app.matchAll(/import\s+(\w+)?\s*,?\s*(?:\{([^}]*)\})?\s*from\s+'(\.\/[^']+\.jsx)'/g)) {
    const file = resolve(SRC, m[3]);
    if (m[1]) componentFile.set(m[1], file);
    for (const named of String(m[2] || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      componentFile.set(named, file);
    }
  }
  const routes = new Map();
  const redirects = [];
  for (const line of app.split('\n')) {
    if (/import\.meta\.env\.DEV/.test(line)) continue;
    const m = line.match(/both\('([^']+)',\s*(.+)\)\}\s*$/);
    if (!m) continue;
    const [, path, element] = m;
    if (OFF_MAP.has(path)) continue;
    const redirect = element.match(/^<Navigate to="([^"]+)"/);
    if (redirect) {
      redirects.push([path, redirect[1]]);
      continue;
    }
    // pokoin.com/ is the static landing (index.html); the SPA only paints / on the dashboard host.
    const files = path === '/' ? [] : [...element.matchAll(/<([A-Z]\w*)/g)].map((c) => componentFile.get(c[1])).filter(Boolean);
    routes.set(path, { path, files });
  }
  return { routes, redirects };
}

/* ----------------------------------------------------- source link scanning */

const HELPERS = {
  cardHref: '/marketplace/:lang/cards/:cardId/:slug?',
  inventoryListingHref: '/marketplace/:lang/cards/:cardId/:slug?',
  dumpMarketplaceHref: '/marketplace/:lang/cards/:cardId/:slug?',
  versionsHref: '/marketplace/:lang/cards/:cardId/versions',
  artistHref: '/marketplace/:lang/artists/:artistSlug',
  pokemonHref: '/marketplace/:lang/pokemon/:slug',
  rarityHref: '/marketplace/:lang/rarities/:slug',
  languageHref: '/marketplace/:lang/languages/:slug',
  languageHrefFromNationality: '/marketplace/:lang/languages/:slug',
  guideHref: '/marketplace/:lang/guides/:slug',
  eraHref: '/marketplace/eras/:eraId',
  headingHref: '/marketplace/eras/:eraId',
  searchHref: '/marketplace/search',
  dumpSearchHref: '/marketplace/search',
  dumpItemHref: '/marketplace/portfolio/:listingId',
  sellerHref: '/marketplace/:lang/users/:username',
  authFrom: '/auth',
};

function listSource(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'data' && name !== 'node_modules') listSource(full, out);
    } else if (/\.jsx?$/.test(name) && !/\.test\.jsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function parseAppConstants() {
  const text = readFileSync(join(SRC, 'punchouts.js'), 'utf8');
  const block = text.slice(text.indexOf('export const APP = {'));
  const app = {};
  for (const m of block.slice(0, block.indexOf('};')).matchAll(/(\w+):\s*route\('([^']+)'\)/g)) {
    app[m[1]] = m[2];
  }
  return app;
}

function normalizeLink(raw) {
  let path = String(raw || '').replace(/\$\{[^}]*\}?/g, ':p');
  path = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  if (!path.startsWith('/') || /^\/(api|home|audit|review|data|download|card-images)\b/.test(path) || /\.\w{2,4}$/.test(path)) {
    return '';
  }
  return path;
}

function scanFile(file, appConstants) {
  const text = readFileSync(file, 'utf8');
  const imports = [];
  for (const m of text.matchAll(/import\s+[^'"]*?from\s+'(\.{1,2}\/[^']+)'/g)) {
    imports.push(resolve(dirname(file), m[1]));
  }
  const links = new Set();
  const add = (raw) => {
    const path = normalizeLink(raw);
    if (path) links.add(path);
  };
  if (/\.jsx$/.test(file)) {
    for (const m of text.matchAll(/(?:\bto|\bhref)=\{?\s*(['"`])(\/[^'"`]*)/g)) add(m[2]);
    for (const m of text.matchAll(/[{,]\s*(?:to|href):\s*(['"`])(\/[^'"`]*)/g)) add(m[2]);
    for (const m of text.matchAll(/\bnavigate\(\s*(['"`])(\/[^'"`]*)/g)) add(m[2]);
    for (const m of text.matchAll(/\bmarketUrl\(\s*(['"`])(\/[^'"`]*)/g)) add(m[2]);
    for (const m of text.matchAll(/\b\w*[Hh]ref\w*\s*=\s*[^;\n]*?(['"`])(\/[^'"`]*)/g)) add(m[2]);
    for (const m of text.matchAll(/\bAPP\.(\w+)/g)) if (appConstants[m[1]]) add(appConstants[m[1]]);
    for (const [name, pattern] of Object.entries(HELPERS)) {
      if (new RegExp(`\\b${name}\\(`).test(text)) links.add(pattern);
    }
  }
  return { imports, links };
}

function patternVariants(pattern) {
  if (!pattern.includes('?')) return [pattern];
  return [pattern.replace(/\/:[^/]+\?$/, ''), pattern.replace(/\?$/, '')];
}

function matchRoute(path, patterns) {
  if (patterns.includes(path)) return path;
  const want = path.split('/').filter(Boolean);
  let best = null;
  let bestScore = -1;
  for (const pattern of patterns) {
    for (const variant of patternVariants(pattern)) {
      const have = variant.split('/').filter(Boolean);
      if (have.length !== want.length) continue;
      let score = 0;
      let ok = true;
      for (let i = 0; i < have.length; i += 1) {
        if (have[i].startsWith(':')) score += want[i].startsWith(':') ? 1 : 0;
        else if (have[i] === want[i]) score += 2;
        else if (!want[i].startsWith(':')) { ok = false; break; }
      }
      if (ok && score > bestScore) {
        best = pattern;
        bestScore = score;
      }
    }
  }
  return best;
}

function buildPageGraph() {
  const { routes, redirects } = parseRoutes();
  const appConstants = parseAppConstants();
  const scans = new Map(listSource(SRC).map((file) => [file, scanFile(file, appConstants)]));
  const patterns = [...routes.keys()];
  const redirectTo = new Map(redirects);
  const resolveLink = (path) => {
    const target = redirectTo.get(path) ? normalizeLink(redirectTo.get(path)) : path;
    return matchRoute(target, patterns);
  };
  const chromeFile = join(SRC, 'components/Chrome.jsx');

  // A page's links are its own file plus the components it renders (not other pages, not the shell).
  function closure(files) {
    const seen = new Set();
    const stack = [...files];
    while (stack.length) {
      const file = stack.pop();
      if (seen.has(file) || !scans.has(file)) continue;
      seen.add(file);
      for (const dep of scans.get(file).imports) {
        const withExt = [dep, `${dep}.jsx`, `${dep}.js`].find((f) => scans.has(f));
        if (withExt && /\.jsx$/.test(withExt) && withExt !== chromeFile && !withExt.includes('/pages/')) {
          stack.push(withExt);
        }
      }
    }
    return seen;
  }
  function linksOf(files) {
    const out = new Set();
    for (const file of closure(files)) {
      for (const link of scans.get(file).links) {
        const route = resolveLink(link);
        if (route) out.add(route);
      }
    }
    return out;
  }

  const edges = new Map();
  for (const [path, route] of routes) {
    edges.set(path, linksOf(route.files));
  }
  // Apex landing (index.html → landing.html) is static HTML.
  const landing = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const landingLinks = new Set();
  for (const m of landing.matchAll(/href="(?:https:\/\/pokoin\.com)?(\/[^"]*)"/g)) {
    const route = resolveLink(normalizeLink(m[1]));
    if (route) landingLinks.add(route);
  }
  edges.set('/', new Set([...(edges.get('/') || []), ...landingLinks]));
  const chromeLinks = linksOf([chromeFile]);
  // Pages without the header & footer.
  const boards = new Set(['/']);
  return { routes: patterns, edges, chromeLinks, boards };
}

/* ------------------------------------------------------------ catalog data */

function loadCards() {
  const file = argValue('--cards');
  let text;
  if (file) {
    text = readFileSync(file, 'utf8');
  } else {
    // Market: cheapest of CardTrader (cheapest_homepage_cache_blueprint) and every active Pokoin
    // listing read live, so our own sellers count even when the nightly cache has not caught up.
    const sql = `select u.card_id, u.name, u.card_number, u.set_name, u.product_type,
        coalesce(c.pokedex_num, 10000), coalesce(nullif(c.artist, ''), c.illustrator, ''),
        coalesce(round(p.pkn), 0), coalesce(p.listings, 0), coalesce(c.homepage_image_url, ''),
        coalesce(p.snapshot, '')
      from marketplace_card_urls u
      left join marketplace_search_candidates c on c.card_id = u.card_id
      left join (
        select pokoin_card_id, min(pkn) as pkn, sum(listings) as listings, max(snapshot)::text as snapshot
        from (
          select pokoin_card_id, cheapest_price_pkn as pkn, eligible_listing_count as listings,
            coalesce(source_snapshot_at, updated_at) as snapshot
          from cheapest_homepage_cache_blueprint
          where provider = 'cardtrader' and cheapest_price_pkn > 0
          union all
          select card_id, price_pkn, 1, updated_at
          from marketplace_user_listings
          where status = 'active' and quantity_available > 0 and price_pkn > 0
            and coalesce(shipping_available, true)
        ) offers
        group by pokoin_card_id
      ) p on p.pokoin_card_id = u.card_id::text
      where u.language = 'en'`;
    const run = spawnSync('docker', ['exec', '-i', PG_CONTAINER, 'sh', '-c', 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "\t" -v ON_ERROR_STOP=1'], {
      input: sql,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
    if (run.status !== 0) {
      throw new Error(`psql failed: ${run.stderr}`);
    }
    text = run.stdout;
  }
  return text.split('\n').filter(Boolean).map((line) => {
    const f = line.split('\t');
    // --cards may be the wider export (…, rarity, product_type, item_kind, path, dex, artist, expansion).
    if (f.length === 11 && f[7].startsWith('/marketplace/')) {
      return { id: Number(f[0]), name: f[1], number: f[2], set: f[3], type: f[5], dex: Number(f[8]), artist: f[9], pkn: 0, listings: 0, image: '', snapshot: '' };
    }
    return {
      id: Number(f[0]),
      name: f[1],
      number: f[2],
      set: f[3],
      type: f[4],
      dex: Number(f[5]),
      artist: f[6],
      pkn: Number(f[7]) || 0,
      listings: Number(f[8]) || 0,
      image: f[9] || '',
      snapshot: f[10] || '',
    };
  });
}

async function loadExpansions() {
  const file = argValue('--expansions');
  if (file) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data.expansions || data.sets || [];
  }
  const response = await fetch('https://api.pokoin.com/api/marketplace-expansion-page?limit=2000', {
    headers: { Accept: 'application/json', 'User-Agent': 'pokoin-site-map/1' },
  });
  if (!response.ok) throw new Error(`expansion list ${response.status}`);
  const data = await response.json();
  return data.expansions || data.sets || [];
}

/** "Holo Rare | 4/102" → 4, "SV 12a" → 12. Keeps collector order inside a set disc. */
function collectorKey(number) {
  const tail = String(number || '').split('|').pop();
  const m = tail.match(/(\d+)/);
  return m ? Number(m[1]) : 1e9;
}

/* ------------------------------------------------------------------ layout */

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const CARD_SPACING = 1;

function discRadius(n) {
  return CARD_SPACING * Math.sqrt(Math.max(n, 1)) + 1.2;
}

/** Pack circles around (0,0): phyllotaxis seed, then pairwise relaxation. Returns enclosing radius. */
function packCircles(items, { iterations = 260, gap = 1.2 } = {}) {
  items.sort((a, b) => b.r - a.r);
  const mean = items.reduce((s, it) => s + it.r, 0) / Math.max(items.length, 1);
  items.forEach((it, i) => {
    const d = mean * 1.9 * Math.sqrt(i);
    it.x = Math.cos(i * GOLDEN) * d;
    it.y = Math.sin(i * GOLDEN) * d;
  });
  for (let step = 0; step < iterations; step += 1) {
    const pull = 0.04 * (1 - step / iterations);
    for (const it of items) {
      it.x -= it.x * pull;
      it.y -= it.y * pull;
    }
    for (let i = 0; i < items.length; i += 1) {
      const a = items[i];
      for (let j = i + 1; j < items.length; j += 1) {
        const b = items[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        const min = a.r + b.r + gap;
        if (d >= min) continue;
        if (d < 1e-6) { dx = 1; dy = 0; d = 1; }
        const push = (min - d) / d / 2;
        const wa = b.r / (a.r + b.r);
        const wb = 1 - wa;
        a.x -= dx * push * 2 * wa; a.y -= dy * push * 2 * wa;
        b.x += dx * push * 2 * wb; b.y += dy * push * 2 * wb;
      }
    }
  }
  return items.reduce((m, it) => Math.max(m, Math.hypot(it.x, it.y) + it.r), 1);
}

/** Small spring layout for the page core (≈100 nodes, O(n²) is fine). */
function forceLayout(nodes, links, { iterations = 600 } = {}) {
  nodes.forEach((n, i) => {
    n.x = Math.cos(i * GOLDEN) * 10 * Math.sqrt(i + 1);
    n.y = Math.sin(i * GOLDEN) * 10 * Math.sqrt(i + 1);
    n.vx = 0; n.vy = 0;
  });
  for (let step = 0; step < iterations; step += 1) {
    const alpha = 1 - step / iterations;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]; const b = nodes[j];
        const dx = b.x - a.x; const dy = b.y - a.y;
        const d2 = Math.max(dx * dx + dy * dy, 1);
        const f = (900 * alpha) / d2;
        a.vx -= dx * f; a.vy -= dy * f;
        b.vx += dx * f; b.vy += dy * f;
      }
    }
    for (const [s, t] of links) {
      const a = nodes[s]; const b = nodes[t];
      const dx = b.x - a.x; const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = ((d - 22) / d) * 0.02 * alpha;
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const n of nodes) {
      n.vx -= n.x * 0.006; n.vy -= n.y * 0.006;
      n.x += n.vx; n.y += n.vy;
      n.vx *= 0.55; n.vy *= 0.55;
    }
  }
}

/* -------------------------------------------------------------------- main */

async function main() {
  const pageGraph = buildPageGraph();
  const cards = loadCards();
  const expansions = await loadExpansions();

  // Eras: oldest TCG block first around the ring, then the Japanese / Chinese / Other shelves.
  const eraNames = [...[...TCG_ERA_ORDER].reverse(), ...ERA_ORDER.filter((e) => !TCG_ERA_ORDER.includes(e))];
  const eras = eraNames.map((name) => ({ id: tcgEraId(name), name, sets: [], r: 0 }));
  const eraIndex = new Map(eras.map((e, i) => [e.name, i]));

  // Sets: the public expansion list, plus any set a card desk links to that the list does not carry.
  const sets = [];
  const setIndex = new Map();
  const addSet = (row) => {
    const slug = String(row.slug || setSlug(row.name)).trim();
    if (!slug || setIndex.has(slug)) return setIndex.get(slug);
    const tcg = tcgEra({ slug, name: row.name, set: row.name });
    const shelf = expansionEra(row);
    const home = tcg !== 'Other' ? tcg : shelf;
    const listedOn = new Set();
    if (!isSetVariant(row)) {
      listedOn.add(eraIndex.get(tcg));
      if (shelf === 'Japanese' || shelf === 'Chinese') listedOn.add(eraIndex.get(shelf));
    }
    const set = {
      slug,
      name: row.name || slug,
      nat: String(row.nationality || 'western').toLowerCase(),
      era: eraIndex.get(home) ?? eraIndex.get('Other'),
      listedOn: [...listedOn].filter((i) => i != null),
      listed: Boolean(row.slug),
      cards: [],
    };
    setIndex.set(slug, sets.length);
    sets.push(set);
    return setIndex.get(slug);
  };
  for (const row of expansions) addSet(row);

  const species = pokedexSpeciesList().map((row) => ({ slug: row.slug, name: row.name, dex: row.n, cards: [] }));
  const speciesByDex = new Map(species.map((row, i) => [row.dex, i]));

  const artists = [];
  const artistIndex = new Map();
  const rarityIndex = new Map(RARITY_HUBS.map((row, i) => [row.slug, i]));

  for (const card of cards) {
    const s = addSet({ name: card.set, slug: '' });
    card.s = s;
    card.sp = speciesByDex.has(card.dex) ? speciesByDex.get(card.dex) : -1;
    const aSlug = artistSlug(card.artist);
    if (aSlug) {
      if (!artistIndex.has(aSlug)) {
        artistIndex.set(aSlug, artists.length);
        artists.push({ slug: aSlug, name: card.artist.trim(), cards: [] });
      }
      card.ar = artistIndex.get(aSlug);
    } else {
      card.ar = -1;
    }
    const prefix = String(card.number || '').includes('|') ? card.number.split('|')[0].trim() : '';
    card.ra = prefix && rarityIndex.has(raritySlug(prefix)) ? rarityIndex.get(raritySlug(prefix)) : -1;
    sets[s].cards.push(card);
  }

  // Layout: card stars on a phyllotaxis disc per set, sets packed per era, eras on a ring.
  for (const set of sets) {
    set.cards.sort((a, b) => collectorKey(a.number) - collectorKey(b.number) || a.id - b.id);
    set.r = discRadius(set.cards.length);
    eras[set.era].sets.push(set);
  }
  for (const era of eras) {
    era.r = era.sets.length ? packCircles(era.sets, { gap: 1.6 }) : 4;
  }
  const liveEras = eras.filter((e) => e.sets.length);
  const eraGap = 10;
  const circumference = liveEras.reduce((s, e) => s + 2 * e.r + eraGap, 0);
  const maxEra = Math.max(...liveEras.map((e) => e.r));
  const coreRadius = 70;
  const ringRadius = Math.max(circumference / (2 * Math.PI), coreRadius + maxEra + 25);
  let arc = 0;
  for (const era of eras) {
    if (!era.sets.length) {
      era.x = 0; era.y = 0;
      continue;
    }
    arc += era.r + eraGap / 2;
    const angle = -Math.PI / 2 + (arc / circumference) * Math.PI * 2;
    arc += era.r + eraGap / 2;
    era.x = Math.cos(angle) * ringRadius;
    era.y = Math.sin(angle) * ringRadius;
    for (const set of era.sets) {
      set.x += era.x;
      set.y += era.y;
    }
  }
  const galaxyRadius = ringRadius + maxEra;

  // Every card desk links to its species and artist: rings outside the galaxy, lines on selection.
  for (const set of sets) {
    set.cards.forEach((card, k) => {
      const d = CARD_SPACING * Math.sqrt(k + 0.5);
      card.x = set.x + Math.cos(k * GOLDEN) * d;
      card.y = set.y + Math.sin(k * GOLDEN) * d;
      if (card.sp >= 0) species[card.sp].cards.push(card);
      if (card.ar >= 0) artists[card.ar].cards.push(card);
    });
  }
  const speciesRadius = Math.max(galaxyRadius + 45, (species.length * 3.2) / (2 * Math.PI));
  species.forEach((row, i) => {
    const angle = -Math.PI / 2 + (i / species.length) * Math.PI * 2;
    row.x = Math.cos(angle) * speciesRadius;
    row.y = Math.sin(angle) * speciesRadius;
  });
  const liveArtists = artists.filter((a) => a.cards.length);
  for (const artist of liveArtists) {
    const cx = artist.cards.reduce((s, c) => s + c.x, 0) / artist.cards.length;
    const cy = artist.cards.reduce((s, c) => s + c.y, 0) / artist.cards.length;
    artist.theta = Math.atan2(cy, cx);
  }
  // Artists sit on the outer ring at the angle of their work, spread evenly so labels never stack.
  liveArtists.sort((a, b) => a.theta - b.theta);
  const artistRadius = Math.max(speciesRadius + 40, (liveArtists.length * 3.2) / (2 * Math.PI));
  const start = liveArtists.length ? liveArtists[0].theta : 0;
  liveArtists.forEach((artist, i) => {
    const angle = start + (i / liveArtists.length) * Math.PI * 2;
    artist.x = Math.cos(angle) * artistRadius;
    artist.y = Math.sin(angle) * artistRadius;
  });

  // Page core: route templates, the shell, and the small hub instances (rarities, languages, guides).
  const pages = [];
  const pageIndex = new Map();
  const addPage = (page) => {
    pageIndex.set(page.id, pages.length);
    pages.push(page);
    return pages.length - 1;
  };
  for (const path of pageGraph.routes) {
    addPage({
      id: path,
      path: path.replace(/:lang\b/, 'en'),
      label: labelFor(path),
      group: routeGroup(path),
      template: /:\w/.test(path.replace(/:lang\b/, 'en')),
    });
  }
  const shell = addPage({ id: 'chrome', path: '', label: 'Header & footer', group: 'shell', template: false });
  const hubInstances = [
    ...RARITY_HUBS.map((row) => ({ id: `rarity:${row.slug}`, path: `/marketplace/en/rarities/${row.slug}`, label: row.name, group: 'catalog', of: '/marketplace/:lang/rarities/:slug', index: '/marketplace/:lang/rarities' })),
    ...LANGUAGE_HUBS.map((row) => ({ id: `language:${row.slug}`, path: `/marketplace/en/languages/${row.slug}`, label: row.name, group: 'catalog', of: '/marketplace/:lang/languages/:slug', index: '/marketplace/:lang/languages' })),
    ...SEO_GUIDES.map((row) => ({ id: `guide:${row.slug}`, path: `/marketplace/en/guides/${row.slug}`, label: row.title, group: 'catalog', of: '/marketplace/:lang/guides/:slug', index: '/marketplace/:lang/guides' })),
  ];
  for (const hub of hubInstances) addPage({ ...hub, template: false });

  const pageLinks = new Set();
  const link = (a, b) => {
    if (a != null && b != null && a !== b) pageLinks.add(`${a},${b}`);
  };
  for (const [from, targets] of pageGraph.edges) {
    for (const to of targets) link(pageIndex.get(from), pageIndex.get(to));
  }
  for (const [path] of pageGraph.edges) {
    if (!pageGraph.boards.has(path)) link(pageIndex.get(path), shell);
  }
  for (const to of pageGraph.chromeLinks) link(shell, pageIndex.get(to));
  for (const hub of hubInstances) {
    link(pageIndex.get(hub.index), pageIndex.get(hub.id));
    // An instance links wherever its template links.
    for (const to of pageGraph.edges.get(hub.of) || []) link(pageIndex.get(hub.id), pageIndex.get(to));
  }
  const pageLinkList = [...pageLinks].map((s) => s.split(',').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  // Layout the core without the shell's fan-out (it links everywhere and would sit on top of everything).
  const coreLinks = pageLinkList.filter(([a, b]) => a !== shell && b !== shell);
  forceLayout(pages, coreLinks);
  const coreExtent = pages.reduce((m, p) => Math.max(m, Math.hypot(p.x, p.y)), 1);
  const coreFit = (ringRadius - maxEra - 18) / coreExtent;
  for (const page of pages) {
    page.x *= coreFit;
    page.y *= coreFit;
  }

  // Link census. The shell (header + footer) is on every non-board page, so it is counted per page.
  const cardCount = cards.length;
  const withSpecies = cards.filter((c) => c.sp >= 0).length;
  const withArtist = cards.filter((c) => c.ar >= 0).length;
  const withRarity = cards.filter((c) => c.ra >= 0).length;
  const setEraLinks = sets.reduce((s, set) => s + set.listedOn.length, 0);
  const catalogLinks =
    sets.length + eras.length + species.length + liveArtists.length // index → instance
    + setEraLinks // era → set
    + cardCount * 2 // set ↔ card
    + withSpecies * 2 + withArtist * 2 + withRarity * 2; // species / artist / rarity ↔ card
  const pageCount = pageGraph.routes.filter((p) => !/:\w/.test(p.replace(/:lang\b/, 'en'))).length
    + hubInstances.length + eras.length + sets.length + species.length + liveArtists.length + cardCount;
  const shellLinks = pageGraph.chromeLinks.size * (pageCount - pageGraph.boards.size);

  const names = [];
  const nameIndex = new Map();
  const nameOf = (name) => {
    if (!nameIndex.has(name)) {
      nameIndex.set(name, names.length);
      names.push(name);
    }
    return nameIndex.get(name);
  };
  const ordered = sets.flatMap((set) => set.cards);
  const artistOut = new Map(liveArtists.map((a, i) => [a, i]));

  const out = {
    version: 1,
    generatedAt: new Date().toISOString(),
    stats: {
      pages: pageCount,
      templates: pageGraph.routes.length,
      cards: cardCount,
      sets: sets.length,
      eras: eras.filter((e) => e.sets.length).length,
      species: species.length,
      artists: liveArtists.length,
      pageLinks: pageLinkList.length,
      catalogLinks,
      shellLinks,
      links: pageLinkList.length + catalogLinks + shellLinks,
      listed: cards.filter((c) => c.pkn > 0).length,
      marketAt: cards.reduce((m, c) => (c.snapshot > m ? c.snapshot : m), '').slice(0, 10),
    },
    radii: { core: round(ringRadius - maxEra), galaxy: round(galaxyRadius), species: round(speciesRadius), artists: round(artistRadius) },
    pages: pages.map((p) => ({ id: p.id, path: p.path, label: p.label, group: p.group, template: p.template || undefined, x: round(p.x), y: round(p.y) })),
    pageLinks: pageLinkList,
    eras: eras.map((e) => ({ id: e.id, name: e.name, x: round(e.x), y: round(e.y), r: round(e.r) })),
    sets: sets.map((s) => ({
      slug: s.slug,
      name: s.name,
      nat: s.nat,
      era: s.era,
      on: s.listedOn,
      listed: s.listed ? undefined : false,
      x: round(s.x),
      y: round(s.y),
      n: s.cards.length,
    })),
    species: species.map((s) => ({ slug: s.slug, name: s.name, dex: s.dex, x: round(s.x), y: round(s.y), n: s.cards.length })),
    artists: liveArtists.map((a) => ({ slug: a.slug, name: a.name, x: round(a.x), y: round(a.y), n: a.cards.length })),
    rarities: RARITY_HUBS.map((row) => pageIndex.get(`rarity:${row.slug}`)),
    languages: Object.fromEntries(LANGUAGE_HUBS.map((row) => [row.nationality, pageIndex.get(`language:${row.slug}`)])),
    // Columnar, grouped by set in collector order: star k of set s sits at golden-angle step k.
    cards: {
      spacing: CARD_SPACING,
      id: ordered.map((c) => c.id),
      name: ordered.map((c) => nameOf(c.name)),
      num: ordered.map((c) => c.number),
      sp: ordered.map((c) => c.sp),
      ar: ordered.map((c) => (c.ar >= 0 ? artistOut.get(artists[c.ar]) : -1)),
      ra: ordered.map((c) => c.ra),
      sealed: ordered.map((c) => (c.type && c.type !== 'card' ? 1 : 0)),
      // Listed cheapest PKN (0 = no listing) and live listing count at build time.
      pkn: ordered.map((c) => c.pkn),
      lc: ordered.map((c) => c.listings),
    },
    names,
  };
  // Same order as cards: CDN key (…_homepage.webp implied) or a full URL for odd ones.
  const images = ordered.map((c) => {
    const url = String(c.image || '');
    if (url.startsWith(CDN) && url.endsWith('_homepage.webp')) return url.slice(CDN.length, -'_homepage.webp'.length);
    return url;
  });
  const imagesBody = JSON.stringify({ cdn: CDN, suffix: '_homepage.webp', images });
  if (!existsSync(OUT_IMAGES) || readFileSync(OUT_IMAGES, 'utf8') !== imagesBody) {
    writeFileSync(OUT_IMAGES, imagesBody);
  }

  // Weekly refresh commits only real changes: keep the old file (and its date) when only the date differs.
  const body = (json) => JSON.stringify({ ...json, generatedAt: '' });
  const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  if (previous && body(previous) === body(out)) {
    console.log(`site-map unchanged since ${previous.generatedAt}`);
    return;
  }
  writeFileSync(OUT, JSON.stringify(out));
  const size = statSync(OUT).size;
  console.log(`site-map ${relative(ROOT, OUT)} ${(size / 1e6).toFixed(2)} MB`, out.stats);
  const unlisted = sets.filter((s) => !s.listed && s.cards.length);
  if (unlisted.length) {
    console.log(`${unlisted.length} card set names are not on the expansion list (kept as sets):`, unlisted.slice(0, 8).map((s) => s.name));
  }
  if (!existsSync(OUT)) process.exit(1);
}

await main();
