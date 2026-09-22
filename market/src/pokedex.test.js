import assert from 'node:assert/strict';
import test from 'node:test';
import { TRAINER_DEX, pokedexNumber, pokedexPartnerNumbers, pokedexSortValue } from './pokedex.js';
import { catalogArtLayout, isFeatureAlbumArt } from './art-layout.js';
import { filterSearchCards, packPokedexSort } from './search-filters.js';

test('national dex matches print names including TCG prefixes', () => {
  assert.equal(pokedexNumber('Charizard'), 6);
  assert.equal(pokedexNumber('Flabébé'), 669);
  assert.equal(pokedexNumber('Flabebe'), 669);
  assert.equal(pokedexNumber('Dark Charizard'), 6);
  assert.equal(pokedexNumber('Charizard ex'), 6);
  assert.equal(pokedexNumber({ name: "Team Rocket's Mewtwo ex" }), 150);
  assert.equal(pokedexNumber('Mew'), 151);
  assert.equal(pokedexNumber('Mewtwo'), 150);
  assert.equal(pokedexNumber('Eevee'), 133);
  assert.equal(pokedexNumber('Snorlax'), 143);
  assert.equal(pokedexNumber('Pikachu & Zekrom-GX'), 25);
  assert.equal(pokedexNumber('Charizard & Braixen GX'), 6);
  assert.equal(pokedexNumber('Reshiram & Charizard GX'), 6);
  assert.equal(pokedexNumber('Reshiram & Zekrom GX'), 643);
  assert.equal(pokedexNumber('Palkia & Dialga LEGEND'), 484);
  assert.equal(pokedexNumber('Mr. Mime'), 122);
  assert.equal(pokedexNumber('Type: Null'), 772);
  assert.equal(pokedexNumber('Ho-Oh'), 250);
  assert.equal(pokedexNumber('Alolan Vulpix'), 37);
  assert.equal(pokedexNumber('Galarian Articuno'), 144);
  assert.equal(pokedexNumber('Nidoran♀'), 29);
  assert.equal(pokedexNumber("Farfetch'd"), 83);
});

test('trainers and energy have no dex number', () => {
  assert.equal(pokedexNumber('Professor Oak'), 0);
  assert.equal(pokedexNumber('Lightning Energy'), 0);
  assert.equal(pokedexNumber('Potion'), 0);
  assert.equal(pokedexNumber("Boss's Orders"), 0);
  assert.equal(pokedexSortValue({ name: 'Professor Oak' }), TRAINER_DEX);
});

test('fossil items stay trainers even when a Pokémon is in the name', () => {
  assert.equal(pokedexNumber('Old Amber Aerodactyl'), 0);
  assert.equal(pokedexNumber('Old Amber'), 0);
  assert.equal(pokedexNumber('Antique Old Amber'), 0);
  assert.equal(pokedexNumber('Dome Fossil Kabuto'), 0);
  assert.equal(pokedexNumber('Helix Fossil Omanyte'), 0);
  assert.equal(pokedexNumber('Claw Fossil Anorith'), 0);
  assert.equal(pokedexNumber('Root Fossil Lileep'), 0);
  assert.equal(pokedexNumber('Armor Fossil Shieldon'), 0);
  assert.equal(pokedexNumber('Skull Fossil Cranidos'), 0);
  assert.equal(pokedexNumber('Cover Fossil Tirtouga'), 0);
  assert.equal(pokedexNumber('Mysterious Fossil'), 0);
  assert.equal(pokedexNumber('Unidentified Fossil'), 0);
  assert.equal(pokedexNumber('Aerodactyl'), 142);
  assert.equal(pokedexNumber('Kabuto'), 140);
  assert.equal(pokedexNumber('Omanyte'), 138);
});

test('Rotom item cards are not Rotom in Pokédex order', () => {
  assert.equal(pokedexNumber('Rotom Phone'), 0);
  assert.equal(pokedexNumber('Rotom Dex'), 0);
  assert.equal(pokedexNumber('Rotom Catalog'), 0);
  assert.equal(pokedexNumber('Rotom Bike'), 0);
  assert.equal(pokedexNumber('Rotom Dex Poké Finder Mode'), 0);
  assert.equal(pokedexNumber('Rotom'), 479);
  assert.equal(pokedexNumber('Rotom V'), 479);
  assert.equal(pokedexNumber('Heat Rotom'), 479);
  assert.equal(pokedexNumber('Drone Rotom'), 479);
  assert.equal(pokedexSortValue({ name: 'Rotom Phone' }), TRAINER_DEX);
});

