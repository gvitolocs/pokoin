import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chineseYearHeading,
  expansionCode,
  expansionEra,
  expansionLogoSrc,
  expansionMatchesChip,
  expansionSymbolSrc,
  eraFromParam,
  eraHref,
  expansionsForEraPage,
  groupExpansions,
  headingHref,
  isSetVariant,
  tcgEra,
} from './set-logos.js';

test('western main sets group into Watchtower eras', () => {
  assert.equal(expansionEra({ slug: 'pitch-black', nationality: 'western' }), 'Mega Evolution');
  assert.equal(expansionEra({ slug: 'scarlet-and-violet', nationality: 'western' }), 'Scarlet & Violet');
  assert.equal(expansionEra({ slug: '151', name: '151', nationality: 'western' }), 'Scarlet & Violet');
  assert.equal(expansionEra({ slug: 'sword-and-shield', nationality: 'western' }), 'Sword & Shield');
  assert.equal(expansionEra({ slug: 'hidden-fates', nationality: 'western' }), 'Sun & Moon');
  assert.equal(expansionEra({ slug: 'shining-fates', nationality: 'western' }), 'Sword & Shield');
  assert.equal(expansionEra({ slug: 'burning-shadows', nationality: 'western' }), 'Sun & Moon');
  assert.equal(expansionEra({ slug: 'flashfire', nationality: 'western' }), 'XY');
  assert.equal(expansionEra({ slug: 'black-and-white', nationality: 'western' }), 'Black & White');
  assert.equal(expansionEra({ slug: 'fossil', nationality: 'western' }), 'Original');
  assert.equal(expansionEra({ slug: 'platinum', nationality: 'western' }), 'Platinum');
  assert.equal(expansionEra({ slug: 'call-of-legends', nationality: 'western' }), 'Call of Legends');
});

test('nationality wins over English set names', () => {
  assert.equal(expansionEra({ slug: 'pokemon-card-151', name: 'Pokémon Card 151', nationality: 'japanese' }), 'Japanese');
  assert.equal(
    expansionEra({ slug: 'scarlet-and-violet-simplified-chinese-promos', nationality: 'chinese' }),
    'Chinese',
  );
  assert.equal(
    expansionEra({
      slug: '30th-anniversary-celebration-first-partner-illustration-collection',
      name: '30th Anniversary Celebration: First Partner Illustration Collection',
      nationality: 'chinese',
    }),
    'Chinese',
  );
});

test('black bolt is SV, not Black & White', () => {
  assert.equal(expansionEra({ slug: 'black-bolt', name: 'Black Bolt', nationality: 'western' }), 'Scarlet & Violet');
});

