import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// PH-C030 (CARD-08): "All Giratina" lists every single of the species. The hub
// asks by National Dex number, so the answer is not limited to the printings
// named exactly "Giratina"; the exact-name read survives only as the fallback
// inside fetchSpeciesCards, which market/src/species-cards.test.js drives.
const src = fs.readFileSync(new URL('./PokemonHub.jsx', import.meta.url), 'utf8');

test('SpeciesCards asks for the species by dex number', () => {
  assert.match(src, /import \{ fetchSpeciesCards \} from '@market\/api\.js';/);
  assert.match(src, /fetchSpeciesCards\(species\.n, \{ name: species\.name, lang \}\)/);
  assert.doesNotMatch(src, /fetchExactNameCards/, 'the hub itself never reads by name');
});

test('the hub keeps the dex filter, the Pokédex order and one page', () => {
  assert.match(src, /\.filter\(\(card\) => pokedexNumber\(card\) === species\.n\)/);
  assert.match(src, /filterSearchCards\(cards\(\) \|\| \[\], \{ type: 'singles', sort: 'pokedex' \}\)/);
  assert.doesNotMatch(src, /limit: 96/, 'no page size caps what the hub paints');
});