test('stored Pokédex sort cannot keep an item next to its namesake Pokémon', () => {
  const rotomPhone = packPokedexSort(479, 130002);
  const gallade = packPokedexSort(475, 90000);
  const uxie = packPokedexSort(480, 70000);
  const rows = [
    { id: 'phone', name: 'Rotom Phone', set: "Champion's Path", number: '064/073', pokedexSort: rotomPhone },
    { id: 'gallade', name: 'Gallade EX', set: 'Roaring Skies', number: '99/108', pokedexSort: gallade },
    { id: 'uxie', name: 'Uxie', set: 'Mysterious Treasures', number: '18/123', pokedexSort: uxie },
  ];
  const shown = filterSearchCards(rows, { sort: 'pokedex' });
  assert.deepEqual(shown.map((row) => row.name), ['Gallade EX', 'Uxie', 'Rotom Phone']);
});

test('Clefairy Doll is not Clefairy in Pokédex order or album crop', () => {
  assert.equal(pokedexNumber('Clefairy Doll'), 0);
  assert.equal(pokedexNumber('Snorlax Doll'), 0);
  assert.equal(pokedexNumber("Lillie's Poké Doll"), 0);
  assert.equal(pokedexNumber('Poké Doll'), 0);
  assert.equal(pokedexNumber('Clefairy'), 35);
  assert.equal(pokedexNumber('Snorlax'), 143);
  assert.equal(pokedexNumber('Dolliv'), 929);
  assert.equal(pokedexSortValue({ name: 'Clefairy Doll' }), TRAINER_DEX);
  assert.equal(catalogArtLayout({ name: 'Clefairy Doll', number: 'Rare | 70/102', set: 'Base Set' }), 'window');
  assert.equal(isFeatureAlbumArt({ name: 'Clefairy Doll' }), false);
  const clefairy = packPokedexSort(35, 10000);
  const doll = packPokedexSort(35, 11000);
  const jigglypuff = packPokedexSort(39, 10000);
  const rows = [
    { id: 'doll', name: 'Clefairy Doll', set: 'Base Set', number: 'Rare | 70/102', pokedexSort: doll },
    { id: 'clefairy', name: 'Clefairy', set: 'Jungle', number: '5/64', pokedexSort: clefairy },
    { id: 'jigglypuff', name: 'Jigglypuff', set: 'Jungle', number: '54/64', pokedexSort: jigglypuff },
  ];
  const shown = filterSearchCards(rows, { sort: 'pokedex' });
  assert.deepEqual(shown.map((row) => row.name), ['Clefairy', 'Jigglypuff', 'Clefairy Doll']);
});

test('Spirit Link item cards are not the Pokémon in the name', () => {
  const names = [
    'Aerodactyl Spirit Link', 'Aggron Spirit Link', 'Alakazam Spirit Link',
    'Altaria Spirit Link', 'Ampharos Spirit Link', 'Audino Spirit Link',
    'Beedrill Spirit Link', 'Blastoise Spirit Link', 'Camerupt Spirit Link',
    'Charizard Spirit Link', 'Gallade Spirit Link', 'Garchomp Spirit Link',
    'Gardevoir Spirit Link', 'Gengar Spirit Link', 'Glalie Spirit Link',
    'Groudon Spirit Link', 'Gyarados Spirit Link', 'Houndoom Spirit Link',
    'Kyogre Spirit Link', 'Latios Spirit Link', 'Lucario Spirit Link',
    'Manectric Spirit Link', 'Mawile Spirit Link', 'Mewtwo Spirit Link',
    'Pidgeot Spirit Link', 'Rayquaza Spirit Link', 'Salamence Spirit Link',
    'Sceptile Spirit Link', 'Scizor Spirit Link', 'Sharpedo Spirit Link',
    'Slowbro Spirit Link', 'Steelix Spirit Link', 'Tyranitar Spirit Link',
    'Venusaur Spirit Link',
  ];
  for (const name of names) {
    assert.equal(pokedexNumber(name), 0, name);
    assert.equal(catalogArtLayout({ name }), 'item', name);
    assert.equal(isFeatureAlbumArt({ name }), true, name);
  }
  assert.equal(pokedexNumber('Mewtwo'), 150);
  assert.equal(pokedexSortValue({ name: 'Mewtwo Spirit Link' }), TRAINER_DEX);
});

