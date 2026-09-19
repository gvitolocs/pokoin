import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activityFromChainTx,
  activityFromLedgerRow,
  activityFromWalletRow,
  activityTimeLabel,
  mergeActivity,
  readActivityInt,
  shortChainAddress,
} from './wallet-activity.js';

function at(iso) {
  return new Date(iso);
}

test('ledger rows map to activity items with signed amounts', () => {
  const item = activityFromLedgerRow({
    id: 'l1',
    type: 'account_transfer_sent',
    amountPkn: -25,
    counterpartyUsername: 'ash',
    createdAt: { seconds: 1758249300 },
  });
  assert.equal(item.title, 'Sent 25 PKN to ash');
  assert.equal(item.kind, 'outbound');
  assert.equal(item.amountPkn, -25);
  assert.deepEqual(item.at, at('2025-09-19T02:35:00.000Z'));
});

test('ledger titles cover purchases, payouts, and silver unlocks', () => {
  assert.equal(activityFromLedgerRow({ id: 'a', type: 'pkn_purchase_credit', amountPkn: 500 }).title, 'Bought 500 PKN');
  assert.equal(
    activityFromLedgerRow({ id: 'b', type: 'account_transfer_payout_sent', amountPkn: 12 }).title,
    'Received 12 PKN to wallet',
  );
  assert.equal(
    activityFromLedgerRow({ id: 'c', type: 'pkn_withdraw_requested', amountPkn: 7 }).title,
    'Requested 7 PKN payout',
  );
  assert.equal(
    activityFromLedgerRow({ id: 'd', type: 'silver_unlock_payment_sent', amountPkn: 100 }).kind,
    'outbound',
  );
});

test('legacy wallet activity rows are skipped, titles cleaned', () => {
  const legacy = activityFromWalletRow({ id: 'w1', title: 'Topped up 25 PKN', kind: 'inbound' });
  assert.equal(legacy.skip, true);
  const legacyTransfer = activityFromWalletRow({ id: 'w4', title: 'Sent 5 PKN from account balance', kind: 'outbound' });
  assert.equal(legacyTransfer.skip, true);
  const clean = activityFromWalletRow({ id: 'w2', title: 'Received 5 PKN from ash', detail: 'site transfer', kind: 'inbound' });
  assert.equal(clean.skip, false);
  assert.equal(clean.title, 'Received 5 PKN from ash');
  assert.equal(clean.detail, 'site transfer');
  assert.equal(clean.kind, 'inbound');
  const swap = activityFromWalletRow({ id: 'w3', title: 'Pokoinswap submitted', kind: 'outbound' });
  assert.equal(swap.skip, true);
});

test('chain txs map direction and amm swaps', () => {
  const self = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const sent = activityFromChainTx({
    hash: '0xhash1',
    from: self,
    to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    amount: 4,
    blockNumber: 900,
    timestamp: '2026-09-18T10:20:00.000Z',
  }, self);
  assert.equal(sent.kind, 'outbound');
  assert.equal(sent.title, 'Sent 4 PKN on-chain');
  assert.equal(sent.amountPkn, -4);

  const swap = activityFromChainTx({
    hash: '0xhash2',
    from: self,
    to: '0xcccccccccccccccccccccccccccccccccccccccc',
    blockNumber: 901,
    amm: { action: 'amm_swap', assetIn: 'PKN', assetOut: 'WPKN', amountIn: 10, amountOut: 10 },
  }, self);
  assert.equal(swap.title, 'Swapped 10 PKN for 10 WPKN');
  assert.equal(swap.amountPkn, null);
  assert.equal(swap.blockLabel, 'Block 901');
});

test('mergeActivity dedupes by key, drops skipped, sorts newest first', () => {
  const merged = mergeActivity([
    [
      { key: 'a', at: at('2026-09-01'), kind: 'inbound', title: 'old' },
      { key: 'b', at: at('2026-09-03'), kind: 'outbound', title: 'new' },
    ],
    [
      { key: 'a', at: at('2026-09-05'), kind: 'inbound', title: 'dupe newer' },
      { key: 'c', at: at('2026-09-02'), kind: 'inbound', title: 'skipped', skip: true },
    ],
  ], { limit: 2 });
  assert.deepEqual(merged.map((row) => row.key), ['b', 'a']);
});

test('activityTimeLabel shows clock time today and short date otherwise', () => {
  const now = at('2026-09-19T15:00:00');
  assert.equal(activityTimeLabel(at('2026-09-19T08:05:00'), { now }), '08:05');
  assert.equal(activityTimeLabel(at('2026-09-01T08:05:00'), { now }), '1 Sep');
  assert.equal(activityTimeLabel(at('2025-09-01T08:05:00'), { now }), '1 Sep 2025');
  assert.equal(activityTimeLabel(new Date(0), { now }), '');
});

test('readActivityInt and shortChainAddress tolerate junk', () => {
  assert.equal(readActivityInt('12'), 12);
  assert.equal(readActivityInt(undefined), 0);
  assert.equal(readActivityInt(7.9), 8);
  assert.equal(shortChainAddress('0x1234567890abcdef1234567890abcdef12345678'), '0x1234…5678');
  assert.equal(shortChainAddress('short'), 'short');
});