test('printings group by TCG era, JP with EN, Original before EX', () => {
  assert.equal(tcgEra({ set: 'Ascended Heroes', nationality: 'western' }), 'Mega Evolution');
  assert.equal(tcgEra({ set: 'Mega Brave', nationality: 'japanese' }), 'Mega Evolution');
  assert.equal(tcgEra({ set: 'Nihil Zero', nationality: 'japanese' }), 'Mega Evolution');
  assert.equal(tcgEra({ set: 'Black Bolt', nationality: 'western' }), 'Scarlet & Violet');
  assert.equal(tcgEra({ set: 'CS1b: Dynamax Clash - Flame', nationality: 'chinese' }), 'Sword & Shield');
  assert.equal(tcgEra({ set: 'Sword', nationality: 'japanese' }), 'Sword & Shield');
  assert.equal(tcgEra({ set: 'Sword & Shield', nationality: 'western' }), 'Sword & Shield');
  assert.equal(tcgEra({ set: 'Premium Trainer Box VSTAR' }), 'Sword & Shield');
  assert.equal(tcgEra({ set: 'Single Strike & Rapid Strike Premium Trainer Boxes' }), 'Sword & Shield');
  assert.equal(tcgEra({ set: 'Lightning Starter Set V', nationality: 'japanese' }), 'Sword & Shield');
  assert.equal(tcgEra({ set: 'Fire Starter Set V', nationality: 'japanese' }), 'Sword & Shield');
  assert.equal(tcgEra({ set: 'VMAX Starter Deck: Venusaur VMAX', nationality: 'japanese' }), 'Sword & Shield');
  assert.equal(tcgEra({ set: 'Lost Thunder' }), 'Sun & Moon');
  assert.equal(tcgEra({ set: 'Collection Moon' }), 'Sun & Moon');
  assert.equal(tcgEra({ set: 'Ultra Sun' }), 'Sun & Moon');
  assert.equal(tcgEra({ set: 'Hidden Fates' }), 'Sun & Moon');
  assert.equal(tcgEra({ set: 'CSM1a: Storming Emergence - Radiant' }), 'Sun & Moon');
  assert.equal(tcgEra({ set: 'Flashfire' }), 'XY');
  assert.equal(tcgEra({ set: 'Emerging Powers' }), 'Black & White');
  assert.equal(tcgEra({ set: 'EX Battle Boost' }), 'Black & White');
  assert.equal(tcgEra({ set: 'HeartGold & SoulSilver' }), 'HeartGold & SoulSilver');
  assert.equal(tcgEra({ set: 'Lost Link' }), 'HeartGold & SoulSilver');
  assert.equal(tcgEra({ set: 'Call of Legends' }), 'Call of Legends');
  assert.equal(tcgEra({ set: 'Stormfront' }), 'Diamond & Pearl');
  assert.equal(tcgEra({ set: 'Platinum' }), 'Platinum');
  assert.equal(tcgEra({ set: 'Advent of Arceus' }), 'Platinum');
  assert.equal(tcgEra({ set: 'EX Ruby & Sapphire' }), 'EX');
  assert.equal(tcgEra({ set: 'Aquapolis' }), 'e-Card');
  assert.equal(tcgEra({ set: 'The Town on No Map' }), 'e-Card');
  assert.equal(tcgEra({ set: 'Legendary Collection' }), 'Legendary Collection');
  assert.equal(tcgEra({ set: 'Pokémon Card★web' }), 'VS / web');
  assert.equal(tcgEra({ set: 'Pokémon VS' }), 'VS / web');
  assert.equal(tcgEra({ set: 'ADV Promos' }), 'EX');
  assert.equal(tcgEra({ set: 'Neo Genesis' }), 'Neo');
  assert.equal(tcgEra({ set: 'Fossil' }), 'Original');
  assert.equal(tcgEra({ set: 'Base Set' }), 'Original');
  assert.equal(tcgEra({ set: 'Base Set 2' }), 'Original');
  assert.equal(tcgEra({ set: 'Glory of the Rocket Gang' }), 'Scarlet & Violet');
  assert.equal(tcgEra({ set: 'Team Rocket Returns' }), 'EX');
  assert.equal(tcgEra({ set: 'Team Rocket' }), 'Original');
  assert.equal(tcgEra({ set: 'Play! Pokémon Prize Pack Series', number: 'Cosmos Holo | 079/085' }), 'Scarlet & Violet');
  assert.equal(tcgEra({ set: 'Play! Pokémon Prize Pack Series', number: '156/202' }), 'Sword & Shield');
  assert.equal(tcgEra({
    set: 'Play! Pokémon Prize Pack Series',
    number: 'Non-Holo / Cosmos Holo · SVI 196',
  }), 'Scarlet & Violet');
  assert.equal(tcgEra({
    set: 'Prerelease Promos',
    number: 'Perfect Order Stamped | 024/088',
  }), 'Mega Evolution');
  assert.equal(tcgEra({
    set: 'Prerelease Promos',
    number: 'STAFF | Prerelease SVP 118',
  }), 'Scarlet & Violet');
  assert.equal(tcgEra({ set: 'League Promos', number: 'League Promo | 049/203' }), 'Other');
});

test('wordmarks are not set icons', () => {
  assert.equal(
    expansionLogoSrc({ slug: 'pitch-black' }),
    '/card-images/expansions/wordmarks/pitch-black.png',
  );
  assert.equal(
    expansionLogoSrc({ slug: 'base-set' }),
    '/card-images/expansions/logos/base-set.png',
  );
  assert.equal(
    expansionLogoSrc({ slug: 'abyss-eye' }),
    '/card-images/expansions/logos/abyss-eye.png',
  );
  assert.equal(
    expansionLogoSrc({ slug: 'alter-genesis' }),
    '/card-images/expansions/logos/alter-genesis.png',
  );
  assert.equal(
    expansionLogoSrc({ slug: 'delta-reign' }),
    '/card-images/expansions/logos/delta-reign.png',
  );
  assert.equal(
    expansionLogoSrc({ slug: 'pitch-black', logoImageUrl: 'https://cdn.pokoin.com/custom.png' }),
    'https://cdn.pokoin.com/custom.png',
  );
});

