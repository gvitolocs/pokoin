import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catalogArtLayout,
  isAmazingRare,
  isFeatureAlbumArt,
  resolveArtLayout,
} from './art-layout.js';

test('prize pack and league promo sets are not full-art by title', () => {
  assert.equal(catalogArtLayout({
    number: 'Promo | 088/198',
    set: 'Play! Pokémon Prize Pack Series',
  }), 'window');
  assert.equal(isFeatureAlbumArt({
    number: 'Ultra Rare | 061/217',
    set: 'Play! Pokémon Prize Pack Series',
  }), false);
  assert.equal(isFeatureAlbumArt({
    number: '098/159',
    set: 'Play! Pokémon Prize Pack Series',
  }), false);
});

test('full-art and illustration rarities are bleed even in a promo set', () => {
  assert.equal(catalogArtLayout({
    number: 'Full-Art | 175/159',
    set: 'Journey Together',
  }), 'bleed');
  assert.equal(isFeatureAlbumArt({
    number: 'Full-Art | 175/159',
    set: 'Play! Pokémon Prize Pack Series',
  }), true);
  assert.equal(isFeatureAlbumArt({
    rarity: 'Special Illustration Rare',
    number: '237/198',
  }), true);
  assert.equal(isFeatureAlbumArt({
    number: 'Illustration Rare | TG12/TG30',
  }), true);
  assert.equal(catalogArtLayout({
    name: 'Scizor',
    number: 'Special Illustration Rare | 205/197',
  }), 'bleed');
});

test('Sword & Shield Amazing Rare is album halfart, not Illustration Rare bleed', () => {
  const raikou = {
    name: 'Raikou',
    number: 'Illustration Rare | 050/185',
    set: 'Vivid Voltage',
    artLayout: 'bleed',
  };
  assert.equal(isAmazingRare(raikou), true);
  assert.equal(catalogArtLayout(raikou), 'halfart');
  assert.equal(resolveArtLayout(raikou), 'halfart');
  assert.equal(isFeatureAlbumArt(raikou), false);
  assert.equal(catalogArtLayout({
    name: 'Rayquaza',
    number: 'Rare | 138/185',
    set: 'Vivid Voltage',
  }), 'halfart');
  assert.equal(catalogArtLayout({
    name: 'Celebi',
    number: 'Illustration Rare | 009/076',
    set: 'Legendary Heartbeat',
  }), 'halfart');
  assert.equal(catalogArtLayout({
    name: 'Yveltal',
    number: '117/190',
    set: 'Shiny Star V',
  }), 'halfart');
  assert.equal(catalogArtLayout({
    name: 'Raikou',
    number: 'Holo Rare | 028/115',
    set: 'CS2b: Vivid Portrayals - Indigo',
  }), 'window');
  assert.equal(catalogArtLayout({
    number: 'Full Art | 188/185',
    set: 'Vivid Voltage',
  }), 'bleed');
});

test('Pokémon Shiny Rare is a framed window; Lady SV86 trainer stays bleed', () => {
  assert.equal(catalogArtLayout({
    name: 'Dolliv',
    number: 'Shiny Rare | 103/091',
    set: 'Paldean Fates',
  }), 'window');
  assert.equal(isFeatureAlbumArt({
    name: 'Dolliv',
    number: 'Shiny Rare | 103/091',
    set: 'Paldean Fates',
  }), false);
  assert.equal(catalogArtLayout({
    name: 'Diancie',
    number: 'Shiny Rare | SV36/SV94',
    set: 'Hidden Fates',
  }), 'window');
  assert.equal(resolveArtLayout({
    name: 'Diancie',
    number: 'Shiny Rare | SV36/SV94',
    set: 'Hidden Fates',
    artLayout: 'bleed',
  }), 'window');
  assert.equal(catalogArtLayout({
    name: 'Morpeko',
    number: 'Shiny Rare | SV44',
    set: 'Shining Fates',
  }), 'window');
  assert.equal(resolveArtLayout({
    name: 'Radiant Hisuian Sneasler',
    number: 'Shiny Rare | 046/071',
    set: 'Dark Phantasma',
    artLayout: 'bleed',
  }), 'window');
  assert.equal(catalogArtLayout({
    name: 'Lady',
    number: 'Shiny Rare | SV86/SV94',
    set: 'Hidden Fates',
  }), 'bleed');
  assert.equal(isFeatureAlbumArt({
    name: 'Lady',
    number: 'Shiny Rare | SV86/SV94',
  }), true);
  assert.equal(catalogArtLayout({
    name: 'Shauna',
    number: 'Ultra Rare · Full Art | 149/149',
    set: 'Boundaries Crossed',
  }), 'bleed');
  assert.equal(resolveArtLayout({
    name: 'Lady',
    number: 'Shiny Rare | SV86/SV94',
    artLayout: 'bleed',
  }), 'bleed');
});

