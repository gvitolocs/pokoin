import assert from 'node:assert/strict';
import test from 'node:test';
import { scanDuplicateNote, scanRowDuplicates } from './duplicates.js';

const book = [
  { id: 'a', cardId: '220962', condition: 'NM', language: 'EN', status: 'active', quantityAvailable: 1, origin: 'cardrails' },
  { id: 'b', cardId: '220962', condition: 'NM', language: 'EN', status: 'active', quantityAvailable: 2, source: 'cardtrader_seller_import' },
  { id: 'c', cardId: '220962', condition: 'NM', language: 'EN', status: 'active', quantityAvailable: 1, source: 'pokoin_scan_batch' },
  { id: 'd', cardId: '220962', condition: 'LP', language: 'EN', status: 'active', quantityAvailable: 1, origin: 'cardrails' },
];

test('the warning names existing locations even when the scan has another exact slot', () => {
  const existing = { ...book[0], location: ' megaevoluzionietb·6·31 ' };
  const scan = { cardId: '220962', condition: 'NM', language: 'EN', location: 'megaevoluzionietb·1·11' };
  assert.equal(scanDuplicateNote([existing], scan), 'Already listed from Card Rails (qty 1) · megaevoluzionietb·6·31');
});

test('the warning shows at most two locations then counts the rest', () => {
  const scan = { cardId: '220962', condition: 'NM', language: 'EN' };
  const copies = ['a·1·1', 'a·2·2', 'a·3·3'].map((location, i) => ({ ...book[0], id: String(i), location }));
  assert.equal(scanDuplicateNote(copies, scan), 'Already listed from Card Rails (qty 3) · a·1·1, a·2·2 +1 more');
  assert.equal(scanDuplicateNote(copies.slice(0, 2), scan), 'Already listed from Card Rails (qty 2) · a·1·1, a·2·2');
});

test('missing locations add nothing and repeated locations are named once', () => {
  const scan = { cardId: '220962', condition: 'NM', language: 'EN' };
  assert.equal(scanDuplicateNote([{ ...book[0], location: ' ' }, { ...book[0], id: 'e', location: '' }], scan), 'Already listed from Card Rails (qty 2)');
  const copies = [book[0], { ...book[0], id: 'e', location: 'binder' }, { ...book[0], id: 'f', location: 'binder' }];
  assert.equal(scanDuplicateNote(copies, scan), 'Already listed from Card Rails (qty 3) · binder');
});

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