test('Pokédex sort is national order with trainers last', () => {
  const rows = [
    { name: 'Charizard', set: 'Base Set', number: '4/102' },
    { name: 'Professor Oak', set: 'Base Set', number: '88/102' },
    { name: 'Mewtwo', set: 'Fossil', number: '10/62' },
    { name: 'Eevee', set: 'Jungle', number: '51/64' },
    { name: 'Snorlax', set: 'Jungle', number: '11/64' },
    { name: 'Charizard', set: 'Obsidian Flames', number: '234/197' },
    { name: 'Potion', set: 'Base Set', number: '94/102' },
    { name: 'Aerodactyl', set: 'Fossil', number: '1/62' },
    { name: 'Old Amber Aerodactyl', set: 'Dark Explorers', number: '97/108' },
  ];
  const shown = filterSearchCards(rows, { sort: 'pokedex' });
  assert.deepEqual(shown.map((row) => `${row.name}|${row.set}`), [
    'Charizard|Base Set',
    'Charizard|Obsidian Flames',
    'Eevee|Jungle',
    'Aerodactyl|Fossil',
    'Snorlax|Jungle',
    'Mewtwo|Fossil',
    'Professor Oak|Base Set',
    'Potion|Base Set',
    'Old Amber Aerodactyl|Dark Explorers',
  ]);
});

test('same Pokémon printings sort oldest era then oldest expansion', () => {
  const rows = [
    { name: 'Charizard', set: 'Obsidian Flames', number: '234/197' },
    { name: 'Charizard', set: 'Evolutions', number: '11/108' },
    { name: 'Charizard', set: 'Base Set', number: '4/102' },
    { name: 'Charizard', set: 'EX FireRed & LeafGreen', number: '6/112' },
  ];
  const shown = filterSearchCards(rows, { sort: 'pokedex' });
  assert.deepEqual(shown.map((row) => row.set), [
    'Base Set',
    'EX FireRed & LeafGreen',
    'Evolutions',
    'Obsidian Flames',
  ]);
});

test('Pokédex sort keeps CLIP same-artwork reprints together after species', () => {
  const undaunted = packPokedexSort(235, 80002);
  const callOfLegends = packPokedexSort(235, 90000);
  const smoochum = packPokedexSort(238, 80000);
  const rows = [
    { id: '633434', name: 'Smeargle', set: 'World Championship Decks 2012', number: 'WCD 2012 | Zachary Bokhari | 021/095', version: 'v224682', pokedexSort: callOfLegends, expansionSort: 105000, collectorSort: 21 },
    { id: '261676', name: 'Smeargle', set: 'Undaunted', number: 'Holo Rare | 8/90', version: 'v261676', pokedexSort: undaunted, expansionSort: 80002, collectorSort: 8 },
    { id: '224682', name: 'Smeargle', set: 'Call of Legends', number: 'Holo Rare | 21/95', version: 'v224682', pokedexSort: callOfLegends, expansionSort: 90000, collectorSort: 21 },
    { id: '653506', name: 'Smeargle', set: 'World Championship Decks 2012', number: 'WCD 2012 | Igor Costa | 008/090', version: 'v261676', pokedexSort: undaunted, expansionSort: 105000, collectorSort: 8 },
    { id: '632226', name: 'Smeargle', set: 'World Championship Decks 2012', number: 'WCD 2012 | Chase Moloney | 021/095', version: 'v224682', pokedexSort: callOfLegends, expansionSort: 105000, collectorSort: 21 },
    { id: 'smoochum', name: 'Smoochum', set: 'HeartGold & SoulSilver', number: 'Rare | 030/123', pokedexSort: smoochum, expansionSort: 80000, collectorSort: 30 },
  ];
  const shown = filterSearchCards(rows, { sort: 'pokedex' });
  assert.deepEqual(shown.map((row) => `${row.set}|${row.number}`), [
    'Undaunted|Holo Rare | 8/90',
    'World Championship Decks 2012|WCD 2012 | Igor Costa | 008/090',
    'Call of Legends|Holo Rare | 21/95',
    'World Championship Decks 2012|WCD 2012 | Chase Moloney | 021/095',
    'World Championship Decks 2012|WCD 2012 | Zachary Bokhari | 021/095',
    'HeartGold & SoulSilver|Rare | 030/123',
  ]);
});

