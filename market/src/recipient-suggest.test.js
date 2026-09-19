import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compactRecipientQuery,
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
    [
      { username: 'nesaggezza', displayName: '' },
      { username: 'ash', displayName: '' },
    ],
  );
});

test('compactRecipientQuery strips spaces for display-name typing', () => {
  assert.equal(compactRecipientQuery('Raffaella Sabatino'), 'raffaellasabatino');
  assert.equal(compactRecipientQuery('raf'), 'raf');
});

test('mergeUsernameSuggestions matches display names and drops self', () => {
  assert.deepEqual(
    mergeUsernameSuggestions({
      query: 'raf',
      local: [],
      remote: [
        { username: 'raffaellasabatino', displayName: 'Raffaella Sabatino' },
        { username: 'redshakkio', displayName: 'Simone Di Blasi' },
      ],
      selfUsername: 'pknreserve',
      limit: 6,
    }),
    [{ username: 'raffaellasabatino', displayName: 'Raffaella Sabatino' }],
  );
  assert.deepEqual(
    mergeUsernameSuggestions({
      query: 'raffaella sab',
      local: [],
      remote: [{ username: 'raffaellasabatino', displayName: 'Raffaella Sabatino' }],
    }),
    [{ username: 'raffaellasabatino', displayName: 'Raffaella Sabatino' }],
  );
  assert.deepEqual(
    mergeUsernameSuggestions({
      query: 'sim',
      remote: [{ username: 'redshakkio', displayName: 'Simone Di Blasi' }],
    }),
    [{ username: 'redshakkio', displayName: 'Simone Di Blasi' }],
  );
});