test('desk shortcuts use the circular expansion symbol, not the wordmark', () => {
  assert.equal(
    expansionSymbolSrc({ slug: 'lost-thunder' }),
    '/card-images/expansions/symbols/lost-thunder.png?v=cm1',
  );
  assert.equal(
    expansionSymbolSrc({ slug: 'lost-thunder', defaultSymbolUrl: 'https://cdn.pokoin.com/expansions/symbols/lost-thunder.png' }),
    'https://cdn.pokoin.com/expansions/symbols/lost-thunder.png?v=cm1',
  );
  assert.equal(
    expansionSymbolSrc({ slug: 'super-burst-impact', expansionSymbolUrl: 'https://cdn.pokoin.com/expansions/symbols/super-burst-impact.png?v=aa2' }),
    'https://cdn.pokoin.com/expansions/symbols/super-burst-impact.png?v=aa2',
  );
  assert.equal(
    expansionSymbolSrc({ slug: 'pop-series-7' }),
    '/card-images/expansions/symbols/pop-series-7.png?v=cm1',
  );
});

test('official codes prefer Watchtower marks', () => {
  assert.equal(expansionCode({ slug: '151', name: '151' }), 'MEW');
  assert.equal(expansionCode({ slug: 'paldean-fates', name: 'Paldean Fates' }), 'PAF');
  assert.equal(expansionCode({ slug: 'pitch-black', name: 'Pitch Black' }), 'ME5');
});

test('reverse-holo subsets stay hidden until searched', () => {
  const rows = [
    { slug: 'pitch-black', name: 'Pitch Black', nationality: 'western' },
    { slug: 'pitch-black-master-ball-reverse-holo', name: 'Pitch Black - Master Ball Reverse Holo', nationality: 'western' },
  ];
  const all = groupExpansions(rows, { chip: 'all' });
  assert.deepEqual(all.map(([era, list]) => [era, list.map((row) => row.slug)]), [
    ['Mega Evolution', ['pitch-black']],
  ]);
  const searched = groupExpansions(rows, { query: 'master ball' });
  assert.equal(searched[0][1].length, 1);
  assert.equal(searched[0][1][0].slug, 'pitch-black-master-ball-reverse-holo');
});

test('classic chip includes EX, Platinum, Original', () => {
  assert.equal(expansionMatchesChip('EX', 'classic'), true);
  assert.equal(expansionMatchesChip('Original', 'classic'), true);
  assert.equal(expansionMatchesChip('Platinum', 'classic'), true);
  assert.equal(expansionMatchesChip('Call of Legends', 'classic'), true);
  assert.equal(expansionMatchesChip('Scarlet & Violet', 'classic'), false);
});

test('variant detector', () => {
  assert.equal(isSetVariant({ slug: 'white-flare-master-ball-reverse-holo', name: 'White Flare - Master Ball Reverse Holo' }), true);
  assert.equal(isSetVariant({ slug: 'white-flare', name: 'White Flare' }), false);
});

test('era setlist hrefs use the TCG block slug', () => {
  assert.equal(eraHref('Neo'), '/marketplace/eras/neo');
  assert.equal(eraFromParam('neo'), 'Neo');
  assert.equal(eraFromParam('scarlet-violet'), 'Scarlet & Violet');
  assert.equal(eraFromParam('vs-web'), 'VS / web');
  assert.equal(eraFromParam('japanese'), 'Japanese');
  assert.equal(eraFromParam('not-an-era'), null);
});

test('era setlist keeps JP and EN of the same block together, western first', () => {
  const rows = expansionsForEraPage([
    { slug: 'awakening-legends', name: 'Awakening Legends', nationality: 'japanese' },
    { slug: 'neo-genesis', name: 'Neo Genesis', nationality: 'western' },
    { slug: 'base-set', name: 'Base Set', nationality: 'western' },
    { slug: 'neo-genesis-master-ball-reverse-holo', name: 'Neo Genesis - Master Ball Reverse Holo', nationality: 'western' },
  ], 'Neo');
  assert.deepEqual(rows.map((row) => row.slug), ['neo-genesis', 'awakening-legends']);
});

test('japanese era page stays a nationality bucket', () => {
  const rows = expansionsForEraPage([
    { slug: 'awakening-legends', name: 'Awakening Legends', nationality: 'japanese' },
    { slug: 'neo-genesis', name: 'Neo Genesis', nationality: 'western' },
  ], 'Japanese');
  assert.deepEqual(rows.map((row) => row.slug), ['awakening-legends']);
});

test('main sets sort in release order inside an era', () => {
  const grouped = groupExpansions([
    { slug: 'pitch-black', name: 'Pitch Black', nationality: 'western' },
    { slug: 'mega-evolution', name: 'Mega Evolution', nationality: 'western' },
    { slug: 'ascended-heroes', name: 'Ascended Heroes', nationality: 'western' },
  ], { chip: 'Mega Evolution' });
  assert.deepEqual(grouped[0][1].map((row) => row.slug), [
    'mega-evolution',
    'ascended-heroes',
    'pitch-black',
  ]);
});

