'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const rules = require('./_scan_connect');
const http = require('./_scan_http');

test('PIN is exactly four digits from the injected CSPRNG, zero padded', () => {
  assert.equal(rules.randomPin(() => 7), '0007');
  assert.equal(rules.randomPin(() => 9999), '9999');
  let seenArgs;
  rules.randomPin((min, max) => {
    seenArgs = [min, max];
    return 0;
  });
  assert.deepEqual(seenArgs, [0, 10000]);
  for (let i = 0; i < 2000; i += 1) {
    assert.match(rules.randomPin(), /^[0-9]{4}$/);
  }
  assert.equal(rules.isPin('0123'), true);
  for (const bad of ['123', '12345', '12a4', ' 1234', '', null, 1234.5]) {
    assert.equal(rules.isPin(bad), false, String(bad));
  }
});

test('phone tokens are 256-bit url-safe secrets and stored only as sha256', () => {
  const token = rules.randomSecret(32);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(rules.randomSecret(32), token);
  assert.match(rules.sha256(token), /^[0-9a-f]{64}$/);
  assert.notEqual(rules.sha256(token), token);
});

test('classification: matched needs 0.80 and a 0.08 margin; ambiguous 0.60+; else unmatched', () => {
  const hit = (id, score) => ({ public_id: id, score, name: `c${id}` });
  assert.equal(rules.classifyRecognition([hit('2', 0.91)]).state, 'matched');
  assert.equal(rules.classifyRecognition([hit('2', 0.91), hit('4', 0.82)]).state, 'matched');
  assert.equal(rules.classifyRecognition([hit('2', 0.91), hit('4', 0.84)]).state, 'ambiguous');
  assert.equal(rules.classifyRecognition([hit('2', 0.79)]).state, 'ambiguous');
  assert.equal(rules.classifyRecognition([hit('2', 0.60)]).state, 'ambiguous');
  assert.equal(rules.classifyRecognition([hit('2', 0.59)]).state, 'unmatched');
  assert.equal(rules.classifyRecognition([]).state, 'unmatched');
  const amb = rules.classifyRecognition([hit('2', 0.7), hit('4', 0.66), hit('6', 0.4)]);
  assert.deepEqual(amb.candidates.map((c) => c.cardId), ['2', '4']);
});

test('candidates use public_id only, never a TCGplayer id, and dedupe', () => {
  const list = rules.candidatesFromHits([
    { id: '632917', score: 0.99 },
    { public_id: '220962', score: 0.9 },
    { public_id: '220962', score: 0.85 },
    { public_id: 'abc', score: 0.95 },
    { public_id: '10', score: 'x' },
  ]);
  assert.deepEqual(list, [{ cardId: '220962', score: 0.9, name: '' }]);
});

test('defaults snapshot is the version in force at capture time', () => {
  const history = [
    { version: 1, changedAt: 1000, defaults: { language: 'IT' } },
    { version: 2, changedAt: 5000, defaults: { language: 'EN' } },
    { version: 3, changedAt: 9000, defaults: { language: 'JP', location: 'Box B' } },
  ];
  assert.equal(rules.pickDefaults(history, 4999).defaults.language, 'IT');
  assert.equal(rules.pickDefaults(history, 5000).defaults.language, 'EN');
  assert.equal(rules.pickDefaults(history, 8999).version, 2);
  const late = rules.pickDefaults(history, 12000);
  assert.equal(late.defaults.language, 'JP');
  assert.equal(late.defaults.location, 'Box B');
  // Captured before the first entry → first entry, never undefined.
  assert.equal(rules.pickDefaults(history, 10).defaults.language, 'IT');
  assert.equal(rules.pickDefaults([], 10).defaults.language, 'EN');
});