test('Poké Ball / Master Ball reverse foil stays a framed window', () => {
  assert.equal(catalogArtLayout({
    name: 'Quaxly',
    number: 'CSV9C | Master Ball Reverse | 048/208',
  }), 'window');
  assert.equal(catalogArtLayout({
    name: "Hop's Cramorant",
    number: 'Poké Ball Reverse Holo | 143/193',
  }), 'window');
});

test('MEP First Partner illustration numbers are bleed; framed MEP stays window', () => {
  assert.equal(catalogArtLayout({ name: 'Charmander', number: 'MEP 038' }), 'bleed');
  assert.equal(catalogArtLayout({ name: 'Chikorita', number: 'Promo | MEP 046' }), 'bleed');
  assert.equal(catalogArtLayout({ name: 'Mega Venusaur ex', number: 'MEP 013' }), 'window');
  assert.equal(catalogArtLayout({ name: 'Chikorita', number: 'Cosmos Holo | MEP 069' }), 'window');
});

test('JP First Partner M-P illustration numbers are bleed; McDonald 019/M-P stays window', () => {
  assert.equal(catalogArtLayout({ name: 'Chikorita', number: '104/M-P' }), 'bleed');
  assert.equal(catalogArtLayout({ name: 'Sprigatito', number: 'M-P 125' }), 'bleed');
  assert.equal(catalogArtLayout({ name: 'Quaxly', number: 'M-P 127' }), 'bleed');
  assert.equal(catalogArtLayout({ name: 'Quaxly', number: '019/M-P' }), 'window');
});

test('XY gold secret catalog token is bleed until leftover geometry stores window', () => {
  assert.equal(catalogArtLayout({
    name: 'M Charizard ex',
    number: 'Gold Secret Rare | 108/106',
    set: 'Flashfire',
  }), 'bleed');
  assert.equal(resolveArtLayout({
    name: 'M Charizard ex',
    number: 'Gold Secret Rare | 108/106',
    artLayout: 'window',
  }), 'window');
});

test('SM gold trainer Secret Rare stays a window until leftover is Gold Secret bleed', () => {
  assert.equal(catalogArtLayout({
    name: 'Mysterious Treasure',
    number: 'Secret Rare | 145/131',
    set: 'Forbidden Light',
  }), 'window');
  assert.equal(catalogArtLayout({
    name: 'Electrocharger',
    number: 'Gold Secret Rare | 193/181',
    set: 'Team Up',
  }), 'bleed');
  assert.equal(resolveArtLayout({
    name: 'Mysterious Treasure',
    number: 'Gold Secret Rare | 145/131',
    set: 'Forbidden Light',
    artLayout: 'window',
  }), 'window');
  assert.equal(resolveArtLayout({
    name: 'Electropower',
    number: 'Gold Secret Rare | 232/214',
    set: 'Lost Thunder',
    artLayout: 'bleed',
  }), 'bleed');
  assert.equal(catalogArtLayout({
    name: 'Lightning Energy',
    number: 'Secret Rare | 168/145',
  }), 'item');
  assert.equal(resolveArtLayout({
    name: 'Rotom Dex',
    number: 'Secret Rare | 159/149',
    set: 'Sun & Moon',
    artLayout: 'window',
  }), 'window');
});

