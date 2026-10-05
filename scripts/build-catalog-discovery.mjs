#!/usr/bin/env node
/** Card sitemaps for every TCG, plus Google Shopping feeds with availability and minimum price.
 * Queries the local writer when Docker is up. Does not call Google.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogShoppingOffer, shoppingCondition } from '../market/src/google-commerce.js';
import {
  CARD_SITEMAP_CHUNK,
  SHOPPING_FEED_CHUNK,
  cardSitemapFileName,
  chunkCardPaths,
  crawlableCardImage,
  gameCardPath,
  renderShoppingFeed,
  renderUrlSet,
  shoppingFeedFileName,
} from './card-sitemap.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://pokoin.com';
const CONTAINER = process.env.POKOIN_PG_CONTAINER || 'pokoin-marketplace-postgres-15t';
const PG_USER = 'pokoin_marketplace';

/** Writer database, public path prefix, feed id, Shopping brand. */
const GAMES = [
  ['pokoin_marketplace', '', 'pokemon', 'Pokémon'],
  ['pokoin_one_piece', 'one-piece', 'one_piece', 'One Piece'],
  ['pokoin_riftbound', 'riftbound', 'riftbound', 'Riftbound'],
  ['pokoin_magic', 'magic', 'magic', 'Magic: The Gathering'],
  ['pokoin_yugioh', 'yugioh', 'yugioh', 'Yu-Gi-Oh!'],
  ['pokoin_lorcana', 'lorcana', 'lorcana', 'Lorcana'],
  ['pokoin_flesh_and_blood', 'flesh-and-blood', 'flesh_and_blood', 'Flesh and Blood'],
  ['pokoin_digimon', 'digimon', 'digimon', 'Digimon'],
  ['pokoin_dragon_ball_super', 'dragon-ball-super', 'dragon_ball_super', 'Dragon Ball Super'],
  ['pokoin_vanguard', 'vanguard', 'vanguard', 'Cardfight!! Vanguard'],
  ['pokoin_star_wars', 'star-wars', 'star_wars', 'Star Wars Unlimited'],
  ['pokoin_union_arena', 'union-arena', 'union_arena', 'Union Arena'],
  ['pokoin_gundam', 'gundam', 'gundam', 'Gundam'],
  ['pokoin_sorcery', 'sorcery', 'sorcery', 'Sorcery'],
  ['pokoin_palworld', 'palworld', 'palworld', 'Palworld'],
  ['pokoin_cyberpunk', 'cyberpunk', 'cyberpunk', 'Cyberpunk'],
  ['pokoin_weiss_schwarz', 'weiss-schwarz', 'weiss_schwarz', 'Weiss Schwarz'],
  ['pokoin_force_of_will', 'force-of-will', 'force_of_will', 'Force of Will'],
  ['pokoin_world_of_warcraft', 'world-of-warcraft', 'world_of_warcraft', 'World of Warcraft TCG'],
  ['pokoin_battle_spirits_saga', 'battle-spirits-saga', 'battle_spirits_saga', 'Battle Spirits Saga'],
  ['pokoin_final_fantasy', 'final-fantasy', 'final_fantasy', 'Final Fantasy TCG'],
  ['pokoin_star_wars_destiny', 'star-wars-destiny', 'star_wars_destiny', 'Star Wars Destiny'],
  ['pokoin_the_spoils', 'the-spoils', 'the_spoils', 'The Spoils'],
  ['pokoin_my_little_pony', 'my-little-pony', 'my_little_pony', 'My Little Pony CCG'],
  ['pokoin_dragon_born', 'dragon-born', 'dragon_born', 'Dragoborne'],
];

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function psql(database, sql) {
  return execFileSync('docker', [
    'exec', CONTAINER,
    'psql', '-U', PG_USER, '-d', database,
    '-v', 'ON_ERROR_STOP=1',
    '-At', '-c', sql,
  ], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    if (row.some((cell) => cell !== '')) rows.push(row);
  }
  return rows;
}

function clearGenerated(dir) {
  for (const name of readdirSync(dir)) {
    if (/^sitemap-cards-\d{3}\.xml$/.test(name) || /^google-shopping-.+\.xml$/.test(name)) {
      unlinkSync(join(dir, name));
    }
  }
}

