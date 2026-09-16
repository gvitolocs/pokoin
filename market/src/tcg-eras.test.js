import assert from 'node:assert/strict';
import test from 'node:test';
import { eraFromChineseCode, matchTcgEra } from './tcg-eras.js';
import { tcgEra } from './set-logos.js';

test('Chinese codes: CSV before CS, CSM stays Sun & Moon', () => {
  assert.equal(eraFromChineseCode('csv1-eternal-birth'), 'Scarlet & Violet');
  assert.equal(eraFromChineseCode('csv10c-chasing-glory'), 'Scarlet & Violet');
  assert.equal(eraFromChineseCode('csve1-battle-party-dream-together'), 'Scarlet & Violet');
  assert.equal(eraFromChineseCode('csvh4ec-happy-pack'), 'Scarlet & Violet');
  assert.equal(eraFromChineseCode('csvnc-land-of-kitakami-special-pack'), 'Scarlet & Violet');
  assert.equal(eraFromChineseCode('cs3a-primordial-martial-arts-overgrowth'), 'Sword & Shield');
  assert.equal(eraFromChineseCode('cs6-5-victory-star-guide'), 'Sword & Shield');
  assert.equal(eraFromChineseCode('csf-return-of-the-dragon'), 'Sword & Shield');
  assert.equal(eraFromChineseCode('csdc-pikachu-legendary-celebration'), 'Sword & Shield');
  assert.equal(eraFromChineseCode('csh-eevee-gx-gift-box'), 'Sword & Shield');
  assert.equal(eraFromChineseCode('csm1a-storming-emergence-radiant'), 'Sun & Moon');
  assert.equal(
    eraFromChineseCode('csma-arceus-and-dialga-and-palkia-gx-advanced-deck-building-gift-box'),
    'Sun & Moon',
  );
  assert.equal(eraFromChineseCode('mega-start-deck-100-battle-collection'), null);
  assert.equal(eraFromChineseCode('me1-foo'), 'Mega Evolution');
  assert.equal(eraFromChineseCode('mep-promos'), 'Mega Evolution');
});

test('JP / CN aliases are not official names but still classify', () => {
  assert.equal(tcgEra({ set: 'Explosive Flame Walker' }), 'Sword & Shield');
  assert.equal(tcgEra({ set: 'Matchless Fighters' }), 'Sword & Shield');
  assert.equal(tcgEra({ set: 'Shocking Volt Tackle' }), 'Sword & Shield');
  assert.equal(tcgEra({ set: 'Towering Perfection' }), 'Sword & Shield');
  assert.equal(tcgEra({ set: '25th Anniversary Golden Box' }), 'Sword & Shield');
  assert.equal(tcgEra({ set: 'Heat Wave Arena' }), 'Scarlet & Violet');
  assert.equal(tcgEra({ set: 'Mask of Change' }), 'Scarlet & Violet');
  assert.equal(tcgEra({ set: 'Premium Champion Pack' }), 'XY');
  assert.equal(tcgEra({ set: 'MEGA Start Deck 100 Battle Collection Corociao Version' }), 'Mega Evolution');
  assert.equal(tcgEra({ set: 'Premium Trainer Box MEGA' }), 'Mega Evolution');
  assert.equal(tcgEra({
    slug: '30th-anniversary-celebration-first-partner-illustration-collection',
    name: '30th Anniversary Celebration: First Partner Illustration Collection',
  }), 'Mega Evolution');
});

test('dated products: WCD year, McDonald\'s, POP, Trick or Trade', () => {
  assert.equal(tcgEra({ slug: 'world-championship-decks-2007' }), 'EX');
  assert.equal(tcgEra({ slug: 'world-championship-decks-2008' }), 'Diamond & Pearl');
  assert.equal(tcgEra({ slug: 'world-championship-decks-2010' }), 'HeartGold & SoulSilver');
  assert.equal(tcgEra({ slug: 'world-championship-decks-2011' }), 'Black & White');
  assert.equal(tcgEra({ slug: 'world-championship-decks-2016' }), 'XY');
  assert.equal(tcgEra({ slug: 'world-championship-decks-2019' }), 'Sun & Moon');
  assert.equal(tcgEra({ slug: 'world-championship-decks-2023' }), 'Sword & Shield');
  assert.equal(tcgEra({ slug: 'world-championships-2023-yokohama-deck-pikachu' }), 'Scarlet & Violet');
  assert.equal(tcgEra({ slug: 'world-championship-decks-2025' }), 'Scarlet & Violet');
  assert.equal(tcgEra({ slug: 'mcdonald-s-collection-2012' }), 'Black & White');
  assert.equal(tcgEra({ slug: 'mcdonald-s-collection-2015' }), 'XY');
  assert.equal(tcgEra({ slug: 'mcdonald-s-collection-2018-french' }), 'Sun & Moon');
  assert.equal(tcgEra({ slug: 'pop-series-4' }), 'EX');
  assert.equal(tcgEra({ slug: 'pop-series-9' }), 'Platinum');
  assert.equal(tcgEra({ slug: 'trick-or-trade' }), 'Sword & Shield');
  assert.equal(tcgEra({ slug: 'trick-or-trade-2024' }), 'Scarlet & Violet');
});