test('persisted leftover layout beats a misleading set title', () => {
  assert.equal(resolveArtLayout({
    number: '098/159',
    set: 'Play! Pokémon Prize Pack Series',
    artLayout: 'window',
  }), 'window');
  assert.equal(resolveArtLayout({
    number: 'Ultra Rare | 049/193',
    art_layout: 'bleed',
  }), 'bleed');
  assert.equal(isFeatureAlbumArt({
    name: 'Mega Eelektross ex',
    number: 'Ultra Rare | 061/217',
    set: 'Play! Pokémon Prize Pack Series',
    artLayout: 'window',
  }), false);
});

test('XY full-art EX secrets (n/m over the set) are two-row bleed tiles', () => {
  assert.equal(catalogArtLayout({
    name: 'Mewtwo ex',
    number: 'Secret Rare | 163/162',
    set: 'BREAKthrough',
  }), 'bleed');
  assert.equal(isFeatureAlbumArt({
    name: 'Mewtwo ex',
    number: 'Secret Rare | 164/162',
    set: 'BREAKthrough',
  }), true);
  assert.equal(resolveArtLayout({
    name: 'Mewtwo ex',
    number: 'Secret Rare | 163/162',
    set: 'BREAKthrough',
    artLayout: 'window',
  }), 'bleed');
  assert.equal(catalogArtLayout({
    name: 'Mewtwo ex',
    number: 'Holo Rare | 61/162',
    set: 'BREAKthrough',
  }), 'window');
  assert.equal(catalogArtLayout({
    name: 'M Mewtwo ex',
    number: 'Ultra Rare | 159/162',
    set: 'BREAKthrough',
  }), 'window');
  assert.equal(resolveArtLayout({
    name: 'M Charizard ex',
    number: 'Gold Secret Rare | 108/106',
    set: 'Flashfire',
    artLayout: 'window',
  }), 'window');
  assert.equal(catalogArtLayout({
    name: 'Mysterious Treasure',
    number: 'Secret Rare | 145/131',
    set: 'Guardians Rising',
  }), 'window');
});

test('LEGEND and BREAK names stay landscape feature tiles', () => {
  assert.equal(catalogArtLayout({ name: 'Greninja BREAK' }), 'landscape');
  assert.equal(isFeatureAlbumArt({ name: 'Greninja BREAK' }), true);
});

test('item cards skip the Pokémon illustration window', () => {
  assert.equal(catalogArtLayout({ name: 'Mewtwo Spirit Link', number: 'Uncommon | 144/162' }), 'item');
  assert.equal(isFeatureAlbumArt({ name: 'Mewtwo Spirit Link' }), true);
  assert.equal(catalogArtLayout({ name: 'Potion', number: '94/102', set: 'Base Set' }), 'window');
  assert.equal(catalogArtLayout({ name: 'Super Potion', number: '90/102', set: 'Base Set' }), 'window');
  assert.equal(catalogArtLayout({ name: 'Lightning Energy' }), 'item');
  assert.equal(catalogArtLayout({ name: 'Clefairy Doll', number: 'Rare | 70/102' }), 'window');
  assert.equal(catalogArtLayout({ name: 'Snorlax Doll' }), 'window');
  assert.equal(isFeatureAlbumArt({ name: 'Potion', set: 'Base Set' }), false);
  assert.equal(catalogArtLayout({ name: 'Mewtwo', number: 'Ultra Rare | 159/162' }), 'window');
});

