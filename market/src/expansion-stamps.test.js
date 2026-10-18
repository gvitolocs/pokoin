import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setSlug } from './api.js';
import {
  PRINTING_STAMPS,
  SET_STAMPS,
  STAMP_KEYS,
  expansionStampKey,
  expansionStampSrc,
} from './expansion-stamps.js';

const key = (set, number = '') => expansionStampKey({ slug: setSlug(set), number });

test('Battle Academy printings use the stamp named in the catalog number', () => {
  // Espeon 89/214 BA2: the Mewtwo deck stamp, not the BA2 code plate.
  assert.equal(key('Battle Academy 2020', '089/214 | Mewtwo Stamp'), 'mewtwo');
  assert.equal(key('Battle Academy 2020', '019/068 | Pikachu Stamp 30'), 'pikachu');
  assert.equal(key('Battle Academy 2020', '003/070 | Charizard Stamp 39'), 'charizard');
  assert.equal(key('Battle Academy 2022', '007/073 | 4 Cinderace Stamped'), 'cinderace');
  assert.equal(key('Battle Academy 2022', '035/073 |Eevee Stamped'), 'eevee');
  assert.equal(key('Battle Academy 2022', '043/185  | 60 Pikachu Stamped'), 'pikachu');
  assert.equal(key('Battle Academy 2024', '109 | Pikachu 28'), 'pikachu');
  assert.equal(key('Battle Academy 2024', '002 | Armarouge 10'), 'armarouge');
  assert.equal(key('Battle Academy 2024', '118 | Darkrai Deck'), 'darkrai');
  assert.equal(key('Battle Academy 2024', '110 | Drakai Deck'), 'darkrai');
  assert.equal(key('Scarlet & Violet Battle Academy', '051/066 | Greninja Stamp'), 'greninja');
  assert.equal(key('Scarlet & Violet Battle Academy', '045/066'), '');
});

test('other mascot deck kits read the stamp from the number', () => {
  assert.equal(key("Everyone's Exciting Battle", '044/047 | Zoroark  Stamp'), 'zoroark');
  assert.equal(key('Mewtwo vs Genesect Deck Kit', 'Genesect Stamp | 002/016'), 'genesect');
  assert.equal(key('Emboar EX vs Togekiss EX Deck Kit', '010/022 | Togekiss Stamp'), 'togekiss');
  assert.equal(key('Battle Gift Set: Thundurus vs Tornadus', '015/020 | Tornadus Stamp'), 'tornadus');
  assert.equal(key('Beginning Set | Pikachu Version', '001/034 | Snivy 1'), 'snivy');
  assert.equal(key('National Pokédex Beginning Set', '031/034 | Oshawott Stamp'), 'oshawott');
  assert.equal(key('XY Beginning Set', '036/039 | Fennekin Stamp'), 'fennekin');
  assert.equal(key('My First Battle', 'Unnumbered | Pokemon Ball Stamped'), 'poke-ball');
  assert.equal(key('My First Battle', 'Unnumbered | Charmander Stamp'), 'charmander');
  assert.equal(key('Sword & Shield Family Pokémon Card Game', 'Pawniard Stampad | 045/053'), 'pawniard');
  assert.equal(key('Sword & Shield Family Pokémon Card Game', 'Tyrannitar Stamped | 042/053'), 'tyranitar');
  assert.equal(key('Holiday Calendar', '010 | Holiday Snowflake Stamp'), 'holiday-snowflake');
  // Glameow 83/130 in Holiday Calendar names no stamp: keep the set mark.
  assert.equal(key('Holiday Calendar', 'Non-Holo Promo | 83/130'), '');
});

test('half-deck Trainer Kits use the mascot for every card and the set tile', () => {
  assert.equal(key('XY Trainer Kit: Bisharp', 'Non-Holo | Trainer Kit 12/30'), 'bisharp');
  assert.equal(key('XY Trainer Kit: Bisharp'), 'bisharp');
  assert.equal(key('XY Trainer Kit: Pikachu Libre & Suicune (Pikachu Libre)'), 'pikachu-libre');
  assert.equal(key('Sun & Moon Trainer Kit: Lycanroc & Alolan Raichu (Alolan Raichu)'), 'alolan-raichu');
  assert.equal(key('EX Trainer Kit 2 (Plusle)'), 'plusle');
  assert.equal(key('HS Trainer Kit (Gyarados)'), 'gyarados');
  // Multi-stamp decks have no single set mark.
  assert.equal(key('Battle Academy 2020'), '');
  // Not a stamped product: a Lost Thunder card that mentions Mewtwo.
  assert.equal(key('Lost Thunder', '089/214 | Mewtwo Stamp'), '');
});

test('stamp src is the Pokémon CDN plate and never paints on satellite games', () => {
  assert.equal(
    expansionStampSrc({ slug: 'battle-academy-2020', number: '089/214 | Mewtwo Stamp' }),
    '/card-images/expansions/stamps/mewtwo.png?v=st1',
  );
  assert.equal(expansionStampSrc({ slug: 'lost-thunder', number: '089/214' }), '');
  assert.equal(
    expansionStampSrc({ slug: 'xy-trainer-kit-bisharp' }, 'riftbound.pokoin.com'),
    '',
  );
});

test('every mapped stamp has a plate in tools/expansion-stamps/stamps.tsv', () => {
  const manifest = readFileSync(new URL('../../tools/expansion-stamps/stamps.tsv', import.meta.url), 'utf8');
  const drawn = new Set(
    manifest.split('\n')
      .filter((line) => line && !line.startsWith('#') && line !== 'key\tsource')
      .map((line) => line.split('\t')[0]),
  );
  assert.deepEqual(STAMP_KEYS.filter((k) => !drawn.has(k)), []);
  assert.deepEqual([...drawn].filter((k) => !STAMP_KEYS.includes(k)), [], 'unused plates');
  for (const slug of [...Object.keys(PRINTING_STAMPS), ...Object.keys(SET_STAMPS)]) {
    assert.equal(slug, setSlug(slug), `${slug} is a setSlug`);
  }
});
