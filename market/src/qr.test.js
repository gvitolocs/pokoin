import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { encodeQr, qrPath, qrLogoLayout } from './qr.js';

// Golden matrix decoded back to the same text with jsQR 1.4.0 on 2026-09-17
// (scratch check, not a dependency). Any change to the encoder must still
// decode; update the hash only after re-running that check.
const GOLDEN_TEXT = 'https://scan.pokoin.com/connect#k=golden-vector-0123456789abcdefABCDEF';
const GOLDEN_SHA = '712099a4b033bda2c2329816c4d6044a7f3552c2b630317b3ad9f97f0e5ee3f5';

function matrixHash(qr) {
  const bits = qr.modules.map((r) => r.map((v) => (v ? '1' : '0')).join('')).join('\n');
  return crypto.createHash('sha256').update(bits).digest('hex');
}

test('pairing URL encodes to the verified golden matrix (ECC M)', () => {
  const qr = encodeQr(GOLDEN_TEXT, { ecc: 'M' });
  assert.equal(qr.version, 5);
  assert.equal(qr.size, 37);
  assert.equal(qr.ecc, 'M');
  assert.equal(matrixHash(qr), GOLDEN_SHA);
});

test('Scan Connect default ECC H fits a ~70-byte pairing URL', () => {
  const url = 'https://scan.pokoin.com/connect#c=0427&k=AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  const qr = encodeQr(url); // default H
  assert.equal(qr.ecc, 'H');
  assert.ok(qr.version >= 7 && qr.version <= 10, `version ${qr.version}`);
  const layout = qrLogoLayout(qr);
  assert.equal(layout.view, qr.size + 8);
  assert.ok(layout.coverFraction < 0.12, `pad covers ${layout.coverFraction}`);
  assert.ok(layout.logo < layout.pad);
});

test('finder patterns, timing and dark module are in place', () => {
  const qr = encodeQr('https://scan.pokoin.com/connect#k=abc', { ecc: 'M' });
  const m = qr.modules;
  const n = qr.size;
  for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    for (let i = 0; i < 7; i += 1) {
      assert.equal(m[oy][ox + i], true);
      assert.equal(m[oy + 6][ox + i], true);
    }
    assert.equal(m[oy + 3][ox + 3], true);
    assert.equal(m[oy + 1][ox + 1], false);
  }
  for (let i = 8; i < n - 8; i += 1) {
    assert.equal(m[6][i], i % 2 === 0);
    assert.equal(m[i][6], i % 2 === 0);
  }
  assert.equal(m[n - 8][8], true);
});

test('version grows with payload and rejects what does not fit version 10', () => {
  assert.equal(encodeQr('x'.repeat(10), { ecc: 'M' }).version, 1);
  assert.ok(encodeQr('x'.repeat(100), { ecc: 'M' }).version >= 5);
  assert.throws(() => encodeQr('x'.repeat(400), { ecc: 'H' }), /too long/);
  assert.match(qrPath(encodeQr('a', { ecc: 'M' })), /^M4 4h1v1h-1z/);
});