test('stadium trainers use the era illustration window, not a two-row leftover', () => {
  assert.equal(catalogArtLayout({ name: 'Apricorn Forest', number: 'Uncommon | 118/147', set: 'Aquapolis' }), 'window');
  assert.equal(isFeatureAlbumArt({ name: 'Apricorn Forest' }), false);
  assert.equal(catalogArtLayout({ name: 'Undersea Ruins', set: 'Aquapolis' }), 'window');
  assert.equal(catalogArtLayout({ name: 'Battle Frontier', set: 'Crystal Guardians' }), 'window');
  assert.equal(catalogArtLayout({ name: 'Mirage Stadium', set: 'Skyridge' }), 'window');
  assert.equal(catalogArtLayout({ name: "Drake's Stadium" }), 'window');
});

test('Morty SIR stays a two-row full-art tile, not a one-row window', () => {
  const morty = {
    name: "Morty's Conviction",
    number: 'Special Illustration Rare | 211/162',
    set: 'Temporal Forces',
    artLayout: 'bleed',
  };
  assert.equal(resolveArtLayout(morty), 'bleed');
  assert.equal(isFeatureAlbumArt(morty), true);
  assert.equal(resolveArtLayout({
    name: "Professor Sada's Vitality",
    number: 'Ultra Rare | 239/182',
    set: 'Paradox Rift',
    artLayout: 'bleed',
  }), 'bleed');
});

test('BW/XY Secret Rare items and ACE SPEC stay framed windows, not two-row bleed', () => {
  assert.equal(resolveArtLayout({
    name: 'Rocky Helmet',
    number: 'Secret Rare | 153/149',
    set: 'Boundaries Crossed',
    art_layout: 'window',
  }), 'window');
  assert.equal(isFeatureAlbumArt({
    name: 'Rocky Helmet',
    number: 'Secret Rare | 153/149',
    set: 'Boundaries Crossed',
    art_layout: 'window',
  }), false);
  assert.equal(catalogArtLayout({
    name: 'Computer Search',
    number: 'Rare ACE | 137/149',
    set: 'Boundaries Crossed',
  }), 'window');
  assert.equal(isFeatureAlbumArt({
    name: 'Gold Potion',
    number: 'Rare ACE | 140/149',
    set: 'Boundaries Crossed',
  }), false);
  assert.equal(resolveArtLayout({
    name: 'Escape Rope',
    number: '120/135',
    set: 'Plasma Storm',
    art_layout: 'window',
  }), 'window');
  assert.equal(resolveArtLayout({
    name: 'Aspertia City Gym',
    number: '127/149',
    set: 'Boundaries Crossed',
    art_layout: 'window',
  }), 'window');
  assert.equal(catalogArtLayout({
    name: 'Colress Machine',
    number: '119/135',
    set: 'Plasma Storm',
  }), 'window');
  assert.equal(resolveArtLayout({
    name: 'Colress Machine',
    number: '119/135',
    set: 'Plasma Storm',
    art_layout: 'bleed',
  }), 'window');
});

test('Serena rainbow and Elesa UR supporters are two-row full-art, not a window crop', () => {
  assert.equal(resolveArtLayout({
    name: 'Serena',
    number: 'Secret Rare | 207/195',
    set: 'Silver Tempest',
    artLayout: 'window',
  }), 'bleed');
  assert.equal(isFeatureAlbumArt({
    name: "Elesa's Sparkle",
    number: 'Ultra Rare | 147/159',
    set: 'Crown Zenith',
    artLayout: 'window',
  }), true);
  assert.equal(resolveArtLayout({
    name: "Misty's Determination",
    number: 'Ultra Rare | 108/108',
    set: 'Evolutions',
    artLayout: 'window',
  }), 'bleed');
  assert.equal(resolveArtLayout({
    name: 'Wallace',
    number: 'Uncommon | 166/195',
    set: 'Silver Tempest',
    artLayout: 'window',
  }), 'window');
  assert.equal(resolveArtLayout({
    name: "Professor Sada's Vitality",
    rarity: 'Professor Program Stamp',
    number: '170/182',
    set: 'Professor Program',
    artLayout: 'bleed',
  }), 'window');
  assert.equal(resolveArtLayout({
    name: 'Pikachu',
    rarity: 'Illustration Contest 2024',
    number: 'SVP 214',
    set: 'SV Black Star Promos',
    artLayout: 'bleed',
  }), 'window');
  assert.equal(resolveArtLayout({
    name: 'Mysterious Treasure',
    number: 'Secret Rare | 145/131',
    set: 'Forbidden Light',
    artLayout: 'window',
  }), 'window');
});