test('Japanese chip groups by TCG era, not one nationality pile', () => {
  const grouped = groupExpansions([
    { slug: 'storm-emeralda', name: 'Storm Emeralda', nationality: 'japanese' },
    { slug: '25th-anniversary-collection', name: '25th Anniversary Collection', nationality: 'japanese' },
    { slug: '10th-movie-commemoration-set', name: '10th Movie Commemoration Set', nationality: 'japanese' },
    { slug: 'pitch-black', name: 'Pitch Black', nationality: 'western' },
  ], { chip: 'Japanese' });
  assert.deepEqual(grouped.map(([era, list]) => [era, list.map((row) => row.slug)]), [
    ['Mega Evolution', ['storm-emeralda']],
    ['Sword & Shield', ['25th-anniversary-collection']],
    ['Diamond & Pearl', ['10th-movie-commemoration-set']],
  ]);
});

test('Mega Evolution chip includes Japanese of that block, not Chinese', () => {
  const grouped = groupExpansions([
    { slug: 'storm-emeralda', name: 'Storm Emeralda', nationality: 'japanese' },
    { slug: 'mega-evolution', name: 'Mega Evolution', nationality: 'western' },
    { slug: 'mep-promos', name: 'ME-P Promos', nationality: 'chinese' },
  ], { chip: 'Mega Evolution' });
  assert.deepEqual(grouped[0][1].map((row) => row.slug), [
    'mega-evolution',
    'storm-emeralda',
  ]);
});

test('Chinese chip uses year headings newest first', () => {
  const grouped = groupExpansions([
    { slug: 'csm1a-storming-emergence-radiant', name: 'CSM1a: Storming Emergence - Radiant', nationality: 'chinese' },
    { slug: 'csv8-brilliant-fantasy', name: 'CSV8: Brilliant Fantasy', nationality: 'chinese' },
    { slug: 'cs1b-dynamax-clash-flame', name: 'CS1b: Dynamax Clash - Flame', nationality: 'chinese' },
  ], { chip: 'Chinese' });
  assert.deepEqual(grouped.map(([era, list]) => [era, list.map((row) => row.slug)]), [
    ['2023–2025', ['csv8-brilliant-fantasy']],
    ['2019/2020–2023', ['cs1b-dynamax-clash-flame']],
    ['2016/2017–2019', ['csm1a-storming-emergence-radiant']],
  ]);
  assert.equal(chineseYearHeading({
    slug: 'csv8-brilliant-fantasy',
    name: 'CSV8: Brilliant Fantasy',
    nationality: 'chinese',
  }), '2023–2025');
});

test('All sets keep JP on TCG headings and Chinese on years', () => {
  const grouped = groupExpansions([
    { slug: 'storm-emeralda', name: 'Storm Emeralda', nationality: 'japanese' },
    { slug: 'mega-evolution', name: 'Mega Evolution', nationality: 'western' },
    { slug: 'csv8-brilliant-fantasy', name: 'CSV8: Brilliant Fantasy', nationality: 'chinese' },
  ], { chip: 'all' });
  assert.deepEqual(grouped.map(([era, list]) => [era, list.map((row) => row.slug)]), [
    ['Mega Evolution', ['mega-evolution', 'storm-emeralda']],
    ['2023–2025', ['csv8-brilliant-fantasy']],
  ]);
});

test('mixed era groups list western sets before Japanese', () => {
  const grouped = groupExpansions([
    { slug: 'blastoise-battle-starter-deck', name: 'Blastoise Battle Starter Deck', nationality: 'japanese' },
    { slug: 'heartgold-and-soulsilver', name: 'HeartGold & SoulSilver', nationality: 'western' },
    { slug: 'clash-at-the-summit', name: 'Clash at the Summit', nationality: 'japanese' },
  ], { chip: 'all' });
  assert.deepEqual(grouped[0][1].map((row) => row.slug), [
    'heartgold-and-soulsilver',
    'blastoise-battle-starter-deck',
    'clash-at-the-summit',
  ]);
});

test('year headings link to the TCG era page', () => {
  assert.equal(headingHref('Scarlet & Violet'), '/marketplace/eras/scarlet-violet');
  assert.equal(headingHref('2023–2025'), '/marketplace/eras/scarlet-violet');
  assert.equal(headingHref('2019/2020–2023'), '/marketplace/eras/sword-shield');
  assert.equal(headingHref('Other'), '/marketplace/eras/other');
});
