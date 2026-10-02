import assert from 'node:assert/strict';
import test from 'node:test';
import { createNamePrintingsFetcher } from './name-printings.js';

test('keystrokes and search callers share the same bounded name catalog request', async () => {
  let resolve;
  const page = new Promise((done) => { resolve = done; });
  const calls = [];
  const fetchCards = createNamePrintingsFetcher({
    fetchRows: (request) => { calls.push(request); return page; },
    mapCard: (row) => ({ ...row, id: row.card_id }),
  });
  const first = fetchCards('Mewtwo');
  const concurrent = fetchCards('mewtwo');
  assert.equal(first, concurrent);
  await Promise.resolve();
  assert.deepEqual(calls, [{ name: 'Mewtwo', lang: 'en', limit: 1000 }]);
  resolve([{ card_id: '236804', name: 'Mewtwo', set: 'Evolutions', number: '51/108' }]);
  const [one, two] = await Promise.all([first, concurrent]);
  assert.equal(one, two);
  assert.equal(one[0].number, '51/108');
});

test('name hydration preserves metadata, deduplicates identities and stamps its title language', async () => {
  const calls = [];
  const fetchCards = createNamePrintingsFetcher({
    fetchRows: async (request) => {
      calls.push(request);
      return [{ id: '1', localized_name: 'Glurak', set: 'Evolutions' },
        { id: '1' }, { id: '', name: 'Missing identity' }];
    },
    mapCard: (row) => row,
  });
  const [de, en, anotherName] = await Promise.all([
    fetchCards('Charizard', { lang: 'de' }), fetchCards('Charizard'), fetchCards('Palkia'),
  ]);
  assert.equal(calls.length, 3, 'names and title languages are separate requests');
  assert.equal(de.length, 1);
  assert.equal(de[0].localized_name, 'Glurak');
  assert.equal(de[0].set, 'Evolutions');
  assert.equal(de[0].search_lang, 'de');
  assert.equal(en[0].search_lang, 'en');
  assert.equal(anotherName[0].search_lang, 'en');
});

test('failed and malformed name catalog responses release the request for a retry', async () => {
  const outcomes = [new Error('network unavailable'), null, []];
  const fetchCards = createNamePrintingsFetcher({
    fetchRows: async () => {
      const result = outcomes.shift();
      if (result instanceof Error) throw result;
      return result;
    },
    mapCard: (row) => row,
  });
  const first = fetchCards('Pikachu');
  await Promise.all([
    assert.rejects(first, /network unavailable/),
    assert.rejects(fetchCards('Pikachu'), /network unavailable/),
  ]);
  await assert.rejects(fetchCards('Pikachu'), /Name catalog failed/);
  assert.deepEqual(await fetchCards('Pikachu'), []);
});

test('an empty name does not start an unfiltered catalog request', async () => {
  const fetchCards = createNamePrintingsFetcher({
    fetchRows: () => { throw new Error('unfiltered request'); },
    mapCard: (row) => row,
  });
  assert.deepEqual(await fetchCards('  '), []);
});
