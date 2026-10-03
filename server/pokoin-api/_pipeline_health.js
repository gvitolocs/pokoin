'use strict';

const http = require('http');
const https = require('https');
const net = require('node:net');
const { Client } = require('pg');
const { marketplaceDatabaseUrl } = require('./_marketplace_db');
const { sanitizeCheckError } = require('./_public_error');

const TIMEOUT_MS = Number(process.env.PIPELINE_HEALTH_TIMEOUT_MS || 800);
const CDN_HEALTH_URL = process.env.POKOIN_CDN_HEALTH_URL || 'http://127.0.0.1:18081/health';

function apiServiceName() {
  return process.env.POKOIN_API_SERVICE_NAME || 'pokoin-oracle-api';
}

function skippedHealthChecks() {
  return new Set(
    String(process.env.PIPELINE_HEALTH_SKIP || '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

function postgresSsl() {
  if (process.env.MARKETPLACE_DATABASE_SSL === '0') {
    return false;
  }
  return { rejectUnauthorized: process.env.MARKETPLACE_DATABASE_SSL_VERIFY === '1' };
}

function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout`)), TIMEOUT_MS);
    }),
  ]);
}

function fail(error) {
  const text = error && error.code ? String(error.code) : String((error && error.message) || 'down');
  return { ok: false, error: sanitizeCheckError(text) };
}

async function probePostgres() {
  const connectionString = marketplaceDatabaseUrl();
  if (!connectionString) {
    return { ok: false, error: 'not_configured' };
  }
  const sslVerify = process.env.MARKETPLACE_DATABASE_SSL_VERIFY === '1';
  const sanitized = sslVerify
    ? connectionString
    : connectionString
      .replace(/([?&])sslmode=[^&]+&?/i, (match, prefix) =>
        (prefix === '?' && match.endsWith('&') ? '?' : prefix === '?' ? '' : ''),
      )
      .replace(/[?&]$/, '');
  const client = new Client({
    connectionString: sanitized,
    connectionTimeoutMillis: TIMEOUT_MS,
    ssl: postgresSsl(),
  });
  try {
    await withTimeout(client.connect(), 'postgres connect');
    const result = await withTimeout(client.query('SELECT 1 AS ok'), 'postgres query');
    return { ok: Number(result.rows[0]?.ok) === 1 };
  } catch (error) {
    return fail(error);
  } finally {
    try {
      await client.end();
    } catch (_) {
      /* ignore */
    }
  }
}

function redisTarget() {
  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || process.env.POKOIN_REDIS_PORT || 6380),
  };
}

/** Dedicated PING. The shared cache socket pipelines other replies, so a
 * health check on that socket can observe SET "OK" or a cached document. */
function probeRedis() {
  const { host, port } = redisTarget();
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const done = (row) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(row);
    };
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), TIMEOUT_MS);
    socket.once('error', (error) => done(fail(error)));
    socket.once('connect', () => {
      socket.write('*1\r\n$4\r\nPING\r\n');
    });
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (!buf.includes('\n')) return;
      const line = buf.split('\r\n', 1)[0];
      done(line === '+PONG' ? { ok: true } : { ok: false, error: 'unexpected' });
    });
  });
}

function probeCdn() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    }, TIMEOUT_MS);
    const transport = CDN_HEALTH_URL.toLowerCase().startsWith('https:') ? https : http;
    const req = transport.get(CDN_HEALTH_URL, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve({ ok: false, error: `http_${res.statusCode}` });
          return;
        }
        resolve({ ok: true });
      });
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      resolve(fail(error));
    });
  });
}

function liveness() {
  return {
    ok: true,
    live: true,
    service: apiServiceName(),
  };
}

async function readiness() {
  const [postgres, redis, cdn] = await Promise.all([
    probePostgres(),
    probeRedis(),
    probeCdn(),
  ]);
  const skip = skippedHealthChecks();
  const required = { postgres, redis };
  const ok = Object.entries(required).every(
    ([name, row]) => skip.has(name) || (row && row.ok),
  );
  let cache = null;
  try {
    cache = require('./_redis_cache').redisCacheStats();
  } catch (_) {
    cache = null;
  }
  const target = redisTarget();
  return {
    ok,
    ready: ok,
    service: apiServiceName(),
    checks: {
      postgres: { ...postgres, role: 'required' },
      redis: {
        ...redis,
        role: 'required',
        host: target.host,
        port: target.port,
        cache,
      },
      cdn: { ...cdn, role: 'degraded' },
    },
    retired: ['meili', 'valkey'],
  };
}

async function pipelineHealth() {
  return readiness();
}

module.exports = {
  apiServiceName,
  liveness,
  readiness,
  pipelineHealth,
  probePostgres,
  probeRedis,
  probeCdn,
  redisTarget,
};
