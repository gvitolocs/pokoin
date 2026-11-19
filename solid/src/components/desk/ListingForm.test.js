import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const form = readFileSync(new URL('./ListingForm.jsx', import.meta.url), 'utf8');

test('the form never lists in a hidden PKN state after a reset', () => {
  assert.match(form, /const listIn = untrack\(currencyManual \? currency : sellerCurrency\);/);
  assert.match(form, /LIST_CURRENCIES\.filter\(\(code\) => code !== 'PKN'\)/);
});

test('the form sells in the languages of the game the card belongs to', () => {
  assert.match(form, /const gameId = currentGame\(\)\.id;/);
  assert.match(form, /return deskLanguageChips\(\{\n\s*game: gameId,/);
  assert.match(form, /listLangs\(\), \{\n\s*game: gameId,\n\s*nationality: card\(\)\.nationality,/);
});
