'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();
const SLOW_MS = Number(process.env.POKOIN_TIMING_SLOW_MS || 40);

function emptySpan(route, method) {
  return {
    msg: 'pokoin_request',
    route: route || '',
    method: method || '',
    sqlMs: 0,
    sqlN: 0,
    meiliMs: 0,
    valkeyMs: 0,
    redisCacheMs: 0,
    firestoreMs: 0,
    cardtraderMs: 0,
    serializeMs: 0,
    t0: process.hrtime.bigint(),
  };
}

function beginRequest(route, method) {
  const span = emptySpan(route, method);
  storage.enterWith(span);
  return span;
}

function currentSpan() {
  return storage.getStore() || null;
}

async function timed(bucket, fn) {
  const span = currentSpan();
  const started = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    if (span) {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      span[bucket] = (span[bucket] || 0) + ms;
      if (bucket === 'sqlMs') span.sqlN += 1;
    }
  }
}

function round(ms) {
  return Math.round(ms * 10) / 10;
}

function finishRequest(span) {
  if (!span) return null;
  const totalMs = Number(process.hrtime.bigint() - span.t0) / 1e6;
  const line = {
    msg: span.msg,
    route: span.route,
    method: span.method,
    totalMs: round(totalMs),
    sqlMs: round(span.sqlMs),
    sqlN: span.sqlN,
    meiliMs: round(span.meiliMs),
    valkeyMs: round(span.valkeyMs),
    redisCacheMs: round(span.redisCacheMs || span.valkeyMs),
    firestoreMs: round(span.firestoreMs),
    cardtraderMs: round(span.cardtraderMs),
    serializeMs: round(span.serializeMs),
  };
  const logAll = process.env.POKOIN_TIMING === 'all';
  if (logAll || line.totalMs >= SLOW_MS) {
    console.log(JSON.stringify(line));
  }
  return line;
}

module.exports = {
  beginRequest,
  currentSpan,
  finishRequest,
  timed,
};
