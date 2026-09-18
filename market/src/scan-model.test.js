import assert from 'node:assert/strict';
import test from 'node:test';
import { isDashboardHost, phoneConnectUrl } from './scan-api.js';
import {
  applyItems,
  batchCounts,
  candidateList,
  cycleFinish,
  defaultsLabel,
  DEFAULTS,
  frameEvents,
  nextAttentionIndex,
  orderedRows,
  phaseText,
  queueRows,
  rowProblem,
  sessionPhase,
  stackKey,
  stepCandidate,
  submitLabel,
  typeQuantity,
} from './scan-model.js';

const row = (id, extra = {}) => ({
  id,
  seq: 1,
  position: 1,
  status: 'active',
  recognitionState: 'matched',
  reviewed: false,
  cardId: '220962',
  condition: 'NM',
  language: 'EN',
  foilState: 'standard',
  quantity: 1,
  pricePkn: 10,
  ...extra,
});

test('duplicates, replays and out-of-order frames converge on the newest seq', () => {
  let rows = {};
  rows = applyItems(rows, [row('a', { seq: 3, condition: 'SP' })]);
  const same = applyItems(rows, [row('a', { seq: 3, condition: 'SP' })]);
  assert.equal(same, rows, 'identical replay returns the same object (no re-render)');
  rows = applyItems(rows, [row('a', { seq: 2, condition: 'NM' })]);
  assert.equal(rows.a.condition, 'SP', 'older frame ignored');
  rows = applyItems(rows, [row('a', { seq: 5, condition: 'MP' }), row('b', { seq: 4, position: 0.5 })]);
  assert.equal(rows.a.condition, 'MP');
  assert.deepEqual(orderedRows(rows).map((r) => r.id), ['b', 'a']);
});

test('queue hides merged repeats and removed rows; counts use quantities', () => {
  const rows = {
    a: row('a', { position: 1, quantity: 4 }),
    m1: row('m1', { position: 2, status: 'merged', mergedInto: 'a' }),
    b: row('b', { position: 3, recognitionState: 'ambiguous' }),
    c: row('c', { position: 4, pricePkn: null }),
    d: row('d', { position: 5, status: 'removed' }),
    e: row('e', { position: 6, cardId: '' , recognitionState: 'unmatched' }),
  };
  assert.deepEqual(queueRows(rows).map((r) => r.id), ['a', 'b', 'c', 'e']);
  const counts = batchCounts(rows);
  assert.deepEqual(counts, { rows: 4, cards: 7, needsReview: 1, noPrinting: 1, noPrice: 1, blocked: 3, merged: 1, ready: false });
  assert.equal(submitLabel({ cards: 187 }), 'Add 187 cards to Inventory');
  assert.equal(submitLabel({ cards: 1 }), 'Add 1 card to Inventory');
  assert.equal(submitLabel({ cards: 2 }, { intent: 'collection' }), 'Add 2 cards to collection');
});

test('row problems mirror the server submit rules', () => {
  assert.equal(rowProblem(row('a')), '');
  assert.equal(rowProblem(row('a', { recognitionState: 'ambiguous' })), 'needs_review');
  assert.equal(rowProblem(row('a', { recognitionState: 'ambiguous', reviewed: true })), '');
  assert.equal(rowProblem(row('a', { cardId: '' })), 'no_printing');
  assert.equal(rowProblem(row('a', { pricePkn: null })), 'no_price');
  assert.equal(rowProblem(row('a', { pricePkn: null }), { intent: 'collection' }), '');
  assert.equal(rowProblem(row('a', { recognitionState: 'ambiguous', pricePkn: null }), { intent: 'collection' }), 'needs_review');
  assert.equal(rowProblem(row('a', { graded: true, gradingCompany: 'PSA' })), 'grading_incomplete');
  assert.equal(rowProblem(row('a', { status: 'removed', cardId: '' })), '');
  assert.equal(batchCounts({ a: row('a', { pricePkn: null }) }, { intent: 'collection' }).ready, true);
  assert.equal(batchCounts({ a: row('a', { pricePkn: null }) }, { intent: 'list' }).ready, false);
});

test('stack key matches the CardVault vectors', () => {
  const base = { cardId: '220962', condition: 'NM', language: 'IT', foilState: 'standard', firstEdition: false, signed: false, altered: false, graded: false, gradingCompany: '', grade: '', location: 'Box A12' };
  assert.equal(stackKey(base), '220962|NM|IT|standard|0|0|0|0|||box a12');
  assert.equal(stackKey({ ...base, location: ' BOX A12 ' }), stackKey(base));
  assert.notEqual(stackKey({ ...base, foilState: 'reverse' }), stackKey(base));
});

test('attention walk wraps and skips clean rows', () => {
  const list = [row('a'), row('b', { pricePkn: null }), row('c'), row('d', { recognitionState: 'unmatched', cardId: '' })];
  assert.equal(nextAttentionIndex(list, -1), 1);
  assert.equal(nextAttentionIndex(list, 1), 3);
  assert.equal(nextAttentionIndex(list, 3), 1);
  assert.equal(nextAttentionIndex([row('a')], 0), -1);
});