test('Tag Team GX leftovers appear once under each listed partner Dex', () => {
  assert.deepEqual(pokedexPartnerNumbers('Charizard & Braixen GX'), [6, 654]);
  assert.deepEqual(pokedexPartnerNumbers('Reshiram & Charizard GX'), [643, 6]);
  assert.deepEqual(pokedexPartnerNumbers('Moltres & Zapdos & Articuno GX'), [146, 145, 144]);
  assert.deepEqual(pokedexPartnerNumbers('Muk & Alolan Muk GX'), [89]);
  assert.deepEqual(pokedexPartnerNumbers('Palkia & Dialga LEGEND'), [484]);
  assert.deepEqual(pokedexPartnerNumbers('League Battle Decks: Pikachu & Zekrom GX'), [25]);
  const charizard = packPokedexSort(6, 10000);
  const braixenTeam = packPokedexSort(6, 140000);
  const reshizard = packPokedexSort(643, 130000);
  const reshiram = packPokedexSort(643, 110000);
  const braixen = packPokedexSort(654, 140000);
  const squirtle = packPokedexSort(7, 10000);
  const legend = packPokedexSort(484, 80000);
  const rows = [
    { id: 'sq', name: 'Squirtle', set: 'Base Set', number: '63/102', pokedexSort: squirtle },
    { id: 'resh', name: 'Reshiram', set: 'Black & White', number: '113/114', pokedexSort: reshiram },
    { id: 'rz', name: 'Reshiram & Charizard GX', set: 'Unbroken Bonds', number: 'Ultra Rare | 20/214', pokedexSort: reshizard },
    { id: 'cb', name: 'Charizard & Braixen GX', set: 'Cosmic Eclipse', number: 'Full-Art | 22/236', pokedexSort: braixenTeam },
    { id: 'bx', name: 'Braixen', set: 'XY', number: '25/146', pokedexSort: braixen },
    { id: 'ch', name: 'Charizard', set: 'Base Set', number: '4/102', pokedexSort: charizard },
    { id: 'pd', name: 'Palkia & Dialga LEGEND', set: 'HeartGold & SoulSilver', number: '101/123', pokedexSort: legend },
  ];
  const shown = filterSearchCards(rows, { sort: 'pokedex', expandPokedexPairs: true });
  assert.deepEqual(shown.map((row) => `${row.name}@${row.pokedexSlot || pokedexNumber(row)}`), [
    'Charizard@6',
    'Reshiram & Charizard GX@6',
    'Charizard & Braixen GX@6',
    'Squirtle@7',
    'Palkia & Dialga LEGEND@484',
    'Reshiram@643',
    'Reshiram & Charizard GX@643',
    'Braixen@654',
    'Charizard & Braixen GX@654',
  ]);
  assert.equal(shown.filter((row) => row.id === 'pd').length, 1);
});

test('packPokedexSort is species millions plus CLIP cluster-oldest expansion', () => {
  assert.equal(packPokedexSort(235, 80002), 235080002);
  assert.equal(packPokedexSort(TRAINER_DEX, 80000), TRAINER_DEX * 1_000_000 + 80000);
});

test('every SPECIES key resolves as a single-token card name', async () => {
  const { default: SPECIES } = await import('./data/pokedex-species.js');
  let checked = 0;
  for (const [key, n] of Object.entries(SPECIES)) {
    if (key.length < 3) continue;
    const name = key.charAt(0).toUpperCase() + key.slice(1);
    assert.equal(pokedexNumber(name), n, name);
    checked += 1;
  }
  assert.ok(checked >= 1000, `expected >=1000 species keys, got ${checked}`);
});

