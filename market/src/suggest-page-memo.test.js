import assert from 'node:assert/strict';
import test from 'node:test';
import { createPageMemo } from './suggest-page-memo.js';

function counting() {
  const calls = [];
  const fetchPage = async (query, options) => {
    calls.push([query, options?.offset || 0]);
    if (options?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (query === 'boom') throw new Error('network');
    return { groups: [{ name: query, offset: options?.offset || 0 }] };
  };
  return { calls, fetchPage };
}

test('a page that came back is not asked for again, whichever keystroke wants it', async () => {
  const { calls, fetchPage } = counting();
  const memo = createPageMemo(fetchPage);
  const first = await memo('mimikyu', { limit: 50, lang: 'en', signal: new AbortController().signal });
  const again = await memo('mimikyu', { lang: 'en', limit: 50, signal: new AbortController().signal });
  assert.equal(again, first, 'the same page object, whatever the order of the options');
  assert.deepEqual(calls, [['mimikyu', 0]]);
  await memo('mimikyu', { limit: 50, lang: 'en', offset: 50 });
  await memo('mimikyu', { limit: 50, lang: 'it' });
  await memo('mimikyu g', { limit: 50, lang: 'en' });
  assert.equal(calls.length, 4, 'another page, language or text is another request');
});

test('an aborted or failed request is not remembered', async () => {
  const { calls, fetchPage } = counting();
  const memo = createPageMemo(fetchPage);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(memo('pikachu', { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(memo('boom', {}), /network/);
  assert.equal(memo.size(), 0);
  await memo('pikachu', {});
  assert.deepEqual(calls.map(([query]) => query), ['pikachu', 'boom', 'pikachu']);
});

test('a page is asked for again after a minute, and the oldest pages make room', async () => {
  const { calls, fetchPage } = counting();
  let clock = 1000;
  const memo = createPageMemo(fetchPage, { ttlMs: 60000, max: 2, now: () => clock });
  await memo('a', {});
  clock += 59000;
  await memo('a', {});
  assert.equal(calls.length, 1);
  clock += 2000;
  await memo('a', {});
  assert.equal(calls.length, 2, 'older than the limit');
  await memo('b', {});
  await memo('a', {});
  await memo('c', {});
  assert.equal(memo.size(), 2);
  await memo('a', {});
  assert.equal(calls.length, 4, '`a` was used last and stayed');
  await memo('b', {});
  assert.equal(calls.length, 5, '`b` was the oldest and was dropped');
  memo.clear();
  assert.equal(memo.size(), 0);
});
