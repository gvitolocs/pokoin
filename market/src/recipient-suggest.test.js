import assert from 'node:assert/strict';
import test from 'node:test';
import {
  counterpartiesFromActivity,
  mergeUsernameSuggestions,
} from './recipient-suggest.js';

test('counterpartiesFromActivity reads to/from handles', () => {
  assert.deepEqual(
    counterpartiesFromActivity([
      { title: 'Sent 5 PKN to nesaggezza' },
      { title: 'Received 5 PKN from ash' },
      { title: 'account_top_up 10 PKN' },
      { title: 'Sent 5 PKN to nesaggezza' },
    ]),
    ['nesaggezza', 'ash'],
  );
});

test('mergeUsernameSuggestions prefixes, dedupes, drops self', () => {
  assert.deepEqual(
    mergeUsernameSuggestions({
      query: 'ra',
      local: ['raffa', 'nesaggezza'],
      remote: ['raff', 'Raffa', 'random'],
      selfUsername: 'raff',
      limit: 6,
    }),
    ['raffa', 'random'],
  );
  assert.deepEqual(mergeUsernameSuggestions({ query: 'x', local: ['ash'], remote: [] }), []);
});
