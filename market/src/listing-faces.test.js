import assert from 'node:assert/strict';
import test from 'node:test';
import {
  foilStateFromProperties,
  listingExtraChips,
  listingFoilOptions,
} from './listing-faces.js';

test('Riftbound listing faces are Non-foil / Foil', () => {
  assert.deepEqual(
    listingFoilOptions('riftbound').map((row) => row.label),
    ['Non-foil', 'Foil'],
  );
  assert.equal(listingExtraChips('riftbound').some((row) => row.key === 'firstEd'), false);
});

test('Pokémon keeps Standard / Holo / Reverse and 1st Ed.', () => {
  assert.equal(listingFoilOptions('pokemon')[0].label, 'Standard');
  assert.ok(listingFoilOptions('pokemon').some((row) => row.value === 'reverse'));
  assert.ok(listingExtraChips('pokemon').some((row) => row.key === 'firstEd'));
});

test('CT riftbound_foil maps onto foil_state', () => {
  assert.equal(foilStateFromProperties({ riftbound_foil: false }), 'standard');
  assert.equal(foilStateFromProperties({ riftbound_foil: true }), 'foil');
  assert.equal(foilStateFromProperties({ pokemon_reverse: 'true' }), 'reverse');
  assert.equal(foilStateFromProperties({ mtg_foil: true }), 'foil');
});
