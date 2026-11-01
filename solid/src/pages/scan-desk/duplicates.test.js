import assert from 'node:assert/strict';
import test from 'node:test';
import { scanDuplicateNote, scanRowDuplicates } from './duplicates.js';

const book = [
  { id: 'a', cardId: '220962', condition: 'NM', language: 'EN', status: 'active', quantityAvailable: 1, origin: 'cardrails' },
  { id: 'b', cardId: '220962', condition: 'NM', language: 'EN', status: 'active', quantityAvailable: 2, source: 'cardtrader_seller_import' },
  { id: 'c', cardId: '220962', condition: 'NM', language: 'EN', status: 'active', quantityAvailable: 1, source: 'pokoin_scan_batch' },
  { id: 'd', cardId: '220962', condition: 'LP', language: 'EN', status: 'active', quantityAvailable: 1, origin: 'cardrails' },
];

test('a scan row warns about the same copy listed from another channel', () => {
  const row = { id: 'r1', cardId: '220962', condition: 'NM', language: 'EN', foilState: 'standard', firstEdition: false };
  assert.deepEqual(scanRowDuplicates(book, row).map((r) => r.id), ['a', 'b']);
  assert.equal(scanDuplicateNote(book, row), 'Already listed from Card Rails (qty 1), CardTrader (qty 2)');
});

test('no warning without a card, a book, a match, or after submit', () => {
  const row = { id: 'r1', cardId: '220962', condition: 'NM', language: 'EN' };
  assert.equal(scanDuplicateNote(book, { ...row, cardId: '' }), '');
  assert.equal(scanDuplicateNote(null, row), '');
  assert.equal(scanDuplicateNote([], row), '');
  assert.equal(scanDuplicateNote(book, { ...row, language: 'JP' }), '');
  assert.equal(scanDuplicateNote(book, { ...row, foilState: 'reverse' }), '');
  assert.equal(scanDuplicateNote(book, { ...row, status: 'submitted' }), '');
  assert.equal(scanDuplicateNote(book, { ...row, condition: 'LP' }), 'Already listed from Card Rails (qty 1)');
});