test('fossil items use the era illustration window, not a two-row leftover', () => {
  assert.equal(catalogArtLayout({ name: 'Antique Jaw Fossil', number: 'Common | 068/088', set: 'Perfect Order' }), 'window');
  assert.equal(isFeatureAlbumArt({ name: 'Antique Jaw Fossil' }), false);
  assert.equal(catalogArtLayout({ name: 'Antique Sail Fossil', set: 'Perfect Order' }), 'window');
  assert.equal(catalogArtLayout({ name: 'Antique Skull Fossil', set: 'Prismatic Evolutions' }), 'window');
  assert.equal(catalogArtLayout({ name: 'Antique Armor Fossil' }), 'window');
  assert.equal(catalogArtLayout({ name: 'Dome Fossil Kabuto' }), 'window');
  assert.equal(catalogArtLayout({ name: 'Old Amber Aerodactyl' }), 'window');
  assert.equal(resolveArtLayout({
    name: 'Antique Jaw Fossil',
    artLayout: 'item',
  }), 'window');
  assert.equal(resolveArtLayout({
    name: 'Super Potion',
    set: 'Base Set',
    artLayout: 'item',
  }), 'window');
});

test('Rotom Phone items keep the era illustration window', () => {
  assert.equal(catalogArtLayout({ name: 'Rotom Phone' }), 'window');
  assert.equal(isFeatureAlbumArt({ name: 'Rotom Phone' }), false);
  assert.equal(catalogArtLayout({ name: 'Rotom Dex' }), 'window');
  assert.equal(catalogArtLayout({ name: 'Rotom Bike' }), 'window');
});

test('pre-Black & White eras have no full art — album stays a one-row window', () => {
  assert.equal(catalogArtLayout({
    name: 'Shining Mewtwo',
    number: 'Shiny Rare | 109/105',
    set: 'Neo Destiny',
  }), 'window');
  assert.equal(resolveArtLayout({
    name: 'Shining Mewtwo',
    number: 'Shiny Rare | 109/105',
    set: 'Neo Destiny',
    artLayout: 'bleed',
  }), 'window');
  assert.equal(isFeatureAlbumArt({
    name: 'Shining Mewtwo',
    set: 'Neo Destiny',
    artLayout: 'bleed',
  }), false);
  assert.equal(catalogArtLayout({
    name: 'Scyther',
    number: 'Promo | 45',
    set: 'Wizards Black Star Promos',
  }), 'window');
  assert.equal(resolveArtLayout({
    name: 'Scyther',
    set: 'Wizards Black Star Promos',
    artLayout: 'bleed',
  }), 'window');
  assert.equal(catalogArtLayout({
    name: 'Alakazam',
    number: 'Holo Rare | 1/102',
    set: 'Base Set',
  }), 'window');
  assert.equal(catalogArtLayout({
    name: 'Rayquaza Gold Star',
    number: 'Gold Star | 107/107',
    set: 'EX Deoxys',
  }), 'window');
  assert.equal(resolveArtLayout({
    name: 'Rayquaza Gold Star',
    set: 'EX Deoxys',
    artLayout: 'bleed',
  }), 'window');
  assert.equal(catalogArtLayout({
    name: 'Gyarados',
    number: 'Holo Rare | 8/144',
    set: 'Skyridge',
  }), 'window');
  assert.equal(catalogArtLayout({
    name: 'Palkia LV.X',
    number: 'Rare Holo LV.X | 125/127',
    set: 'Platinum',
  }), 'window');
  assert.equal(catalogArtLayout({
    name: 'Lightning Energy',
    set: 'Neo Genesis',
  }), 'item');
  assert.equal(isFeatureAlbumArt({
    name: 'Lightning Energy',
    set: 'Neo Destiny',
  }), true);
  assert.equal(isFeatureAlbumArt({
    name: 'Greninja BREAK',
    set: 'Breakpoint',
  }), true);
  assert.equal(isFeatureAlbumArt({
    name: 'Lady',
    number: 'Shiny Rare | SV86/SV94',
    set: 'Hidden Fates',
  }), true);
  assert.equal(isFeatureAlbumArt({
    number: 'Full Art | 188/185',
    set: 'Vivid Voltage',
  }), true);
});

