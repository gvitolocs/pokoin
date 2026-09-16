import assert from 'node:assert/strict';
import test from 'node:test';
import { fillFan, isSecretRare, pickFan, pickSecretRares } from './promo-fan.js';

function card(id, number, extra = {}) {
  return {
    id,
    name: `Card ${id}`,
    number,
    imageUrl: `/card-images/${id}_scan.jpg`,
    ...extra,
  };
}

test('illustration rares over the set size count as chase cards', () => {
  assert.equal(isSecretRare(card('1', 'Illustration Rare | 147/132')), true);
  assert.equal(isSecretRare(card('2', 'Special Illustration Rare | 186/132')), true);
  assert.equal(isSecretRare(card('3', 'Gold Secret Rare | 188/132')), true);
  assert.equal(isSecretRare(card('4', '121/132')), false);
});

test('fan pool keeps backups so a dead scan can be replaced', () => {
  const pool = [
    card('10', 'Special Illustration Rare | 186/132'),
    card('11', 'Illustration Rare | 147/132'),
    card('12', 'Illustration Rare | 148/132'),
    card('13', 'Gold Secret Rare | 188/132'),
    card('14', 'Ultra Rare | 176/132'),
  ];
  const picked = pickSecretRares(pool, 5);
  assert.equal(picked.length, 5);
  const failed = new Set(['12']);
  const [left, center, right] = fillFan(picked, failed);
  assert.ok(left && center && right);
  assert.notEqual(String(left.id), '12');
  assert.notEqual(String(center.id), '12');
  assert.notEqual(String(right.id), '12');
});

test('fillFan leaves the right slot empty only when fewer than three scans remain', () => {
  const [left, center, right] = fillFan([
    card('10', '186/132'),
    card('11', '147/132'),
  ]);
  assert.equal(center.id, '10');
  assert.equal(left.id, '11');
  assert.equal(right, null);
});

test('pickFan draws shuffled secret rares, not a pinned id list', () => {
  const pool = [
    card('806056', 'Special Illustration Rare | 110/076'),
    card('806382', 'Special Illustration Rare | 108/076'),
    card('806390', 'Gold Secret Rare | 113/076'),
    card('806068', '006/076'),
    card('806100', 'Illustration Rare | 090/076'),
  ];
  const picked = pickFan(pool, 3);
  assert.equal(picked.length, 3);
  assert.ok(picked.every((row) => isSecretRare(row)));
  assert.ok(picked.every((row) => String(row.id) !== '806068'));
});

test('fan pool accepts leftover JPEG even when a homepage webp is advertised', () => {
  const pool = [
    card('703382', 'Gold Secret Rare | 188/132', {
      heroImageUrl: '/card-images/351691_mega-lucario-ex.jpg',
      homepageImageUrl: '/card-images/351691_mega-lucario-ex_homepage.webp',
    }),
  ];
  assert.equal(pickFan(pool, 1).length, 1);
});