test('defaults changed while a scan is in flight: capture time wins, not receipt', () => {
  const history = [
    { version: 1, changedAt: 0, defaults: { language: 'IT' } },
    { version: 2, changedAt: 10_000, defaults: { language: 'EN' } },
  ];
  // Phone clock is 3 s behind the server. Captured at server 9 500, arrived 10 400.
  const inFlight = rules.capturedAtServer({ capturedAt: 6_500, clockOffsetMs: 3_000, receivedAtMs: 10_400 });
  assert.equal(inFlight, 9_500);
  assert.equal(rules.pickDefaults(history, inFlight).defaults.language, 'IT');
  // Captured 100 ms after the change even though the phone never saw it.
  const after = rules.capturedAtServer({ capturedAt: 7_100, clockOffsetMs: 3_000, receivedAtMs: 10_300 });
  assert.equal(rules.pickDefaults(history, after).defaults.language, 'EN');
});

test('capturedAtServer clamps skewed clocks and falls back to receipt', () => {
  assert.equal(rules.capturedAtServer({ capturedAt: 99_999_999, clockOffsetMs: 0, receivedAtMs: 1000 }), 1000);
  assert.equal(rules.capturedAtServer({ capturedAt: 1, clockOffsetMs: 0, receivedAtMs: 1000, floorMs: 500 }), 500);
  assert.equal(rules.capturedAtServer({ capturedAt: 'x', clockOffsetMs: 0, receivedAtMs: 1000 }), 1000);
  assert.equal(rules.capturedAtServer({ capturedAt: 900, clockOffsetMs: 90_000_000, receivedAtMs: 1000 }), 1000);
});

test('defaults normalize to Pokoin values and keep the base for missing keys', () => {
  const d = rules.normalizeDefaults({ language: 'it', condition: 'Mint', quantity: 400, location: ' Box A12 ', foilState: 'REVERSE' });
  assert.deepEqual(d, { ...rules.DEFAULT_BATCH_DEFAULTS, language: 'IT', condition: 'NM', quantity: 99, location: 'Box A12', foilState: 'reverse' });
  const partial = rules.normalizeDefaults({ signed: true }, d);
  assert.equal(partial.language, 'IT');
  assert.equal(partial.signed, true);
  // Start position rides beside the box: the label shows where the pile continues.
  assert.equal(rules.defaultsLabel(d), 'IT · NM · Reverse · Box A12·1 · Qty 99');
  // Size 1: startPosition is legacy flat counter → lands on stack.
  assert.equal(rules.normalizeDefaults({ startPosition: 3000 }).stack, 3000);
  assert.equal(rules.normalizeDefaults({ startPosition: 3000 }).startPosition, 1);
  assert.equal(rules.normalizeDefaults({ startPosition: 0 }, d).stack, 1);
  assert.equal(rules.normalizeDefaults({ startPosition: 99999 }, d).stack, 9999);
  assert.equal(rules.normalizeDefaults({ signed: true }, d).startPosition, 1);
  assert.equal(rules.normalizeDefaults({ signed: true }, d).stack, 1);
});

test('stack key: PowerTools identity mapped to Pokoin plus location', () => {
  const base = { cardId: '220962', condition: 'NM', language: 'IT', foilState: 'standard', firstEdition: false, signed: false, altered: false, graded: false, gradingCompany: '', grade: '', location: 'Box A12' };
  assert.equal(rules.stackKey(base), rules.stackKey({ ...base, location: 'box a12 ' }));
  for (const [key, value] of Object.entries({ cardId: '220964', condition: 'SP', language: 'EN', foilState: 'reverse', firstEdition: true, signed: true, altered: true, graded: true, gradingCompany: 'PSA', grade: '10', location: 'Binder 3' })) {
    assert.notEqual(rules.stackKey(base), rules.stackKey({ ...base, [key]: value }), key);
  }
  // snake_case rows from Postgres produce the same key.
  assert.equal(rules.stackKey(base), rules.stackKey({ card_id: '220962', condition: 'NM', language: 'IT', foil_state: 'standard', first_edition: false, signed: false, altered: false, graded: false, grading_company: '', grade: '', location: 'Box A12' }));
});

