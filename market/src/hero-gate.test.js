import test from 'node:test';
import assert from 'node:assert/strict';
import { afterHero, heroOpen, holdForHero, holdIfDeskPath, onHeroGate, releaseHero } from './hero-gate.js';

test('waiting work runs once the hero lands, in order, and only once', () => {
  releaseHero();
  const ran = [];
  holdForHero(60_000);
  assert.equal(heroOpen(), false);
  afterHero(() => ran.push('a'));
  const cancel = afterHero(() => ran.push('cancelled'));
  afterHero(() => ran.push('b'));
  cancel();
  assert.deepEqual(ran, []);
  releaseHero();
  releaseHero();
  assert.deepEqual(ran, ['a', 'b']);
  assert.equal(heroOpen(), true);
  afterHero(() => ran.push('now'));
  assert.deepEqual(ran, ['a', 'b', 'now'], 'an open gate runs at once');
});

test('the gate never stays closed past its wait', async () => {
  releaseHero();
  holdForHero(20);
  let ran = false;
  afterHero(() => { ran = true; });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(ran, true);
  assert.equal(heroOpen(), true);
});

test('listeners hear open and close', () => {
  releaseHero();
  const seen = [];
  const stop = onHeroGate((open) => seen.push(open));
  holdForHero(60_000);
  releaseHero();
  stop();
  holdForHero(60_000);
  releaseHero();
  assert.deepEqual(seen, [false, true]);
});

test('only card desk URLs close the gate on load', () => {
  for (const path of [
    '/marketplace/en/cards/806390',
    '/marketplace/en/cards/806390/card-mega-rayquaza-ex',
    '/marketplace/zht/cards/1/x/',
    '/one-piece/marketplace/en/cards/816522',
  ]) {
    releaseHero();
    assert.equal(holdIfDeskPath(path, 60_000), true, path);
    assert.equal(heroOpen(), false, path);
  }
  for (const path of ['/marketplace', '/marketplace/en/cards/806390/versions', '/marketplace/en/users/redshakkio', '/marketplace/sets/base-set']) {
    releaseHero();
    assert.equal(holdIfDeskPath(path, 60_000), false, path);
    assert.equal(heroOpen(), true, path);
  }
  releaseHero();
});
