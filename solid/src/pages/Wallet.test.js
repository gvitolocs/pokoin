import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync(new URL('./Wallet.jsx', import.meta.url), 'utf8');
const ids = fs.readFileSync(
  new URL('../../../market/src/wallet-request-id.js', import.meta.url),
  'utf8',
);

test('the wallet page takes its request ids from the tested intent holder', () => {
  // One holder for the page: the id of an intent is minted by the module that
  // rules say keeps it, never inline in a press handler.
  assert.match(
    src,
    /import \{ createRequestIds, walletIntent \} from '@market\/wallet-request-id\.js';/,
  );
  assert.match(src, /const requestIds = createRequestIds\(\);/);
  assert.doesNotMatch(src, /randomUUID/, 'the page must not mint an id per attempt');
  assert.match(ids, /export function createRequestIds/);
  assert.match(ids, /export function walletIntent/);
});

test('a sheet asks its request id from the intent it is sending', () => {
  assert.match(src, /requestIds\.idFor\(walletIntent\('transfer', recipient, amount\)\)/);
  assert.match(src, /requestIds\.idFor\(walletIntent\('withdraw', to, amount\)\)/);
  // …and the id travels with the request it names.
  assert.match(src, /amountPkn: Math\.round\(Number\(amount\)\),\n {16}requestId,\n {14}\}, token\);/);
});

test('a browser that cannot name a request shows that it cannot send PKN safely', () => {
  // The id module throws this sentence, and the page paints the error it caught.
  assert.equal(
    ids.match(/export const UNSAFE_BROWSER_MESSAGE = '([^']+)';/)?.[1],
    'This browser cannot send PKN safely; update it.',
  );
  assert.match(ids, /throw new Error\(UNSAFE_BROWSER_MESSAGE\)/);
  assert.match(src, /setError\(err\.message \|\| 'Something went wrong\.'\)/);
  assert.match(src, /class="wallet-error">\{error\(\)\}/);
});

test('a request id is spent only once its request answered', () => {
  const sheets = [
    {
      opener: 'onTransfer={',
      intent: "walletIntent('transfer'",
      sender: 'await transferAccountBalance(',
    },
    {
      opener: 'onWithdraw={',
      intent: "walletIntent('withdraw'",
      sender: 'await requestPknWithdraw(',
    },
  ];
  for (const sheet of sheets) {
    const opened = src.indexOf(sheet.opener);
    assert.ok(opened >= 0, `${sheet.opener} is not in the page`);
    const after = src.slice(opened + sheet.opener.length);
    // One handler's own body: the slice ends at the next prop of the same
    // element, or at the element's end. A sheet is judged on its own code, so
    // another sheet's settle cannot cover a missing one here.
    const nextProp = after.indexOf('\n            on');
    const elementEnd = after.indexOf('/>');
    const ends = [nextProp, elementEnd].filter((edge) => edge > 0);
    const handler = after.slice(0, ends.length ? Math.min(...ends) : after.length);
    const sent = handler.indexOf(sheet.sender);
    const settled = handler.indexOf('requestIds.settle()');
    assert.ok(handler.includes(sheet.intent), `${sheet.opener}: it names no intent`);
    assert.ok(sent >= 0, `${sheet.opener}: ${sheet.sender} is not awaited`);
    assert.ok(settled > sent, `${sheet.opener}: its id is spent before the request answered`);
    // One id per request: the handler spends exactly the one it took.
    assert.equal(
      handler.split('requestIds.settle()').length - 1,
      1,
      `${sheet.opener}: it spends more than its own id`,
    );
  }
});