function shoppingItem(game, row, currency) {
  const [cardId, name, number, setName, productType, image, nativePkn, nativeQty, marketPkn] = row;
  const path = gameCardPath(row.path, game.slug);
  const offer = catalogShoppingOffer({
    nativePkn,
    nativeQty,
    marketPkn,
    currency,
  });
  if (!offer || !path || !/^https?:\/\//i.test(image || '')) return null;
  const title = [name, number, setName].map((part) => String(part || '').trim()).filter(Boolean).join(' ').slice(0, 150);
  const stock = offer.availability === 'in_stock' ? 'In stock' : 'Out of stock';
  const link = new URL(`${ORIGIN}${path}`);
  link.searchParams.set('currency', currency);
  return {
    id: `${game.id}-${cardId}-${currency}`,
    title: title || `${game.brand} card ${cardId}`,
    description: `${title || game.brand}. ${stock} · minimum ${offer.money.amount} ${offer.money.currency}.`,
    link: link.toString(),
    image,
    availability: offer.availability,
    price: offer.money.amount,
    currency: offer.money.currency,
    brand: game.brand,
    condition: shoppingCondition(productType),
  };
}

function writeFeeds(items, currency, dir) {
  const names = [];
  for (let index = 0; index < items.length; index += SHOPPING_FEED_CHUNK) {
    const chunk = items.slice(index, index + SHOPPING_FEED_CHUNK);
    const name = shoppingFeedFileName(currency, names.length);
    writeFileSync(join(dir, name), renderShoppingFeed(chunk, {
      title: `Pokoin ${currency}`,
      origin: ORIGIN,
    }));
    names.push(name);
  }
  return names;
}

const outDir = arg('--out') || ROOT;
let dockerOk = true;
try {
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', PG_USER, '-d', 'postgres', '-At', '-c', 'select 1'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  dockerOk = false;
  console.error(`catalog discovery skipped: ${error.message}`);
  process.exit(0);
}

if (!dockerOk) process.exit(0);

const paths = [];
const priced = [];
const games = [];
for (const [database, slug, id, brand] of GAMES) {
  const game = { database, slug, id, brand };
  let hasPrice = false;
  try {
    const hasMarket = psql(database, "select to_regclass('public.cheapest_homepage_cache_blueprint')").trim() !== '';
    const hasListings = psql(database, "select to_regclass('public.marketplace_user_listings')").trim() !== '';
    hasPrice = hasMarket || hasListings;
    const nativeSelect = hasListings
      ? `coalesce(n.cheapest_price_pkn, 0)::text, coalesce(n.eligible_quantity, 0)::text`
      : `0::text, 0::text`;
    const marketSelect = hasMarket
      ? `coalesce(m.cheapest_price_pkn, 0)::text`
      : `0::text`;
    const nativeJoin = hasListings
      ? `left join lateral (
          select min(l.price_pkn) as cheapest_price_pkn,
                 sum(l.quantity_available)::int as eligible_quantity
          from public.marketplace_user_listings l
          where l.card_id = u.card_id::text
            and l.status = 'active'
            and l.quantity_available > 0
            and l.price_pkn > 0
            and coalesce(l.source, '') not in ('cardtrader', 'cardtrader_live')
            and l.reserve_available is not true
            and coalesce(l.seller_uid, '') <> ''
            and l.shipping_available is distinct from false
        ) n on true`
      : '';
    const marketJoin = hasMarket
      ? `left join public.cheapest_homepage_cache_blueprint m
          on m.provider = 'cardtrader' and m.pokoin_card_id = u.card_id::text`
      : '';
    const sql = hasPrice
      ? `copy (
          select u.canonical_path, u.card_id::text, u.name, u.card_number, u.set_name, u.product_type,
                 coalesce(nullif(c.cdn_image_url, ''), nullif(c.image_url, ''), ''),
                 ${nativeSelect},
                 ${marketSelect}
          from public.marketplace_card_urls u
          left join public.marketplace_search_candidates c on c.card_id = u.card_id
          ${nativeJoin}
          ${marketJoin}
          where coalesce(u.canonical_path, '') <> ''
        ) to stdout with (format csv)`
      : `copy (
          select u.canonical_path,
                 coalesce(nullif(c.cdn_image_url, ''), nullif(c.image_url, ''), '')
          from public.marketplace_card_urls u
          left join public.marketplace_search_candidates c on c.card_id = u.card_id
          where coalesce(u.canonical_path, '') <> ''
        ) to stdout with (format csv)`;
    const rows = parseCsv(psql(database, sql));
    let gamePaths = 0;
    let gamePriced = 0;
    for (const cells of rows) {
      const path = gameCardPath(cells[0], slug);
      if (!path) continue;
      paths.push({ path, image: crawlableCardImage(hasPrice ? cells[6] : cells[1]) });
      gamePaths += 1;
      if (!hasPrice) continue;
      const itemRow = {
        path: cells[0],
        0: cells[1],
        1: cells[2],
        2: cells[3],
        3: cells[4],
        4: cells[5],
        5: cells[6],
        6: cells[7],
        7: cells[8],
        8: cells[9],
      };
      // shoppingItem reads row[0].. and row.path
      const shaped = [cells[1], cells[2], cells[3], cells[4], cells[5], cells[6], cells[7], cells[8], cells[9]];
      shaped.path = cells[0];
      const eur = shoppingItem(game, shaped, 'EUR');
      const dkk = shoppingItem(game, shaped, 'DKK');
      if (eur && dkk) {
        priced.push(eur, dkk);
        gamePriced += 1;
      }
    }
    games.push({ id, paths: gamePaths, priced: gamePriced });
  } catch (error) {
    console.error(`${database}: ${error.stderr || error.message}`);
  }
}

clearGenerated(outDir);
const chunks = chunkCardPaths(paths, CARD_SITEMAP_CHUNK);
const sitemapNames = chunks.map((_, index) => cardSitemapFileName(index));
chunks.forEach((chunk, index) => {
  writeFileSync(join(outDir, sitemapNames[index]), renderUrlSet(chunk, ORIGIN));
});
const eurItems = priced.filter((item) => item.currency === 'EUR');
const dkkItems = priced.filter((item) => item.currency === 'DKK');
const feedNames = [
  ...writeFeeds(eurItems, 'EUR', outDir),
  ...writeFeeds(dkkItems, 'DKK', outDir),
];
const list = feedNames.map((name) => `${ORIGIN}/${name}`).join('\n');
writeFileSync(join(outDir, 'google-shopping.txt'), `${list}\n`);
const inStock = eurItems.filter((item) => item.availability === 'in_stock').length;
console.log(JSON.stringify({
  games,
  sitemapFiles: sitemapNames.length,
  urls: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  shoppingFiles: feedNames,
  pricedCards: eurItems.length,
  inStock,
  outOfStock: eurItems.length - inStock,
}));
