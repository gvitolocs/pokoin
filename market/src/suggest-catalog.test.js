import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogIntent, expansionNationality } from './suggest-catalog.js';
import { printFlagFromNationality } from './locale.js';

test('10k-name catalog ranks a typo as the card, not a set', () => {
  const intent = catalogIntent('cyntha');
  assert.equal(intent.kind, 'name');
  assert.equal(intent.display, 'Cynthia');
});

test('komiya is the illustrator, not a card name', () => {
  const intent = catalogIntent('komiya');
  assert.equal(intent.kind, 'artist');
  assert.equal(intent.slug, 'tomokazu-komiya');
  assert.match(intent.display, /Komiya/i);
});

test('ultra prism is the expansion', () => {
  const intent = catalogIntent('ultra prism');
  assert.equal(intent.kind, 'set');
  assert.equal(intent.slug, 'ultra-prism');
});

test('expedition is Expedition Base Set, not Expedition Uniform', () => {
  const intent = catalogIntent('expedition');
  assert.equal(intent.kind, 'set');
  assert.equal(intent.slug, 'expedition-base-set');
  assert.match(intent.display, /Expedition Base Set/i);
});

test('cynthia stays a card when a set name is nearby', () => {
  const intent = catalogIntent('cynthia');
  assert.equal(intent.kind, 'name');
  assert.equal(intent.display, 'Cynthia');
});

test('flareon call of legendsd ranks Flareon, not the sealed set', () => {
  const intent = catalogIntent('flareon call of legendsd');
  assert.equal(intent.kind, 'name');
  assert.equal(intent.display, 'Flareon');
  const palkia = catalogIntent('palkai call of');
  assert.equal(palkia.kind, 'name');
  assert.equal(palkia.display, 'Palkia');
});

test('HeartGold Collection suggest flag is Japanese when leftover nationality is empty', () => {
  assert.equal(expansionNationality('HeartGold Collection'), 'japanese');
  assert.equal(printFlagFromNationality(expansionNationality('HeartGold Collection'))?.code, 'jpko');
  assert.equal(expansionNationality('HeartGold & SoulSilver'), 'western');
});
