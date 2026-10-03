import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildScope,
  candidatesFromSuggestPayload,
  chunkSize,
  consumePage,
  createGenerationClock,
  emptyPool,
  filterCandidates,
  FIRST_CHUNK,
  FOLLOW_CHUNK,
  mergeCandidates,
  paintSource,
  prepareCandidate,
  projectPoolGroups,
  rankCandidates,
  reuseDecision,
  shouldContinue,
} from './suggest-pool.js';

function card(id, name, extra = {}) {
  return prepareCandidate({ id, name, card_number: extra.number || '', set_name: extra.set || '', ...extra });
}

test('a longer prefix reuses the pool and a scope change drops it', () => {
  const scope = buildScope({ query: 'pika', lang: 'en', printLang: 'all', kind: 'singles' });
  assert.equal(reuseDecision('pika', 'pikac', scope, buildScope({ query: 'pikac' })).action, 'narrow');
  assert.equal(reuseDecision('pikachu', 'pika', scope, buildScope({ query: 'pika' })).action, 'broaden');
  assert.equal(reuseDecision('pika', 'char', scope, buildScope({ query: 'char' })).reason, 'query-diverged');
  assert.equal(
    reuseDecision('pika', 'pika', scope, buildScope({ query: 'pika', printLang: 'western' })).reason,
    'print-language',
  );
  assert.equal(
    reuseDecision('pika', 'pika', scope, buildScope({ query: 'pika', lang: 'ja' })).reason,
    'language',
  );
  assert.equal(
    reuseDecision('pika', 'pika', scope, buildScope({ query: 'pika', kind: 'product' })).reason,
    'kind',
  );
  assert.equal(
    reuseDecision('charizard', '4/102', scope, buildScope({ query: '4/102' })).reason,
    'mode',
  );
  assert.equal(
    reuseDecision('charizard', 'charizard 4/102', buildScope({ query: 'charizard' }), buildScope({ query: 'charizard 4/102' })).reason,
    'mode',
  );
  assert.equal(
    reuseDecision('chariza', 'charizar', buildScope({ query: 'chariza' }), buildScope({ query: 'charizar' })).action,
    'narrow',
  );
  assert.equal(
    reuseDecision('base set', 'base set charizard', buildScope({ query: 'base set' }), buildScope({ query: 'base set charizard' })).action,
    'narrow',
  );
});

test('pikac immediately keeps Pikachu rows from the pika pool', () => {
  const pool = [
    card('1', 'Pikachu'),
    card('2', 'Pikachu VMAX'),
    card('3', 'Charizard'),
    card('4', 'Surfing Pikachu VMAX'),
  ];
  const narrowed = rankCandidates(pool, 'pikac').map((row) => row.name);
  assert.deepEqual(narrowed, ['Pikachu', 'Pikachu VMAX', 'Surfing Pikachu VMAX']);
  const painted = paintSource(
    { query: 'pika', scope: buildScope({ query: 'pika' }), rows: pool },
    'pikac',
    buildScope({ query: 'pikac' }),
  );
  assert.equal(painted.decision.action, 'narrow');
  assert.equal(painted.rows.length, 4);
  assert.equal(filterCandidates(painted.rows, 'pikac').some((row) => row.name === 'Charizard'), false);
});

test('a set-title prefix on the same stem does not blank the local cards', () => {
  const rows = [card('1', 'Charizard'), card('2', 'Charizard V'), card('3', 'Charmander')];
  const painted = paintSource(
    { query: 'chariza', scope: buildScope({ query: 'chariza' }), rows },
    'charizar',
    buildScope({ query: 'charizar' }),
  );
  assert.equal(painted.decision.action, 'narrow');
  const names = (projectPoolGroups('charizar', painted.rows, { limit: 20 }) || []).map((group) => group.name);
  assert.ok(names.includes('Charizard'));
  assert.equal(names.includes('Charmander'), false);
});

test('a late generation cannot move the pool backwards', () => {
  const pool = emptyPool();
  const clock = createGenerationClock();
  pool.generation = clock.next();
  pool.query = 'pika';
  const first = consumePage(pool, pool.generation, {
    groups: [{ name: 'Pikachu', printings: [card('1', 'Pikachu')] }],
  });
  assert.equal(first.applied, true);
  const older = clock.current();
  pool.generation = clock.next();
  const stale = consumePage(pool, older, {
    groups: [{ name: 'Charizard', printings: [card('9', 'Charizard')] }],
  });
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, 'stale');
  assert.deepEqual(pool.rows.map((row) => row.name), ['Pikachu']);
  assert.equal(pool.stale, 1);
});

test('chunks stop when the visible list is filled and keep paging while it is not', () => {
  assert.equal(chunkSize(0), FIRST_CHUNK);
  assert.equal(chunkSize(1), FOLLOW_CHUNK);
  assert.equal(FIRST_CHUNK, 50);
  assert.equal(shouldContinue({
    compactLength: 1, fetched: 50, chunkHits: 50, chunks: 1, visibleRows: 50,
  }), false);
  assert.equal(shouldContinue({
    compactLength: 7, fetched: 50, chunkHits: 50, chunks: 1, visibleRows: 20, estimatedTotal: 400,
  }), false);
  assert.equal(shouldContinue({
    compactLength: 4, fetched: 50, chunkHits: 50, chunks: 1, visibleRows: 8, estimatedTotal: 400,
  }), true);
  assert.equal(shouldContinue({
    compactLength: 4, fetched: 50, chunkHits: 50, chunks: 1, exhaustive: true, visibleRows: 8,
  }), false);
});

test('keystroke local rank stays inside one frame on a few thousand candidates', () => {
  const rows = [];
  const names = ['Pika', 'Pikachu', 'Pikachu V', 'Charizard', 'Charmander', 'Charizard ex'];
  for (let index = 0; index < 2000; index += 1) {
    rows.push(card(String(index), names[index % names.length], { number: `${index}/200` }));
  }
  const steps = ['p', 'pi', 'pik', 'pika', 'pikac', 'pikachu'];
  let available = rows;
  const timings = [];
  for (const step of steps) {
    const started = performance.now();
    available = rankCandidates(rows, step);
    const localMs = performance.now() - started;
    timings.push({ step, localMs, kept: available.length });
    assert.ok(localMs < 16, `${step} local rank ${localMs.toFixed(2)}ms`);
  }
  assert.ok(timings.find((row) => row.step === 'pikac').kept > 0);
  assert.equal(timings.find((row) => row.step === 'pikac').kept < timings.find((row) => row.step === 'pika').kept, true);
  projectPoolGroups('warmup', rows, { limit: 20 });
  const ranked = [];
  for (const step of ['pika', 'pikac', 'pikachu']) {
    const started = performance.now();
    const groups = projectPoolGroups(step, rows, { limit: 20 });
    const ms = performance.now() - started;
    ranked.push({ step, ms: Number(ms.toFixed(3)), groups: groups.length });
    assert.ok(ms < 16, `${step} project ${ms.toFixed(2)}ms`);
  }
  console.log(JSON.stringify({ local: timings, ranked }));
});

test('merged chunks keep identity and do not duplicate', () => {
  const merged = mergeCandidates(
    [card('1', 'Pikachu')],
    candidatesFromSuggestPayload({
      groups: [{ name: 'Pikachu', printings: [card('1', 'Pikachu'), card('2', 'Pikachu V')] }],
    }),
  );
  assert.deepEqual(merged.rows.map((row) => row._id), ['1', '2']);
  assert.equal(merged.added, 1);
});
