'use strict';

const http = require('http');
const https = require('https');
const { Client } = require('pg');
const { marketplaceDatabaseUrl } = require('./_marketplace_db');
const { command } = require('./_valkey');
const { meiliConfigured, meiliHealth } = require('./_meili_client');
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

async function probeValkey() {
  try {
    const reply = await withTimeout(command(['PING']), 'valkey');
    return reply === 'PONG' ? { ok: true } : { ok: false, error: reply == null ? 'econnrefused' : String(reply) };
  } catch (error) {
    return fail(error);
  }
}

async function probeMeili() {
  if (!meiliConfigured()) {
    return { ok: false, error: 'not_configured' };
  }
  try {
    const payload = await withTimeout(meiliHealth(), 'meili');
    return { ok: String(payload?.status || '') === 'available' };
  } catch (error) {
    return fail(error);
  }
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

async function pipelineHealth() {
  const [postgres, valkey, meili, cdn] = await Promise.all([
    probePostgres(),
    probeValkey(),
    probeMeili(),
    probeCdn(),
  ]);
  const checks = { postgres, valkey, meili, cdn };
  const skip = skippedHealthChecks();
  const ok = Object.entries(checks).every(
    ([name, row]) => skip.has(name) || (row && row.ok),
  );
  return {
    ok,
    service: apiServiceName(),
    checks,
  };
}

module.exports = {
  apiServiceName,
  pipelineHealth,
  probePostgres,
  probeValkey,
  probeMeili,
  probeCdn,
};