test('deck and promo aliases from the Other pass', () => {
  assert.equal(tcgEra({ set: 'L-P Promo' }), 'HeartGold & SoulSilver');
  assert.equal(tcgEra({ set: 'PCG Promos' }), 'EX');
  assert.equal(tcgEra({ set: 'Start Deck 100' }), 'Sword & Shield');
  assert.equal(tcgEra({ set: 'MEGA Start Deck 100 Battle Collection' }), 'Mega Evolution');
  assert.equal(tcgEra({ set: 'Expansion Sheet' }), 'Original');
  assert.equal(tcgEra({ set: 'Theater Limited VS Pack' }), 'VS / web');
  assert.equal(tcgEra({ set: 'Pokémon Rumble' }), 'Platinum');
  assert.equal(tcgEra({ set: 'League Promos' }), 'Other');
  assert.equal(tcgEra({ slug: 'p-promos', name: 'P Promos' }), 'e-Card');
  assert.equal(tcgEra({ slug: 't-promos', name: 'T Promos' }), 'e-Card');
  assert.equal(tcgEra({ slug: 'm-p-promos', name: 'M-P Promos', number: '078/M-P' }), 'Mega Evolution');
  assert.equal(tcgEra({ slug: 'pcg-promos', name: 'PCG Promos' }), 'EX');
  assert.equal(tcgEra({ slug: 'ppp-promos', name: 'PPP Promos' }), 'Diamond & Pearl');
  assert.equal(tcgEra({ slug: 'southeast-asia-gym-promos' }), 'Scarlet & Violet');
  assert.equal(tcgEra({ slug: 'thailand-and-indonesia-products' }), 'Sun & Moon');
  assert.equal(tcgEra({ slug: 'pokemon-misprints', name: 'Pokémon Misprints' }), 'Original');
  assert.equal(tcgEra({ slug: 'gym-booster-2-challenge-from-the-darkness', name: 'Gym Booster 2: Challenge from the Darkness' }), 'Original');
  assert.equal(tcgEra({ slug: 'gym-booster-1-leaders-stadium', name: "Gym Booster 1 Leaders' Stadium" }), 'Original');
  assert.equal(tcgEra({ slug: 'gym-challenge', name: 'Gym Challenge' }), 'Original');
  assert.equal(tcgEra({ slug: 'gym-heroes', name: 'Gym Heroes' }), 'Original');
  assert.equal(tcgEra({ slug: 'w-promos', name: 'W Promos' }), 'Other');
  assert.equal(tcgEra({ slug: 'yu-nagaba-x-pokemon-card-game' }), 'Other');
});