test('merge: only matched repeats with identical attributes into an active matched head', () => {
  const snapshot = rules.normalizeDefaults({ language: 'EN', location: 'Box A12' });
  const previous = { status: 'active', recognition_state: 'matched', card_id: '220962', condition: 'NM', language: 'EN', foil_state: 'standard', first_edition: false, signed: false, altered: false, graded: false, location: 'Box A12' };
  const matched = { state: 'matched' };
  assert.equal(rules.shouldMerge({ previous, recognition: matched, cardId: '220962', snapshot }), true);
  assert.equal(rules.shouldMerge({ previous, recognition: matched, cardId: '220964', snapshot }), false);
  assert.equal(rules.shouldMerge({ previous, recognition: { state: 'ambiguous' }, cardId: '220962', snapshot }), false);
  assert.equal(rules.shouldMerge({ previous: { ...previous, recognition_state: 'ambiguous' }, recognition: matched, cardId: '220962', snapshot }), false);
  assert.equal(rules.shouldMerge({ previous: { ...previous, recognition_state: 'ambiguous', reviewed: true }, recognition: matched, cardId: '220962', snapshot }), true);
  assert.equal(rules.shouldMerge({ previous: { ...previous, language: 'IT' }, recognition: matched, cardId: '220962', snapshot }), false);
  assert.equal(rules.shouldMerge({ previous: { ...previous, status: 'removed' }, recognition: matched, cardId: '220962', snapshot }), false);
  assert.equal(rules.shouldMerge({ previous, recognition: matched, cardId: '220962', snapshot: { ...snapshot, mergeRepeats: false } }), false);
  assert.equal(rules.shouldMerge({ previous: null, recognition: matched, cardId: '220962', snapshot }), false);
});

test('scan event parsing rejects bad ids, oversize and non-JPEG images', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]).toString('base64');
  const ok = rules.parseScanEvent({ scanEventId: '8f14e45f-ceea-4e7b-a3d2-5b6a3c9f1a2b', clientSequence: 3, capturedAt: 1, image: jpeg, recognition: { hits: [] }, timings: { identifyMs: 240.4, evil: 1 } });
  assert.equal(ok.clientSequence, 3);
  assert.equal(ok.image.length, 104);
  assert.deepEqual(ok.timings, { identifyMs: 240 });
  assert.throws(() => rules.parseScanEvent({ scanEventId: 'nope', clientSequence: 1 }), /UUID/);
  assert.throws(() => rules.parseScanEvent({ scanEventId: '8f14e45f-ceea-4e7b-a3d2-5b6a3c9f1a2b' }), /clientSequence/);
  assert.throws(() => rules.parseScanEvent({ scanEventId: '8f14e45f-ceea-4e7b-a3d2-5b6a3c9f1a2b', clientSequence: 1, image: Buffer.from('GIF89a').toString('base64') }), /JPEG/);
  const big = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(rules.MAX_IMAGE_BYTES)]).toString('base64');
  assert.throws(() => rules.parseScanEvent({ scanEventId: '8f14e45f-ceea-4e7b-a3d2-5b6a3c9f1a2b', clientSequence: 1, image: big }), (e) => e.statusCode === 413);
});

test('item patch validates Pokoin values and maps to columns', () => {
  const cols = rules.parseItemPatch({ language: 'jp', quantity: 4, pricePkn: 12.345, foilState: 'reverse', confirm: true, unknown: 1 });
  assert.deepEqual(cols, [
    { column: 'language', value: 'JP' },
    { column: 'foil_state', value: 'reverse' },
    { column: 'quantity', value: 4 },
    { column: 'price_pkn', value: 12.35 },
    { column: 'price_suggested', value: false },
    { column: 'reviewed', value: true },
  ]);
  assert.throws(() => rules.parseItemPatch({ quantity: 0 }), /Quantity/);
  assert.throws(() => rules.parseItemPatch({ quantity: 100 }), /Quantity/);
  assert.throws(() => rules.parseItemPatch({ condition: 'EX' }), /condition/);
  assert.throws(() => rules.parseItemPatch({ cardId: '12a' }), /card id/);
  assert.throws(() => rules.parseItemPatch({ pricePkn: -1 }), /price/);
});

