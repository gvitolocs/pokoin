import assert from 'node:assert/strict';
import test from 'node:test';
import {
  artworkVersionLabel,
  artworkVersionShortLabel,
  languagesForPrint,
  listingLanguageForPrint,
  preferArtworkPrinting,
  preferredPrintBucket,
  shouldRemapArtwork,
  sortArtworkVersions,
} from './scan-artwork-versions.js';

const JP = {
  id: '1',
  name: 'Slowbro',
  set_name: 'Abyss Eye',
  card_number: '029/081',
  nationality: 'japanese',
};
const EN = {
  id: '2',
  name: 'Slowbro',
  set_name: 'Pitch Black',
  card_number: '030/084',
  nationality: 'western',
};
const CN = {
  id: '3',
  name: 'Slowbro',
  set_name: 'CN Set',
  card_number: '029/081',
  nationality: 'chinese',
};
const KO = {
  id: '4',
  name: 'Slowbro',
  set_name: 'KO Set',
  card_number: '029/081',
  nationality: 'korean',
};

test('preferredPrintBucket follows listing language', () => {
  assert.equal(preferredPrintBucket('EN'), 'western');
  assert.equal(preferredPrintBucket('IT'), 'western');
  assert.equal(preferredPrintBucket('JP'), 'jpko');
  assert.equal(preferredPrintBucket('KO'), 'jpko');
  assert.equal(preferredPrintBucket('ZH'), 'chinese');
  assert.equal(preferredPrintBucket('ZHT'), 'chinese');
});

test('EN defaults remap JP identify to western sibling', () => {
  assert.equal(preferArtworkPrinting([JP, EN, CN], '1', 'EN').id, '2');
  assert.equal(shouldRemapArtwork([JP, EN], '1', 'EN'), true);
});

test('JP defaults remap western identify to JP/KO sibling', () => {
  assert.equal(preferArtworkPrinting([JP, EN, CN], '2', 'JP').id, '1');
  assert.equal(preferArtworkPrinting([KO, EN], '2', 'JP').id, '4');
  assert.equal(shouldRemapArtwork([JP, EN], '2', 'JP'), true);
});

test('ZH defaults remap to chinese sibling', () => {
  assert.equal(preferArtworkPrinting([JP, EN, CN], '1', 'ZH').id, '3');
  assert.equal(shouldRemapArtwork([JP, EN, CN], '2', 'ZHT'), true);
});

test('keeps current when already in the preferred region', () => {
  assert.equal(preferArtworkPrinting([JP, EN], '2', 'EN').id, '2');
  assert.equal(preferArtworkPrinting([JP, EN], '1', 'JP').id, '1');
  assert.equal(shouldRemapArtwork([JP, EN], '2', 'EN'), false);
});

test('keeps identify hit when preferred region has no sibling', () => {
  assert.equal(preferArtworkPrinting([JP, CN], '1', 'EN').id, '1');
  assert.equal(preferArtworkPrinting([EN, CN], '2', 'JP').id, '2');
  assert.equal(shouldRemapArtwork([JP, CN], '1', 'EN'), false);
});

test('sortArtworkVersions puts preferred region first', () => {
  assert.deepEqual(sortArtworkVersions([CN, JP, EN], 'EN').map((r) => r.id), ['2', '1', '3']);
  assert.deepEqual(sortArtworkVersions([CN, JP, EN], 'JP').map((r) => r.id), ['1', '2', '3']);
  assert.deepEqual(sortArtworkVersions([CN, JP, EN], 'ZH').map((r) => r.id), ['3', '2', '1']);
});

test('artworkVersionLabel matches set · number with print badge', () => {
  assert.equal(artworkVersionLabel(JP), 'JP · Abyss Eye · 029/081');
  assert.equal(artworkVersionLabel(EN), 'EN · Pitch Black · 030/084');
});

test('artworkVersionShortLabel drops the print badge', () => {
  assert.equal(artworkVersionShortLabel(JP), 'Abyss Eye · 029/081');
  assert.equal(artworkVersionShortLabel(EN), 'Pitch Black · 030/084');
});

test('listingLanguageForPrint blocks EN on JP and JP on western', () => {
  assert.equal(listingLanguageForPrint('japanese', 'EN'), 'JP');
  assert.equal(listingLanguageForPrint('japanese', 'IT'), 'JP');
  assert.equal(listingLanguageForPrint('korean', 'EN'), 'KO');
  assert.equal(listingLanguageForPrint('chinese', 'EN'), 'ZH');
  assert.equal(listingLanguageForPrint('chinese', 'ZHT'), 'ZHT');
  assert.equal(listingLanguageForPrint('western', 'JP'), 'EN');
  assert.equal(listingLanguageForPrint('western', 'KO'), 'EN');
  assert.equal(listingLanguageForPrint('western', 'IT'), 'IT');
  assert.equal(listingLanguageForPrint('western', 'EN'), 'EN');
});

test('languagesForPrint: western has no asian; JP has only JP', () => {
  const all = ['EN', 'IT', 'FR', 'JP', 'KO', 'ZH', 'ZHT', 'ID'];
  assert.deepEqual(languagesForPrint('western', all), ['EN', 'IT', 'FR']);
  assert.deepEqual(languagesForPrint('japanese', all), ['JP']);
  assert.deepEqual(languagesForPrint('korean', all), ['KO']);
  assert.deepEqual(languagesForPrint('chinese', all), ['ZH', 'ZHT']);
});
