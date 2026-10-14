#!/usr/bin/env node
/**
 * Golden cases for the card page's `card.deskArtUrl` (pokoin-rust
 * crates/catalog/src/desk_art.rs): the SPA's own answer, `clientDeskArtUrl`
 * in market/src/api.js, for real card-page payloads plus synthetic edge cases
 * (previews, CardTrader hosts, cache-buster ids, slugs, satellites).
 *
 *   node scripts/export-desk-art-golden.mjs --origin <api origin> --ids <file> [--rps 2] [--concurrency 1] [--out <json>]
 *
 * `--ids` lists `<game> <public card id>` per line. Read card pages from a
 * local candidate API or from https://api.pokoin.com at a low --rps; never
 * load-test the Pi. When a payload already carries `card.deskArtUrl` (a server
 * with desk_art.rs), every case is also compared with it and the script exits 1
 * on any mismatch. `cargo test -p pokoin-catalog` asserts the written fixture.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((out, arg, i, all) => {
  if (arg.startsWith('--')) out.push([arg.slice(2), all[i + 1]]);
  return out;
}, []));
const origin = String(args.origin || '').replace(/\/$/, '');
const rps = Math.max(0.2, Number(args.rps || 2));
const concurrency = Math.max(1, Math.min(8, Number(args.concurrency || 1)));
const outPath = args.out || `${root}pokoin-rust/crates/catalog/fixtures/desk-art-golden.json`;
if (!origin || !args.ids) {
  console.error('usage: export-desk-art-golden.mjs --origin <api origin> --ids <file> [--rps 2] [--out <json>]');
  process.exit(2);
}

// game() reads window.location; set it per case before computing.
globalThis.window = { location: { hostname: 'pokoin.com', pathname: '/marketplace' } };
const { clientDeskArtUrl } = await import('../market/src/api.js');
const { cdnFetchUrl, rasterSiblings } = await import('../market/src/image-urls.js');
const { cardStubFromRoute } = await import('../market/src/card-stub.js');
const { GAMES } = await import('../market/src/game.js');

const KEYS = [
  'id', 'card_id', 'name', 'canonicalPath', 'canonical_path',
  'heroImageUrl', 'imageUrl', 'cdn_image_url', 'image_url',
  'gridImageUrl', 'tileImageUrl', 'homepageImageUrl', 'homepage_image_url',
];

function useGame(game) {
  const slug = GAMES[game]?.slug || '';
  window.location = { hostname: 'pokoin.com', pathname: slug ? `/${slug}/marketplace` : '/marketplace' };
}

function golden(game, card) {
  useGame(game);
  return clientDeskArtUrl(card);
}

/** Only the fields deskArtUrl can read; '' and null read like a missing field. */
function subset(card) {
  const out = {};
  for (const key of KEYS) {
    const value = card?.[key];
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  // `a || b` chains never reach b when a is set: hero reads heroImageUrl first,
  // the grid gridImageUrl, the tile tileImageUrl, ids id, paths canonicalPath.
  if (out.id) delete out.card_id;
  if (out.canonicalPath) delete out.canonical_path;
  if (out.heroImageUrl && out.gridImageUrl) {
    delete out.imageUrl;
    delete out.cdn_image_url;
    delete out.image_url;
  }
  if (out.tileImageUrl) {
    delete out.homepageImageUrl;
    delete out.homepage_image_url;
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function fetchPage(game, id) {
  const params = new URLSearchParams({ cardId: id, lang: 'en' });
  const headers = { Accept: 'application/json' };
  if (game !== 'pokemon') {
    params.set('game', game);
    headers['x-pokoin-game'] = game;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(`${origin}/api/marketplace-card-page?${params}`, { headers, signal: AbortSignal.timeout(30000) });
      if (res.status === 404) return null;
      if (res.ok) return await res.json();
    } catch {
      /* retried */
    }
    await sleep(1000 * (attempt + 1));
  }
  return null;
}

const ids = readFileSync(args.ids, 'utf8').split('\n').map((line) => line.trim().split(/\s+/)).filter((p) => p.length === 2 && /^\d+$/.test(p[1]));
const pages = new Array(ids.length);
const started = Date.now();
let next = 0;
let done = 0;
async function worker() {
  while (next < ids.length) {
    const i = next;
    next += 1;
    const due = started + (i * 1000) / rps;
    if (due > Date.now()) await sleep(due - Date.now());
    pages[i] = await fetchPage(...ids[i]);
    done += 1;
    if (done % 250 === 0) console.error(`${done}/${ids.length}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

const real = [];
let served = 0;
let serverMismatch = 0;
let stubAgrees = 0;
let idempotent = 0;
for (const [i, [game, id]] of ids.entries()) {
  const card = pages[i]?.card;
  if (!card) continue;
  const url = golden(game, card);
  if (golden(game, subset(card)) !== url) console.error(`subset changes the answer ${game} ${id}`);
  real.push({ game, card: subset(card), url });
  // The desk <img> asks for rasterSiblings(deskArtUrl, full)[0]: it must be the same string.
  if (!url || cdnFetchUrl(rasterSiblings(url, { full: true })[0] || '') === url) idempotent += 1;
  else console.error(`not idempotent ${game} ${id}: ${url}`);
  const slug = String(card.canonicalPath || '').split('/').filter(Boolean).pop() || '';
  useGame(game);
  if (clientDeskArtUrl(cardStubFromRoute({ cardId: id, lang: 'en', slug })) === url) stubAgrees += 1;
  if (typeof card.deskArtUrl === 'string') {
    served += 1;
    if (card.deskArtUrl !== url) {
      serverMismatch += 1;
      console.error(`server mismatch ${game} ${id}: rust ${card.deskArtUrl} js ${url}`);
    }
  }
}

// Synthetic edge cases around real cards.
const synthetic = [];
function add(game, card) {
  synthetic.push({ game, card, url: golden(game, card) });
}
const pokemon = real.filter((c) => c.game === 'pokemon' && /^\d+$/.test(c.card.id || '')).slice(0, 12);
const SLUGS = [
  'card-umbreon-vmax-alternate-art-215-203-evolving-skies',
  'pikachu-svp-085-scarlet-violet-black-star-promos',
  'pikachu-world-championships-2023-svp-085-promos',
  'ultra-rare-mewtwo-gx',
  'mewtwo-gx-ultra-rare-sm12a',
  'special-illustration-rare-iono-sv2a-25',
  'tony-tony-chopper-op08-007a-op-08-two-legends',
  'monkey-d-luffy-115-romance-dawn',
  'eevee--pokemon-go',
  'product-booster-box-151',
  '12345',
  'flabébé-123-198-sv',
  'common',
  '-',
];
const NAMES = ['Farfetch’d', "Mr. Mime", 'Nidoran♀', 'Flabébé', '  Pikachu  ', '', 'Pokémon Center ex', 'İ', 'ΣΊΣΥΦΟΣ'];
const raw = (id) => [`/card-images/${id}_`, `https://cdn.pokoin.com/${id}_`, `https://CDN.pokoin.com/${id}_`];
for (const { card } of pokemon) {
  const id = card.id;
  const leftover = String(Number(id) / 2);
  const base = { id, name: card.name, canonicalPath: card.canonicalPath };
  add('pokemon', { ...base });
  add('pokemon', { ...base, heroImageUrl: `/card-images/previews/${leftover}_x.webp`, gridImageUrl: card.heroImageUrl });
  add('pokemon', { ...base, heroImageUrl: 'https://www.cardtrader.com/uploads/blueprints/image/1/x.jpg', tileImageUrl: card.tileImageUrl });
  add('pokemon', { ...base, imageUrl: ` ${card.heroImageUrl || ''} ` });
  add('pokemon', { ...base, heroImageUrl: String(card.heroImageUrl || '').replace(/\.jpg/, '.png') });
  add('pokemon', { ...base, heroImageUrl: String(card.heroImageUrl || '').replace(/\.jpg/, '_homepage.webp') });
  add('pokemon', { ...base, homepageImageUrl: String(card.heroImageUrl || '').replace(/\.jpg/, '_homepage.webp') });
  add('pokemon', { ...base, heroImageUrl: `${raw(leftover)[1]}wrong-name.jpg?x=1#frag` });
  add('pokemon', { ...base, heroImageUrl: `${raw(leftover)[2]}${card.name}.JPG?v=old` });
  add('pokemon', { ...base, heroImageUrl: `/card-images/${id}_${(card.canonicalPath || '').split('/').pop()}.jpg` });
  add('pokemon', { ...base, heroImageUrl: `/card-images/previews/${id}_x.jpg` });
  add('pokemon', { ...base, heroImageUrl: '/card-images/competitive/x.webp' });
  add('pokemon', { id: '', card_id: '', name: card.name, heroImageUrl: `/card-images/previews/${leftover}_x.jpg`, tileImageUrl: card.tileImageUrl });
  add('pokemon', { id: '', heroImageUrl: '', gridImageUrl: '', tileImageUrl: `/card-images/${leftover}_x_homepage.webp` });
  add('pokemon', { card_id: id, name: card.name, imageUrl: card.imageUrl });
  add('pokemon', { id: Number(id), name: card.name });
  add('pokemon', { id: String(Number(id) + 999000000), name: card.name, heroImageUrl: card.heroImageUrl });
  add('pokemon', { id: String(Number(id) + 1), name: card.name, heroImageUrl: card.heroImageUrl });
  add('pokemon', { id: `00${id}`, name: card.name });
  for (const slug of SLUGS) add('pokemon', { id, name: card.name, canonicalPath: `/marketplace/en/cards/${id}/${slug}` });
}
for (const name of NAMES) add('pokemon', { id: '806390', name });
add('pokemon', { id: '806390', name: 'Pikachu', canonicalPath: '/marketplace/en/cards/806390/pikachu' });
add('pokemon', { id: '0', name: 'Zero' });
add('pokemon', { id: 'abc', name: 'Letters', heroImageUrl: '/card-images/12_letters.jpg' });
add('pokemon', {});
// Every cache-buster table, by rule and by membership.
const table = JSON.parse(readFileSync(`${root}market/src/data/catalog-image-cache.json`, 'utf8'));
const lists = {
  'small-scan-ctf1': JSON.parse(readFileSync(`${root}market/src/data/small-scan-ctf1.json`, 'utf8')),
  'pokoin-placeholder-leftovers': JSON.parse(readFileSync(`${root}market/src/data/pokoin-placeholder-leftovers.json`, 'utf8')),
};
for (const rule of table.rules) {
  const members = [...(rule.ids || []), ...(lists[rule.idList] || []).filter((_, i) => i % 50 === 0)];
  for (const [from, to] of rule.ranges || []) members.push(from, to, Math.floor((from + to) / 2), from - 1, to + 1);
  for (const leftover of members) {
    const id = String(leftover * 2);
    add('pokemon', { id, name: 'Rule Card', heroImageUrl: `/card-images/${leftover}_rule-card.jpg` });
    add('pokemon', { id, name: 'Rule Card', heroImageUrl: `https://cdn.pokoin.com/${leftover}_rule-card.jpg?v=old` });
    add('pokemon', { id, name: 'Rule Card' });
  }
}
// Satellites: masters keep their extension; an empty image is the game's leftover key.
for (const game of Object.keys(GAMES).filter((g) => g !== 'pokemon')) {
  const slug = GAMES[game].slug;
  const card = real.find((c) => c.game === game)?.card || { id: '20', name: 'Satellite Card' };
  const id = card.id || '20';
  add(game, { id, name: card.name });
  add(game, { id, name: card.name, heroImageUrl: `/card-images/${slug}/10_card.png` });
  add(game, { id, name: card.name, heroImageUrl: `https://cdn.pokoin.com/${slug}/10_card_homepage.webp?v=2` });
  add(game, { id, name: card.name, heroImageUrl: `/card-images/${slug}/previews/10_card.webp`, gridImageUrl: `/card-images/${slug}/10_card.webp` });
  add(game, { id, name: card.name, heroImageUrl: `/card-images/${slug}/10_card` });
  add(game, { id, name: card.name, heroImageUrl: `/card-images/${slug.toUpperCase()}/10_card.JPEG` });
  add('pokemon', { id, name: card.name, heroImageUrl: `/card-images/${slug}/10_card.webp` });
}

const cases = [...real, ...synthetic];
const body = [
  '{',
  `  "about": "clientDeskArtUrl (market/src/api.js) answers; regenerate with scripts/export-desk-art-golden.mjs",`,
  `  "real": ${real.length},`,
  `  "synthetic": ${synthetic.length},`,
  '  "cases": [',
  cases.map((c) => `    ${JSON.stringify(c)}`).join(',\n'),
  '  ]',
  '}',
  '',
].join('\n');
writeFileSync(outPath, body);
const games = {};
for (const c of real) games[c.game] = (games[c.game] || 0) + 1;
console.log(JSON.stringify({
  real: real.length,
  synthetic: synthetic.length,
  games,
  servedDeskArtUrl: served,
  serverMismatch,
  idempotent,
  firstPaintStubAgrees: stubAgrees,
  out: outPath,
}));
if (serverMismatch) process.exit(1);