test('submit readiness', () => {
  const ok = { status: 'active', card_id: '220962', recognition_state: 'matched', price_pkn: 10, quantity: 1 };
  assert.equal(rules.submitProblem(ok), '');
  assert.equal(rules.submitProblem({ ...ok, status: 'removed', card_id: null }), '');
  assert.equal(rules.submitProblem({ ...ok, card_id: null }), 'no_printing');
  assert.equal(rules.submitProblem({ ...ok, recognition_state: 'ambiguous' }), 'needs_review');
  assert.equal(rules.submitProblem({ ...ok, recognition_state: 'ambiguous', reviewed: true }), '');
  assert.equal(rules.submitProblem({ ...ok, price_pkn: null }), 'no_price');
  assert.equal(rules.submitProblem({ ...ok, graded: true, grading_company: 'PSA' }), 'grading_incomplete');
});

test('session view derives lost / scanning / expired', () => {
  const now = 1_000_000;
  const base = { id: 's', batch_id: 'b', status: 'connected', phone_last_seen_at: new Date(now - 1000), last_scan_at: null, version: 1 };
  assert.equal(rules.sessionView(base, now).phase, 'connected');
  assert.equal(rules.sessionView({ ...base, last_scan_at: new Date(now - 2000) }, now).phase, 'scanning');
  assert.equal(rules.sessionView({ ...base, phone_last_seen_at: new Date(now - rules.PHONE_LOST_MS) }, now).phase, 'lost');
  assert.equal(rules.sessionView({ ...base, status: 'ended', end_reason: 'expired' }, now).phase, 'expired');
  assert.equal(rules.sessionView({ ...base, status: 'ended', end_reason: 'logout' }, now).phase, 'completed');
  assert.equal(rules.sessionView({ ...base, status: 'waiting' }, now).phase, 'waiting');
  assert.equal(rules.isIdleExpired({ status: 'waiting', last_activity_at: new Date(now - rules.SESSION_IDLE_MS) }, now), true);
  assert.equal(rules.isIdleExpired({ status: 'ended', last_activity_at: new Date(0) }, now), false);
  // Connected phones use scan-idle, not the 30-minute waiting timer.
  assert.equal(rules.isIdleExpired({
    status: 'connected',
    last_activity_at: new Date(now - rules.SESSION_IDLE_MS),
  }, now), false);
});

test('scan idle: last_scan_at ?? phone_connected_at; heartbeat presence does not count', () => {
  const now = 2_000_000;
  const connected = {
    status: 'connected',
    phone_connected_at: new Date(now - rules.SCAN_IDLE_MS),
    last_scan_at: null,
    phone_last_seen_at: new Date(now), // fresh heartbeat must not keep the phone alive
    last_activity_at: new Date(now),
  };
  assert.equal(rules.scanIdleActivityMs(connected), now - rules.SCAN_IDLE_MS);
  assert.equal(rules.isScanIdleExpired(connected, now), true);
  assert.equal(rules.isScanIdleExpired({
    ...connected,
    phone_connected_at: new Date(now - rules.SCAN_IDLE_MS + 1),
  }, now), false);

  const scanned = {
    ...connected,
    phone_connected_at: new Date(now - 60 * 60_000),
    last_scan_at: new Date(now - rules.SCAN_IDLE_MS + 5_000),
  };
  assert.equal(rules.isScanIdleExpired(scanned, now), false);
  assert.equal(rules.isScanIdleExpired({
    ...scanned,
    last_scan_at: new Date(now - rules.SCAN_IDLE_MS),
  }, now), true);

  assert.equal(rules.isScanIdleExpired({ status: 'waiting', phone_connected_at: new Date(0) }, now), false);
  assert.equal(rules.isScanIdleExpired({ status: 'ended', phone_connected_at: new Date(0) }, now), false);
});