test('frame events: merge toast carries from → to and the merged row for undo', () => {
  const before = { a: row('a', { quantity: 1 }) };
  const events = frameEvents(before, [row('m', { status: 'merged', mergedInto: 'a', quantity: 1, seq: 7 }), row('a', { quantity: 2, seq: 8 }), row('n', { seq: 9 })]);
  assert.deepEqual(events, [
    { type: 'merged', mergedId: 'm', headId: 'a', from: 1, to: 2 },
    { type: 'added', id: 'n', recognitionState: 'matched' },
  ]);
  assert.deepEqual(frameEvents({ n: row('n') }, [row('n', { seq: 10 })]), [], 'edits are not new rows');
});

test('session phase is recomputed locally with the server clock offset', () => {
  const now = Date.parse('2026-09-17T12:00:00Z');
  const connected = { status: 'connected', phase: 'connected', phoneLabel: 'iPhone', phoneLastSeenAt: '2026-09-17T11:59:58Z' };
  assert.equal(sessionPhase(connected, now), 'connected');
  assert.deepEqual(phaseText('connected', connected), {
    tone: 'ok',
    text: 'iPhone connected · disconnects after 10 min idle',
  });
  assert.equal(sessionPhase({ ...connected, phase: 'scanning' }, now), 'scanning');
  assert.equal(sessionPhase(connected, now + 15_000), 'lost');
  assert.equal(sessionPhase(connected, now + 15_000, -10_000), 'connected', 'desktop clock 10 s fast');
  assert.deepEqual(phaseText('lost'), { tone: 'warn', text: 'Connection lost — reconnecting' });
  assert.equal(sessionPhase({ status: 'waiting' }, now), 'waiting');
  assert.equal(phaseText('waiting').text, 'Waiting for phone…');
  assert.equal(sessionPhase({ status: 'ended', endReason: 'expired' }, now), 'expired');
  assert.equal(sessionPhase({ status: 'ended', endReason: 'completed' }, now), 'completed');
  assert.equal(phaseText('completed').text, 'Session completed');
});

test('defaults label, finish cycle, candidates, quantity typing', () => {
  assert.equal(defaultsLabel({ ...DEFAULTS, language: 'IT', location: 'Box A12' }), 'IT · NM · Box A12 · Qty 1');
  assert.equal(cycleFinish('standard'), 'holo');
  assert.equal(cycleFinish('other'), 'standard');
  assert.equal(cycleFinish('standard', -1), 'other');
  const r = row('a', { cardId: '2', recognition: { candidates: [{ cardId: '2', score: 0.8 }, { cardId: '4', score: 0.78 }, { cardId: '6', score: 0.7 }] } });
  assert.equal(stepCandidate(r, 1), '4');
  assert.equal(stepCandidate(r, -1), '6');
  assert.equal(stepCandidate(row('b', { recognition: {} }), 1), '');
  assert.equal(candidateList(row('c', { cardId: '9', cardName: 'X', recognition: { candidates: [{ cardId: '2' }] } }))[0].cardId, '9');
  assert.deepEqual(typeQuantity('', '4'), { buffer: '4', quantity: 4 });
  assert.deepEqual(typeQuantity('4', '2'), { buffer: '42', quantity: 42 });
  assert.deepEqual(typeQuantity('42', '7'), { buffer: '27', quantity: 27 });
  assert.deepEqual(typeQuantity('', '0'), { buffer: '', quantity: null });
});

test('QR link carries code and secret in the fragment; dashboard host detection', () => {
  assert.equal(phoneConnectUrl('AbCdEfGhIjKlMnOpQrStUvWxYz012345', '0427'), 'https://scan.pokoin.com/connect#c=0427&k=AbCdEfGhIjKlMnOpQrStUvWxYz012345');
  assert.equal(phoneConnectUrl('AbCdEfGhIjKlMnOpQrStUvWxYz012345'), 'https://scan.pokoin.com/connect#k=AbCdEfGhIjKlMnOpQrStUvWxYz012345');
  assert.equal(phoneConnectUrl('x', '12a4'), 'https://scan.pokoin.com/connect#k=x');
  assert.equal(isDashboardHost('dashboard.pokoin.com'), true);
  assert.equal(isDashboardHost('pokoin.com'), false);
  assert.equal(isDashboardHost('dashboard.pokoin.com.evil.example'), false);
});

test('createPatchChain serializes runs per key and survives failures', async () => {
  const { createPatchChain } = await import('./scan-model.js');
  const chain = createPatchChain();
  const order = [];
  const slow = () => new Promise((resolve) => setTimeout(() => { order.push('a'); resolve('a'); }, 20));
  const boom = () => Promise.reject(new Error('nope'));
  const quick = () => { order.push('c'); return 'c'; };
  const p1 = chain('row1', slow);
  const p2 = chain('row1', () => { order.push('b'); return 'b'; });
  const pf = chain('row1', boom).catch((err) => err.message);
  const p4 = chain('row1', quick);
  assert.deepEqual(await Promise.all([p1, p2, pf, p4]), ['a', 'b', 'nope', 'c']);
  assert.deepEqual(order, ['a', 'b', 'c']);
  // independent keys do not wait on each other
  let started = false;
  const slowA = chain('row1', () => new Promise((resolve) => setTimeout(resolve, 30)));
  const pOther = chain('row2', () => { started = true; return 'other'; });
  await pOther;
  assert.equal(started, true);
  await slowA;
});
