'use strict';

/**
 * Rebuild the Redis Search card index from PostgreSQL.
 * Redis stays disposable: this is the repair path.
 *
 *   NODE_PATH=/app/node_modules REDIS_PORT=6380 node scripts/redis-search-reindex.js
 */

const { Client } = require('pg');
const net = require('node:net');

const INDEX = process.env.POKOIN_REDIS_INDEX || 'pokoin:cards';
const HOST = process.env.REDIS_HOST || '127.0.0.1';
const PORT = Number(process.env.REDIS_PORT || 6380);
const PREFIX = 'pokoin:card:';

const SELECT = `
  select
    c.card_id::text as card_id,
    c.name,
    public.marketplace_search_normalize(c.name) as name_normalized,
    public.marketplace_search_compact(c.name) as name_compact,
    coalesce(c.set_name, '') as set_name,
    coalesce(c.expansion_name, '') as expansion_name,
    coalesce(c.card_number, '') as card_number,
    coalesce(c.rarity, '') as rarity,
    coalesce(c.cdn_image_url, c.image_url, '') as cdn_image_url,
    coalesce(c.search_weight, 0) as search_weight,
    coalesce((
      select e.nationality
      from public.pokoin_pokemon_expansions e
      where e.name = c.set_name
      limit 1
    ), '') as nationality
  from public.marketplace_search_candidates c
`;

function printBucket(nationality) {
  const value = String(nationality || '').trim().toLowerCase();
  if (value === 'japanese' || value === 'ja' || value === 'jp') return 'japanese';
  if (value === 'korean' || value === 'ko') return 'korean';
  if (value === 'chinese' || value === 'zh' || value === 'cn' || value === 'zht') return 'chinese';
  if (value === 'indonesian' || value === 'id') return 'indonesian';
  if (value === 'thai' || value === 'th') return 'thai';
  if (['western', 'european', 'eu', 'american', 'us', 'french', 'fr', 'german', 'de'].includes(value)) {
    return 'western';
  }
  return 'unknown';
}

function encode(parts) {
  const buffers = [Buffer.from(`*${parts.length}\r\n`)];
  for (const part of parts) {
    const text = Buffer.from(String(part ?? ''));
    buffers.push(Buffer.from(`$${text.length}\r\n`));
    buffers.push(text);
    buffers.push(Buffer.from('\r\n'));
  }
  return Buffer.concat(buffers);
}

function parseOne(buf) {
  if (!buf.length) return null;
  const firstNl = buf.indexOf('\r\n');
  if (firstNl < 0) return null;
  const head = buf.slice(0, firstNl).toString('utf8');
  const kind = head[0];
  if (kind === '+' || kind === '-') return { value: head.slice(1), used: firstNl + 2, error: kind === '-' };
  if (kind === ':') return { value: Number(head.slice(1)), used: firstNl + 2 };
  if (kind === '$') {
    const size = Number(head.slice(1));
    if (size < 0) return { value: null, used: firstNl + 2 };
    const start = firstNl + 2;
    const end = start + size + 2;
    if (buf.length < end) return null;
    return { value: buf.slice(start, start + size).toString('utf8'), used: end };
  }
  if (kind === '*') {
    const count = Number(head.slice(1));
    if (count < 0) return { value: null, used: firstNl + 2 };
    let offset = firstNl + 2;
    const values = [];
    for (let i = 0; i < count; i += 1) {
      const parsed = parseOne(buf.slice(offset));
      if (!parsed) return null;
      values.push(parsed.value);
      offset += parsed.used;
    }
    return { value: values, used: offset };
  }
  return { value: null, used: buf.length, error: true };
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: HOST, port: PORT });
    let buffer = Buffer.alloc(0);
    const queue = [];
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (queue.length) {
        const parsed = parseOne(buffer);
        if (!parsed) return;
        buffer = buffer.slice(parsed.used);
        const item = queue.shift();
        if (parsed.error) item.reject(new Error(String(parsed.value)));
        else item.resolve(parsed.value);
      }
    });
    socket.on('connect', () => {
      resolve((parts) => new Promise((res, rej) => {
        queue.push({ resolve: res, reject: rej });
        socket.write(encode(parts));
      }));
    });
  });
}

async function main() {
  const url = process.env.MARKETPLACE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('MARKETPLACE_DATABASE_URL is required');
  const db = new Client({ connectionString: url });
  await db.connect();
  await db.query('set statement_timeout = 0');
  const send = await connect();
  const ping = await send(['PING']);
  if (ping !== 'PONG') throw new Error(`redis ping ${ping}`);
  await send(['FT.DROPINDEX', INDEX]).catch(() => {});
  await send([
    'FT.CREATE', INDEX,
    'ON', 'HASH',
    'PREFIX', '1', PREFIX,
    'STOPWORDS', '0',
    'SCHEMA',
    'name', 'TEXT', 'WEIGHT', '5',
    'name_normalized', 'TEXT', 'WEIGHT', '4',
    'name_compact', 'TEXT', 'WEIGHT', '5', 'NOSTEM',
    'nicknames', 'TEXT', 'WEIGHT', '3',
    'card_number', 'TEXT', 'WEIGHT', '2', 'NOSTEM',
    'set_name', 'TEXT', 'WEIGHT', '0.4',
    'expansion_name', 'TEXT', 'WEIGHT', '0.4',
    'language', 'TAG',
    'effective_print_bucket', 'TAG',
    'nationality', 'TAG',
    'search_weight', 'NUMERIC', 'SORTABLE',
    'card_id', 'TAG',
    'rarity', 'TEXT', 'NOINDEX',
    'cdn_image_url', 'TEXT', 'NOINDEX',
  ]);
  const started = Date.now();
  const result = await db.query(SELECT);
  let written = 0;
  const pending = [];
  for (const row of result.rows) {
    const id = String(row.card_id || '').trim();
    if (!id) continue;
    const print = printBucket(row.nationality);
    pending.push(send([
      'HSET', `${PREFIX}${id}`,
      'card_id', id,
      'name', row.name || '',
      'name_group', row.name || '',
      'name_normalized', row.name_normalized || '',
      'name_compact', row.name_compact || '',
      'nicknames', '',
      'card_number', row.card_number || '',
      'set_name', row.set_name || '',
      'expansion_name', row.expansion_name || '',
      'rarity', row.rarity || '',
      'cdn_image_url', row.cdn_image_url || '',
      'language', 'en',
      'nationality', String(row.nationality || '').toLowerCase(),
      'effective_print_bucket', print,
      'search_weight', String(Number(row.search_weight || 0)),
    ]));
    if (pending.length >= 200) {
      await Promise.all(pending.splice(0));
      written += 200;
      if (written % 5000 === 0) console.log(`indexed ${written}`);
    }
  }
  await Promise.all(pending);
  written = result.rows.length;
  const info = await send(['FT.INFO', INDEX]);
  console.log(JSON.stringify({
    indexed: written,
    ms: Date.now() - started,
    infoType: Array.isArray(info) ? 'array' : typeof info,
  }));
  await db.end();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
