import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextBoxLocation } from './card-desk.js';

// GET /api/marketplace-listings?action=box-slots answer for Giuseppe's box on
// 2026-10-18: Pokémon stock up to ·19·…/·20·…, then Battle Spirits Saga cards
// (paused) at ·22·72 … ·22·76. The server counts them, so the desk shows ·22·77.
const boxes = [
  { box: 'megaevoluzionietb', rows: 1735, next: { stack: 22, startPosition: 77, stackSize: 80, slot: '·22·77' } },
  { box: 'box1', rows: 1, next: { stack: 4, startPosition: 1, stackSize: 80, slot: '·4·1' } },
  { box: 'empty', rows: 1, next: null },
];

test('the desk location is the box plus the server next slot', () => {
  assert.equal(nextBoxLocation(boxes, 'megaevoluzionietb'), 'megaevoluzionietb·22·77');
  // The picked casing stays; the box matches across casing.
  assert.equal(nextBoxLocation(boxes, 'Box1'), 'Box1·4·1');
});

test('a box with no slot yet, an unknown box or no box', () => {
  assert.equal(nextBoxLocation(boxes, 'empty'), 'empty');
  assert.equal(nextBoxLocation(boxes, 'new box'), 'new box');
  assert.equal(nextBoxLocation(null, 'new box'), 'new box');
  assert.equal(nextBoxLocation(boxes, '  '), '');
});

// The free-position search is the server's (pokoin-rust commerce
// domain/box_slots.rs `free_position`): rolling off a full stack 40 answers
// 41·41 when 41 already holds ·39 and ·40. The listing form writes it.
test('the form writes the searched slot and never invents a position', () => {
  const rolled = [{
    box: 'megaevoluzionietb',
    rows: 3220,
    next: { stack: 41, startPosition: 41, stackSize: 80, slot: '·41·41' },
  }];
  assert.equal(nextBoxLocation(rolled, 'megaevoluzionietb'), 'megaevoluzionietb·41·41');
  assert.equal(nextBoxLocation(rolled, 'MegaEvoluzioniETB'), 'MegaEvoluzioniETB·41·41');
  const src = readFileSync(new URL('./card-desk.js', import.meta.url), 'utf8');
  assert.match(src, /const slot = String\(hit\?\.next\?\.slot \|\| ''\)/);
  assert.doesNotMatch(src, /startPosition|stackSize|nextPosition|slotEnd/);
});