test('device label never echoes arbitrary user agents', () => {
  assert.equal(rules.deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'iPhone');
  assert.equal(rules.deviceLabel('Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile'), 'Android phone');
  assert.equal(rules.deviceLabel('curl/8'), 'Phone');
  assert.equal(rules.deviceLabel('', '  Giuseppe iPhone  '), 'Giuseppe iPhone');
});

test('CORS allowlist: production origins only; localhost outside production', () => {
  assert.equal(http.allowedOrigin('https://scan.pokoin.com', { NODE_ENV: 'production' }), 'https://scan.pokoin.com');
  assert.equal(http.allowedOrigin('https://pokoin.com', { NODE_ENV: 'production' }), 'https://pokoin.com');
  assert.equal(http.allowedOrigin('https://evil.example', { NODE_ENV: 'production' }), '');
  assert.equal(http.allowedOrigin('https://scan.pokoin.com.evil.example', { NODE_ENV: 'production' }), '');
  assert.equal(http.allowedOrigin('http://localhost:5174', { NODE_ENV: 'production' }), '');
  assert.equal(http.allowedOrigin('http://localhost:5174', { NODE_ENV: 'development' }), 'http://localhost:5174');
});

test('client IP prefers Cloudflare header', () => {
  assert.equal(http.clientIp({ headers: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' } }), '1.2.3.4');
  assert.equal(http.clientIp({ headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' } }), '9.9.9.9');
  assert.equal(http.clientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
  assert.equal(http.phoneToken({ headers: { authorization: 'Scan abc' } }), 'abc');
  assert.equal(http.phoneToken({ headers: { authorization: 'Bearer abc' } }), '');
});

test('stack defaults: size 1 hides position in label; size >1 shows stack·pos', () => {
  const d1 = rules.normalizeDefaults({ location: 'box1', stack: 3, stackSize: 1, startPosition: 9 });
  assert.equal(d1.startPosition, 1);
  assert.equal(d1.stack, 3);
  assert.equal(rules.locationDefaultsText(d1), 'box1·3');
  const d10 = rules.normalizeDefaults({ location: 'box1', stack: 2, stackSize: 10, startPosition: 5 });
  assert.equal(rules.locationDefaultsText(d10), 'box1·2·5');
});

test('boxSlots size 1: legacy flat startPosition still yields box·N', () => {
  const rows = [
    { id: 'a', location: 'box1', quantity: 1, defaults_snapshot: { startPosition: 47 } },
    { id: 'b', location: 'box1', quantity: 3, defaults_snapshot: { startPosition: 47 } },
  ];
  const slots = rules.boxSlots(rows);
  assert.equal(rules.slotText(slots.get('a')), '·47');
  assert.equal(rules.slotText(slots.get('b')), '·48-50');
});

test('boxSlots sized stacks: listing uses stack·pos and flags filledStack', () => {
  const rows = [
    { id: 'a', location: 'box1', quantity: 1, defaults_snapshot: { stack: 1, stackSize: 5, startPosition: 4 } },
    { id: 'b', location: 'box1', quantity: 2, defaults_snapshot: { stack: 1, stackSize: 5, startPosition: 4 } },
  ];
  const slots = rules.boxSlots(rows);
  assert.equal(rules.slotText(slots.get('a')), '·1·4');
  assert.equal(slots.get('a').filledStack, false);
  // b starts at max(5,4)=5 then takes 2 → abs 5-6 → stack1 pos5 + spill stack2 pos1
  assert.equal(slots.get('b').filledStack, true);
  assert.ok(rules.slotText(slots.get('b')).includes('·'));
});