test('eras/ex is the 2003–2007 block, not substring ex', () => {
  const desk = (slug, name) => tcgEra({ slug, name, set: name });
  assert.equal(desk('ex-ruby-and-sapphire', 'EX Ruby & Sapphire'), 'EX');
  assert.equal(desk('earth-s-groudon-ex-constructed-starter-deck', "Earth's Groudon ex Constructed Starter Deck"), 'EX');
  assert.equal(desk('latias-ex-half-deck', 'Latias ex Half Deck'), 'EX');
  assert.equal(desk('ex-trainer-kit', 'EX Trainer Kit'), 'EX');
  assert.equal(desk('ex-battle-stadium', 'EX Battle Stadium'), 'EX');
  assert.equal(desk('pop-series-4', 'POP Series 4'), 'EX');

  assert.equal(desk('scarlet-ex', 'Scarlet ex'), 'Scarlet & Violet');
  assert.equal(desk('shiny-treasure-ex', 'Shiny Treasure ex'), 'Scarlet & Violet');
  assert.equal(desk('terastal-festival-ex', 'Terastal Festival ex'), 'Scarlet & Violet');
  assert.equal(desk('ex-starter-set-pikachu-ex-and-pawmot', 'ex Starter Set Pikachu ex & Pawmot'), 'Scarlet & Violet');
  assert.equal(desk('ex-start-decks', 'ex Start Decks'), 'Scarlet & Violet');
  assert.equal(desk('generations-start-decks', 'Generations Start Decks'), 'Scarlet & Violet');
  assert.equal(desk('generations', 'Generations'), 'XY');
  assert.equal(desk('generations-promos', 'Generations Promos'), 'XY');
  assert.equal(desk('battle-master-deck-tera-charizard-ex', 'Battle Master Deck Tera Charizard ex'), 'Scarlet & Violet');
  assert.equal(desk('pokemon-tcg-classic-charizard-and-ho-oh-ex-deck', 'Pokémon TCG Classic: Charizard & Ho-Oh ex Deck'), 'Scarlet & Violet');

  assert.equal(desk('mega-dream-ex', 'MEGA Dream ex'), 'Mega Evolution');
  assert.equal(desk('mega-starter-set-eevee-ex', 'MEGA Starter Set Eevee ex'), 'Mega Evolution');
  assert.equal(desk('starter-set-mega-mega-gengar-ex', 'Starter Set MEGA Mega Gengar ex'), 'Mega Evolution');

  assert.equal(desk('mcharizard-ex-mega-battle-deck', 'MCharizard EX Mega Battle Deck'), 'XY');
  assert.equal(desk('zygarde-ex-perfect-battle-deck', 'Zygarde EX Perfect Battle Deck'), 'XY');
  assert.equal(desk('master-deck-build-box-ex', 'Master Deck Build Box EX'), 'Black & White');
  assert.equal(desk('m-master-deck-build-box-power-style', 'M Master Deck Build Box Power Style'), 'XY');
  assert.equal(desk('m-master-deck-build-box-speed-style', 'M Master Deck Build Box Speed Style'), 'XY');
  assert.equal(desk('golduck-break-palkia-ex-combo-deck', 'Golduck BREAK + Palkia EX Combo Deck'), 'XY');

  assert.equal(desk('reshiram-ex-battle-strength-deck', 'Reshiram EX Battle Strength Deck'), 'Black & White');
  assert.equal(desk('ex-battle-boost', 'EX Battle Boost'), 'Black & White');
  assert.equal(desk('blastoise-kyurem-ex-combo-deck', 'Blastoise + Kyurem EX Combo Deck'), 'Black & White');

  assert.equal(desk('pop-series-6', 'POP Series 6'), 'Diamond & Pearl');
  assert.equal(desk('pop-series-9', 'POP Series 9'), 'Platinum');
  assert.equal(desk('expedition-base-set', 'Expedition Base Set'), 'e-Card');
  assert.equal(desk('aquapolis', 'Aquapolis'), 'e-Card');
  assert.equal(desk('skyridge', 'Skyridge'), 'e-Card');
});

test('code wins over a misleading translated title', () => {
  assert.equal(
    tcgEra({ slug: 'csv8-brilliant-fantasy', name: 'CSV8: Brilliant Fantasy' }),
    'Scarlet & Violet',
  );
  assert.equal(
    tcgEra({ slug: 'cs3a-primordial-martial-arts-overgrowth', name: 'CS3a: Primordial Martial Arts - Overgrowth' }),
    'Sword & Shield',
  );
  assert.equal(matchTcgEra('CSM1a: Storming Emergence - Radiant'), 'Sun & Moon');
});

test('eras/platinum is the 2008–2009 block, not a title that contains Arceus', () => {
  const desk = (slug, name) => tcgEra({ slug, name, set: name });
  assert.equal(desk('arceus', 'Arceus'), 'Platinum');
  assert.equal(desk('advent-of-arceus', 'Advent of Arceus'), 'Platinum');
  assert.equal(desk('galactic-s-conquest', "Galactic's Conquest"), 'Platinum');
  assert.equal(desk('charizard-sp-half-deck', 'Charizard SP Half Deck'), 'Platinum');
  assert.equal(
    desk(
      'csma-arceus-and-dialga-and-palkia-gx-advanced-deck-building-gift-box',
      'CSMA: Arceus & Dialga & Palkia-GX Advanced Deck Building Gift Box',
    ),
    'Sun & Moon',
  );
  assert.equal(
    desk(
      'arceus-and-dialga-and-palkia-gx-figure-collection',
      'Arceus & Dialga & Palkia-GX Figure Collection',
    ),
    'Sun & Moon',
  );
});
