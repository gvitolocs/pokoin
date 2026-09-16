import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countExpansionLangGroups,
  englishOcrIsJunk,
  expansionLangGroup,
  filterExpansions,
  qwenAgrees,
  shouldApplyQwenNationality,
} from './ocr-expansions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../public/review');
const ocr = JSON.parse(readFileSync(join(root, 'ocr.json'), 'utf8'));
const expansions = JSON.parse(readFileSync(join(root, 'ocr-expansions.json'), 'utf8'));
const tests = JSON.parse(readFileSync(join(root, 'tests.json'), 'utf8'));
const artists = JSON.parse(readFileSync(join(root, 'western-artists.json'), 'utf8'));

test('OCR board is ten random singles with a source scan', () => {
  assert.equal(ocr.path, '/ocr');
  assert.equal(ocr.cards.length, 10);
  for (const card of ocr.cards) {
    assert.match(card.image, /^\/review\/ocr-10\/\d+\.(jpg|png)$/);
    assert.ok(card.name_zone.length + card.attack_zone.length > 0);
    assert.ok(card.desk.includes(String(card.card_id)));
  }
  assert.ok(tests.tests.some((entry) => entry.path === '/ocr'));
});

test('English OCR junk gate sends JP/CN mashed text to Qwen, not clean EN', () => {
  const muk = ocr.cards.find((card) => card.name === 'Alolan Muk');
  const misty = ocr.cards.find((card) => card.name === 'Misty');
  const umbreon = ocr.cards.find((card) => card.name === 'Umbreon V');
  assert.equal(englishOcrIsJunk(muk.full_text), false);
  assert.equal(englishOcrIsJunk(misty.full_text), true);
  assert.equal(englishOcrIsJunk(umbreon.full_text), true);
  assert.equal(shouldApplyQwenNationality('western', 'japanese', false), false);
  assert.equal(shouldApplyQwenNationality('western', 'japanese', true), true);
});

test('Qwen leftover print only applies CJK labels onto JP/CN/western rows', () => {
  assert.equal(qwenAgrees('western', 'english'), true);
  assert.equal(qwenAgrees('american', 'english'), true);
  assert.equal(qwenAgrees('japanese', 'chinese'), false);
  assert.equal(qwenAgrees('western', 'japanese'), false);
  assert.equal(shouldApplyQwenNationality('western', 'japanese'), true);
  assert.equal(shouldApplyQwenNationality('japanese', 'chinese'), true);
  assert.equal(shouldApplyQwenNationality('japanese', 'english'), false);
  assert.equal(shouldApplyQwenNationality('indonesian', 'japanese'), false);
  assert.equal(shouldApplyQwenNationality('western', 'english', true), false);
});

test('OCR expansions board lists leftover rows of at most five cards', () => {
  assert.equal(expansions.path, '/ocr');
  assert.equal(expansions.count, expansions.expansions.length);
  assert.ok(expansions.expansions.length > 500);
  const counts = countExpansionLangGroups(expansions.expansions);
  assert.equal(counts.all, expansions.expansions.length);
  assert.ok(counts.western > 200);
  assert.ok(counts.japanese > 200);
  assert.ok(counts.chinese > 20);
  assert.equal(expansionLangGroup('american'), 'western');
  assert.equal(expansionLangGroup('korean'), 'korean');
  assert.deepEqual(
    filterExpansions(expansions.expansions, { group: 'korean' }).map((row) => row.name),
    ['Scarlet & Violet Korean Promos'],
  );
  assert.equal(
    filterExpansions(expansions.expansions, { group: 'chinese' }).length,
    counts.chinese,
  );
  for (const row of expansions.expansions) {
    assert.ok(row.name);
    assert.ok(row.nationality);
    assert.ok(row.cards.length >= 1 && row.cards.length <= 5);
    assert.ok(row.total >= row.cards.length);
    for (const card of row.cards) {
      assert.match(card.image, /^\/card-images\/\d+_[^/?]+\.jpg(?:\?[^/]*)?$/);
      assert.ok(card.id > 0);
      assert.ok(card.ct_id > 0);
    }
  }
});

test('artist table dock is OCR Illus. matched to pokemontcg.io', () => {
  assert.ok(tests.tests.some((entry) => entry.path === '/ocr/artists'));
  assert.match(
    tests.tests.find((entry) => entry.path === '/ocr/artists').note,
    /pokemontcg\.io/i,
  );
  assert.equal(artists.path, '/ocr/artists');
  assert.equal(artists.artists.length, artists.totals.unique);
  assert.equal(Math.min(...artists.artists.map((row) => row.count)), 1);
  assert.ok(artists.artists.find((row) => row.name === 'Ken Sugimori').count > 1100);
  assert.ok(artists.artists.find((row) => row.name === '5ban Graphics').matched);
  assert.equal(artists.artists.some((row) => /sugimorl|grophics/i.test(row.name)), false);
  assert.equal(
    artists.artists.some((row) => /^(nests|reverberates|regardless|predicting)$/i.test(row.name)),
    false,
  );
});