test('VMAX is album bleed even if leftover_layouts still says window', () => {
  assert.equal(catalogArtLayout({
    name: 'Vaporeon VMAX',
    number: '030/203',
    set: 'Play! Pokémon Prize Pack Series Four',
  }), 'bleed');
  assert.equal(resolveArtLayout({
    name: 'Vaporeon VMAX',
    number: '030/203',
    set: 'Play! Pokémon Prize Pack Series Four',
    artLayout: 'window',
  }), 'bleed');
  assert.equal(resolveArtLayout({
    name: 'Cinderace VMAX',
    number: 'Ultra Rare | 044/192',
    set: 'Rebel Clash',
    artLayout: 'window',
  }), 'bleed');
  assert.equal(isFeatureAlbumArt({
    name: 'Cinderace VMAX',
    number: 'Secret Rare | 194/192',
    artLayout: 'window',
  }), true);
});

test('regular GX is album bleed even if leftover_layouts still says window', () => {
  assert.equal(catalogArtLayout({
    name: 'Dragonite GX',
    number: 'Ultra Rare | 152/236',
    set: 'Unified Minds',
  }), 'bleed');
  assert.equal(resolveArtLayout({
    name: 'Dragonite GX',
    number: 'Ultra Rare | 152/236',
    set: 'Unified Minds',
    artLayout: 'window',
  }), 'bleed');
  assert.equal(isFeatureAlbumArt({
    name: 'Onix GX',
    number: 'Full-Art | 036/068',
    set: 'Hidden Fates',
    artLayout: 'window',
  }), true);
  assert.equal(resolveArtLayout({
    name: 'Blastoise ex',
    number: 'Ultra Rare | 030/142',
    set: 'Stellar Crown',
    artLayout: 'window',
  }), 'window');
  assert.equal(resolveArtLayout({
    name: 'Blastoise ex',
    number: 'Stellar Crown Stamp | 030/142',
    set: 'SV Black Star Promos',
    artLayout: 'bleed',
  }), 'window');
});

test('every Spirit Link printing is an item tile, not a Pokémon window', () => {
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
    assert.equal(catalogArtLayout({ name }), 'item', name);
    assert.equal(isFeatureAlbumArt({ name }), true, name);
  }
});



test('Terastal Eevee ex SVP 174-176 promos are full-art bleed, not the stored window', () => {
  for (const card of [
    { name: 'Eevee ex', rarity: 'Promo', number: 'SVP 174', set: 'SV Black Star Promos' },
    { name: 'Espeon ex', rarity: 'Promo', number: 'SVP 175', set: 'SV Black Star Promos' },
    { name: 'Umbreon ex', rarity: 'Promo', number: 'SVP 176', set: 'SV Black Star Promos' },
  ]) {
    assert.equal(catalogArtLayout(card), 'bleed', card.number);
    assert.equal(resolveArtLayout({ ...card, artLayout: 'window' }), 'bleed', card.number);
    assert.equal(isFeatureAlbumArt({ ...card, artLayout: 'window' }), true, card.number);
  }
  assert.equal(resolveArtLayout({
    name: 'Pikachu',
    rarity: 'Illustration Contest 2024',
    number: 'SVP 214',
    set: 'SV Black Star Promos',
    artLayout: 'bleed',
  }), 'window');
  assert.equal(catalogArtLayout({
    name: 'Spidops',
    rarity: 'Cosmos Holo',
    number: 'SVP 009',
    set: 'SV Black Star Promos',
  }), 'window');
  assert.equal(catalogArtLayout({
    name: 'Charizard ex',
    number: 'SVP 196',
    set: 'SV Black Star Promos',
  }), 'window');
});

