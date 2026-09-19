import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReceiveQr, parseScannedQr, parseWalletSendLink } from './wallet-qr.js';

const ADDR = '0x1234567890abcdef1234567890abcdef12345678';

test('site receive codes are HTTPS wallet deep links with optional amount', () => {
  assert.equal(buildReceiveQr({ kind: 'site', username: 'ash' }), 'https://pokoin.com/wallet?to=ash');
  assert.equal(buildReceiveQr({ kind: 'site', username: 'ash', amount: '25' }), 'https://pokoin.com/wallet?to=ash&a=25');
  assert.equal(buildReceiveQr({ kind: 'site', username: 'ash', amount: '0' }), null);
  assert.equal(buildReceiveQr({ kind: 'site', username: 'ash', amount: '1.5' }), null);
  assert.equal(buildReceiveQr({ kind: 'site', username: 'nope!' }), null);
  assert.equal(buildReceiveQr({ kind: 'site' }), null);
});

test('chain receive codes are EIP-681 with the PokoinPoS chain and wei value', () => {
  assert.equal(
    buildReceiveQr({ kind: 'chain', address: ADDR }),
    `ethereum:${ADDR}@26062026`,
  );
  assert.equal(
    buildReceiveQr({ kind: 'chain', address: ADDR, amount: '25' }),
    `ethereum:${ADDR}@26062026?value=${BigInt(25) * BigInt(1e18)}`,
  );
  assert.equal(buildReceiveQr({ kind: 'chain', address: '0x123' }), null);
  assert.equal(buildReceiveQr({ kind: 'chain', address: ADDR, amount: 'abc' }), null);
});

test('parse HTTPS wallet links and legacy pokoin:u codes into recipient + amount', () => {
  assert.deepEqual(parseScannedQr('https://pokoin.com/wallet?to=ash'), {
    kind: 'site', recipient: 'ash', amountPkn: '',
  });
  assert.deepEqual(parseScannedQr('https://pokoin.com/wallet?to=ash&a=25'), {
    kind: 'site', recipient: 'ash', amountPkn: '25',
  });
  assert.deepEqual(parseScannedQr('/wallet?to=ash&a=007'), {
    kind: 'site', recipient: 'ash', amountPkn: '7',
  });
  assert.deepEqual(parseScannedQr('pokoin:u/ash'), {
    kind: 'site', recipient: 'ash', amountPkn: '',
  });
  assert.deepEqual(parseScannedQr('pokoin:u/ash?a=25'), {
    kind: 'site', recipient: 'ash', amountPkn: '25',
  });
});

test('parseWalletSendLink rejects non-wallet URLs', () => {
  assert.equal(parseWalletSendLink('https://pokoin.com/marketplace?to=ash'), null);
  assert.equal(parseWalletSendLink('https://pokoin.com/wallet'), null);
  assert.equal(parseWalletSendLink('https://example.com/pay?to=ash'), null);
});

test('parse EIP-681 and bare addresses into chain recipients', () => {
  assert.deepEqual(
    parseScannedQr(`ethereum:${ADDR}@26062026?value=${BigInt(3) * BigInt(1e18)}`),
    { kind: 'chain', recipient: ADDR, chainId: '26062026', amountPkn: '3' },
  );
  const withFrac = parseScannedQr(`ethereum:${ADDR}?value=${BigInt(1500000000000000000n)}`);
  assert.equal(withFrac.recipient, ADDR);
  assert.equal(withFrac.amountPkn, '1.5');
  assert.deepEqual(parseScannedQr(ADDR), { kind: 'chain', recipient: ADDR, chainId: '', amountPkn: '' });
});

test('bare usernames scan as site recipients; junk returns null', () => {
  assert.deepEqual(parseScannedQr('misty'), { kind: 'site', recipient: 'misty', amountPkn: '' });
  assert.equal(parseScannedQr('https://example.com/pay?to=ash'), null);
  assert.equal(parseScannedQr(''), null);
  assert.equal(parseScannedQr(undefined), null);
});
