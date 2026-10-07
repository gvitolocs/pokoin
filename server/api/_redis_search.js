'use strict';

/**
 * Redis Search candidate retrieval. Pokoin ranks the rows after this.
 * The query is high-recall: prefix on every token, fuzzy once the token
 * is long enough, and no fixed catalog ceiling.
 */

const net = require('node:net');

const INDEX = process.env.POKOIN_REDIS_INDEX || 'pokoin:cards';
const HOST = process.env.REDIS_HOST || process.env.VALKEY_HOST || '127.0.0.1';
const PORT = Number(process.env.REDIS_PORT || process.env.POKOIN_REDIS_PORT || 6380);
const TIMEOUT_MS = Number(process.env.REDIS_SEARCH_TIMEOUT_MS || 800);

function fold(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .toLowerCase();
}

function queryTokens(value) {
  const bits = fold(value).split(/[^a-z0-9]+/).filter((token) => token.length >= 2 || /^\d$/.test(token));
  return [...new Set(bits)].slice(0, 8);
}

function tokenClause(token) {
  // RediSearch prefix wildcards do not match numeric tokens (4* misses 4/102).
  if (/^\d+$/.test(token)) {
    return `(@card_number:${token} | @name:${token} | @set_name:${token} | @expansion_name:${token})`;
  }
  const parts = [
    `@name:${token}*`,
    `@name_compact:${token}*`,
    `@name_normalized:${token}*`,
    `@nicknames:${token}*`,
    `@card_number:${token}*`,
    `@set_name:${token}*`,
    `@expansion_name:${token}*`,
  ];
  if (token.length >= 6) {
    parts.push(`@name:%%${token}%%`, `@name_compact:%%${token}%%`);
  } else if (token.length >= 4) {
    parts.push(`@name:%${token}%`, `@name_compact:%${token}%`);
  }
  return `(${parts.join(' | ')})`;
}

function printClause(value) {
  const want = String(value || '').trim().toLowerCase();
  if (!want || want === 'all') return '';
  if (want === 'japanese' || want === 'ja' || want === 'jp' || want === 'ko' || want === 'korean' || want === 'jpko') {
    return '(@effective_print_bucket:{japanese} | @effective_print_bucket:{korean})';
  }
  if (!/^[a-z0-9_-]{2,24}$/.test(want)) return '';
  return `(@effective_print_bucket:{${want}})`;
}

function redisSearchQuery(raw, printLanguage) {
  const tokens = queryTokens(raw);
  if (!tokens.length) return '';
  const text = tokens.map(tokenClause).join(' ');
  const print = printClause(printLanguage);
  return print ? `(${text}) ${print}` : text;
}

function encode(parts) {
  const buffers = [Buffer.from(`*${parts.length}\r\n`)];
  for (const part of parts) {
    const text = Buffer.from(String(part));
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
  if (kind === '+' || kind === '-') {
    return { value: head.slice(1), used: firstNl + 2, error: kind === '-' };
  }
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

function command(parts) {
  return new Promise((resolve, reject) => {
    // Half-closing with socket.end() makes Node drop the reply: Redis answers
    // after the client FIN, and the readable side is already ended. Write the
    // command and read until the RESP value is complete, then destroy.
    const socket = net.connect({ host: HOST, port: PORT, allowHalfOpen: true });
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error('redis search timeout')));
    }, TIMEOUT_MS);
    socket.on('error', (error) => {
      finish(() => reject(error));
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const parsed = parseOne(buf);
      if (!parsed) return;
      if (parsed.error) {
        finish(() => reject(new Error(parsed.value || 'redis search failed')));
        return;
      }
      finish(() => resolve(parsed.value));
    });
    socket.on('connect', () => {
      socket.write(encode(parts));
    });
  });
}

function pairs(list) {
  const out = {};
  const rows = Array.isArray(list) ? list : [];
  for (let i = 0; i + 1 < rows.length; i += 2) {
    out[String(rows[i])] = rows[i + 1];
  }
  return out;
}

async function redisSearchCandidates(searchTerm, limit, offset = 0, options = {}) {
  const query = redisSearchQuery(searchTerm, options.printLanguage || options.print_language);
  if (!query) return { hits: [], estimatedTotalHits: 0, exhaustive: true, nextOffset: 0 };
  const size = Math.min(Math.max(Math.trunc(Number(limit) || 48), 1), 240);
  const start = Math.max(Math.trunc(Number(offset) || 0), 0);
  const reply = await command([
    'FT.SEARCH', INDEX, query,
    'LIMIT', String(start), String(size),
    'RETURN', '3', 'card_id', 'search_weight', 'effective_print_bucket',
    'DIALECT', '2',
    'TIMEOUT', String(TIMEOUT_MS),
  ]);
  const rows = Array.isArray(reply) ? reply : [];
  const total = Number(rows[0] || 0);
  const hits = [];
  for (let i = 1; i < rows.length; i += 2) {
    const fields = pairs(rows[i + 1]);
    const cardId = String(fields.card_id || '').trim();
    if (!cardId) continue;
    hits.push({
      card_id: cardId,
      meili_rank: Number(fields.search_weight || 0),
      meili_position: hits.length + 1,
      effective_print_bucket: fields.effective_print_bucket || '',
    });
  }
  return {
    hits,
    estimatedTotalHits: total,
    exhaustive: hits.length < size || start + hits.length >= total,
    nextOffset: start + hits.length,
  };
}

module.exports = {
  queryTokens,
  redisSearchQuery,
  redisSearchCandidates,
  INDEX,
};