test('XY79 Latios full-art promo is album bleed, not era_border window', () => {
  assert.equal(catalogArtLayout({
    name: 'Latios',
    number: 'Holo Promo | XY79',
    set: 'XY Black Star Promos',
  }), 'bleed');
  assert.equal(resolveArtLayout({
    name: 'Latios',
    number: 'Holo Promo | XY79',
    set: 'XY Black Star Promos',
    art_layout: 'window',
  }), 'bleed');
  assert.equal(isFeatureAlbumArt({
    name: 'Latios',
    number: 'Holo Promo | XY79',
    art_layout: 'window',
  }), true);
});

test('Alternate Art Promo Sightseer stays a framed window, not catalog bleed', () => {
  assert.equal(catalogArtLayout({
    name: 'Sightseer',
    number: 'Alternate Art Promo | 189a/214',
    set: 'Miscellaneous Promos',
  }), 'window');
  assert.equal(resolveArtLayout({
    name: 'Sightseer',
    number: 'Alternate Art Promo | 189a/214',
    art_layout: 'bleed',
  }), 'window');
  assert.equal(isFeatureAlbumArt({
    name: 'Sightseer',
    number: 'Alternate Art Promo | 189a/214',
    art_layout: 'bleed',
  }), false);
  assert.equal(resolveArtLayout({
    name: 'Squirtle',
    number: 'Reverse Cosmos Holo | Costco Promo 007/165',
    set: 'Theme Deck Blisters Exclusives',
    art_layout: 'window',
  }), 'window');
});

test('XY Ancient Trait Altaria is album full-art bleed, not a window crop', () => {
  assert.equal(catalogArtLayout({
    name: 'Altaria',
    number: 'Rare | 74/108',
    set: 'Roaring Skies',
  }), 'bleed');
  assert.equal(resolveArtLayout({
    name: 'Altaria',
    number: 'Rare | 74/108',
    set: 'Roaring Skies',
    art_layout: 'window',
  }), 'bleed');
  assert.equal(isFeatureAlbumArt({
    name: 'Altaria',
    number: 'Rare | 74/108',
    set: 'Roaring Skies',
    art_layout: 'window',
  }), true);
  assert.equal(resolveArtLayout({
    name: 'Altaria',
    number: '53/108',
    set: 'Roaring Skies',
    art_layout: 'window',
  }), 'window');
  assert.equal(resolveArtLayout({
    name: 'Altaria',
    number: 'Prerelease | XY46',
    set: 'XY Black Star Promos',
    art_layout: 'window',
  }), 'bleed');
});

test("XY Ultra Rare FA EX near set end is bleed", () => {
  for (const card of [
    { name: "Pidgeot EX", number: "Ultra Rare | 104/108" },
    { name: "Dragonite EX", number: "Ultra Rare | 106/108" },
    { name: "Mewtwo EX", number: "Ultra Rare | 103/108" },
    { name: "Darkrai EX", number: "Ultra Rare | 118/122" },
    { name: "Altaria EX", number: "Ultra Rare | 123/124" },
    { name: "Thundurus EX", number: "Ultra Rare | 98/108" },
  ]) {
    assert.equal(catalogArtLayout(card), "bleed", card.name);
    assert.equal(resolveArtLayout(card), "bleed", card.name);
  }
  assert.equal(
    catalogArtLayout({ name: "Mega Eelektross ex", number: "Ultra Rare | 061/217" }),
    "window",
  );
});

