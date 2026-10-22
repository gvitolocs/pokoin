import assert from 'node:assert/strict';
import test from 'node:test';
import { FULL_ART_BLOCKS, isMonoFullArt } from './full-art.js';

const card = (name, set, number) => ({ name, set, number });

test('Sun & Moon Full Art GX is the trailing Ultra Rare block, not the regular GX', () => {
  assert.equal(isMonoFullArt(card('Sylveon GX', 'Guardians Rising', 'Ultra Rare | 140/145')), true);
  assert.equal(isMonoFullArt(card('Sylveon GX', 'Guardians Rising', 'Ultra Rare | 92/145')), false);
  assert.equal(isMonoFullArt(card('Hala', 'Guardians Rising', 'Ultra Rare | 143/145')), true);
  // Rainbow and gold keep their own rows; promos and theme decks are not Full Art.
  assert.equal(isMonoFullArt(card('Sylveon GX', 'Guardians Rising', 'Rainbow Secret Rare | 158/145')), false);
  assert.equal(isMonoFullArt(card('Max Potion', 'Guardians Rising', 'Gold Secret Rare | 164/145')), false);
  assert.equal(isMonoFullArt(card('Sylveon GX', 'Theme Deck & Blisters Exclusives', 'Holo Promo | 92a/145')), false);
  assert.equal(isMonoFullArt(card('Sylveon GX', 'SM-P: Sun & Moon Promos', '323/SM-P')), false);
});

test('CardTrader Full-Art label, minus the alt art that follows it in the block', () => {
  assert.equal(isMonoFullArt(card('Umbreon V', 'Evolving Skies', 'Full-Art | 188/203')), true);
  assert.equal(isMonoFullArt(card('Umbreon V', 'Evolving Skies', 'Ultra Rare | 189/203')), false);
  assert.equal(isMonoFullArt(card('Umbreon V', 'Evolving Skies', 'Ultra Rare | 094/203')), false);
  assert.equal(isMonoFullArt(card('Blastoise & Piplup GX', 'Cosmic Eclipse', 'Full-Art | 214/236')), true);
  assert.equal(isMonoFullArt(card('Blastoise & Piplup GX', 'Cosmic Eclipse', 'Full-Art | 215/236')), false);
  assert.equal(isMonoFullArt(card('Celebi V', 'Chilling Reign', 'Ultra Rare | 160/198')), true);
  // CardTrader `Full-Art` on a regular GX outside the block.
  assert.equal(isMonoFullArt(card('Charizard GX', 'Hidden Fates', 'Full-Art | 009/068')), false);
  assert.equal(isMonoFullArt(card('Venusaur & Snivy GX', 'Cosmic Eclipse', 'Full-Art | 001/236')), false);
  assert.equal(isMonoFullArt(card('Venusaur & Snivy GX', 'Cosmic Eclipse', 'Full-Art | 210/236')), true);
  assert.equal(isMonoFullArt(card('Jirachi GX', 'CSM2.5: Striking Competition', 'CSM2.5C | Full-Art | 069/099')), false);
  assert.equal(isMonoFullArt(card('Sylveon GX', 'CSM1c: Storming Emergence - Abundant', 'CSM1cC | Full-Art | 179/151')), true);
});

test('Scarlet & Violet Full Art ex is secret-numbered Ultra Rare', () => {
  assert.equal(isMonoFullArt(card('Wo-Chien ex', 'Paldea Evolved', 'Ultra Rare | 232/193')), true);
  assert.equal(isMonoFullArt(card('Iono', 'Paldea Evolved', 'Ultra Rare | 254/193')), true);
  assert.equal(isMonoFullArt(card('Forretress ex', 'Paldea Evolved', 'Ultra Rare | 005/193')), false);
  assert.equal(isMonoFullArt(card('Mew ex', 'Collect 151', 'Ultra Rare | 151/151')), false);
  assert.equal(isMonoFullArt(card('Iono', 'Paldea Evolved', 'Special Illustration Rare | 269/193')), false);
  assert.equal(isMonoFullArt(card('Magikarp', 'Paldea Evolved', 'Illustration Rare | 203/193')), false);
});

test('XY / BW Full Art EX, shiny full arts, and the cards that only look like one', () => {
  assert.equal(isMonoFullArt(card('Charizard EX', 'Flashfire', 'Ultra Rare | 100/106')), true);
  assert.equal(isMonoFullArt(card('M Charizard ex', 'Flashfire', 'Secret Rare | 107/106')), true);
  assert.equal(isMonoFullArt(card('M Charizard ex', 'Flashfire', 'Gold Secret Rare | 108/106')), false);
  assert.equal(isMonoFullArt(card('Celebi EX', 'Boundaries Crossed', 'Full-Art 141/149')), true);
  assert.equal(isMonoFullArt(card('Sylveon GX', 'Hidden Fates', 'Shiny Rare | SV76/SV94')), true);
  assert.equal(isMonoFullArt(card('Charmander', 'Shiny Treasure ex', 'Shiny Rare | 210/190')), false);
  // Celebrations Classic Collection reprints, Trainer Gallery, Japanese gold UR.
  assert.equal(isMonoFullArt(card('Umbreon Star', 'Celebrations', 'Ultra Rare | 17/17')), false);
  assert.equal(isMonoFullArt(card('Kricketune V', 'Silver Tempest', 'Ultra Rare | TG12/TG30')), false);
  assert.equal(isMonoFullArt(card('Zacian V', 'Sword', 'Ultra Rare | 73/060')), false);
  assert.equal(isMonoFullArt(card('Charizard EX', 'Wild Blaze', 'Ultra Rare | 081/080')), true);
  // Pre-Black & White has no Full Art.
  assert.equal(isMonoFullArt(card('Charizard', 'Base Set', 'Holo Rare | 4/102')), false);
  assert.equal(isMonoFullArt(card('Fire Energy', 'Cosmic Eclipse', 'Full-Art | 230/236')), false);
});

test('Full Art blocks start inside the set and list alt arts after the start', () => {
  for (const [key, [start, ...alts]] of Object.entries(FULL_ART_BLOCKS)) {
    assert.ok(Number.isInteger(start) && start > 0, key);
    for (const alt of alts) assert.ok(alt > start, `${key} ${alt}`);
  }
  assert.deepEqual(FULL_ART_BLOCKS.guardiansrising, [131]);
});
