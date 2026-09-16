/**
 * Pokémon TCG blocks for versions grids (`tcgEra`) and set-index headings.
 * Japanese sets use the same era names as western; Chinese uses year ranges.
 * JP/EN/CN of the same generation stay together on `/versions`.
 * Do not 1:1 map reprint products onto a Japanese original.
 * Map: docs/TCG_ERAS.md
 */

export const TCG_ERA_ORDER = [
  'Mega Evolution',
  'Scarlet & Violet',
  'Sword & Shield',
  'Sun & Moon',
  'XY',
  'Black & White',
  'Call of Legends',
  'HeartGold & SoulSilver',
  'Platinum',
  'Diamond & Pearl',
  'EX',
  'e-Card',
  'Legendary Collection',
  'VS / web',
  'Neo',
  'Original',
];

/** Oldest TCG block first — artist Pokédex sort within a species. */
export const TCG_ERA_OLDEST_FIRST = [...TCG_ERA_ORDER].reverse();

/** One era: official EN / JP / CN expansions plus slug aliases. */
export const TCG_ERA_CATALOG = [
  {
    id: 'Mega Evolution',
    years: '2025–present',
    en: [
      'Mega Evolution', 'Phantasmal Flames', 'Ascended Heroes', 'Perfect Order',
      'Chaos Rising', 'Pitch Black', '30th Celebration', 'Delta Reign',
    ],
    jp: [
      'Mega Brave', 'Mega Symphonia', 'Inferno X', 'MEGA Dream ex', 'Nihil Zero',
      'Ninja Spinner', 'Abyss Eye', 'Storm Emeralda', '30th Celebration', 'Aura Seeker',
    ],
    cn: ['30th Celebration', 'M-P Promos'],
    extras: [
      'storm-emeralda', 'mega-dream', 'mep', 'mega-evolution-promo',
    ],
  },
  {
    id: 'Scarlet & Violet',
    years: '2023–2025',
    en: [
      'Scarlet & Violet', 'Paldea Evolved', 'Obsidian Flames', '151', 'Paradox Rift',
      'Paldean Fates', 'Temporal Forces', 'Twilight Masquerade', 'Shrouded Fable',
      'Stellar Crown', 'Surging Sparks', 'Prismatic Evolutions', 'Journey Together',
      'Destined Rivals', 'Black Bolt', 'White Flare',
    ],
    jp: [
      'Scarlet ex', 'Violet ex', 'Snow Hazard', 'Clay Burst', 'Ruler of the Black Flame',
      'Ancient Roar', 'Future Flash', 'Wild Force', 'Cyber Judge', 'Transformation Mask',
      'Stellar Miracle', 'Super Electric Breaker', 'Battle Partners',
      'Glory of the Rocket Gang', 'Black Bolt', 'White Flare',
      'Triplet Beat', 'Pokémon Card 151', 'Raging Surf', 'Crimson Haze', 'Night Wanderer',
      'Paradise Dragona', 'Hot Wind Arena', 'Shiny Treasure ex', 'Terastal Fest ex',
    ],
    cn: [
      'Gem Pack Vol. 1', 'Ancient Times, Future Progress', 'Collection 151: Journey',
      'Miracle Journey', 'Collection 151: Hope', 'Fearless Terastal', 'Gem Pack Vol. 2',
      'Journey Theme Pack', 'Bonus Round', 'Collection 151: Scare', 'Ardent Obsidian',
      'Gem Pack Vol. 3', 'Collection 151: Gather', 'Arcane Truth', 'Travel Theme Pack',
      'Blade Awakening', 'Gem Pack Vol. 4', 'Sparkling Fable', 'Gem Pack Vol. 5',
      'Stellar Crystal', 'Kitakami Theme Pack', 'Terastal Gathering',
      'Together in Pursuit of Glory', 'Gem Pack Vol. 6',
    ],
    extras: [
      '151', 'paldea', 'pokemon-card-151', 'collection-151', 'gem-pack', 'terastal-fest',
      'shiny-treasure', 'glory-of-the-rocket-gang', 'sv-black-star', 'svp',
    ],
  },
  {
    id: 'Sword & Shield',
    years: '2019/2020–2023',
    en: [
      'Sword & Shield', 'Rebel Clash', 'Darkness Ablaze', "Champion's Path",
      'Vivid Voltage', 'Shining Fates', 'Battle Styles', 'Chilling Reign',
      'Evolving Skies', 'Celebrations', 'Fusion Strike', 'Brilliant Stars',
      'Astral Radiance', 'Pokémon GO', 'Lost Origin', 'Silver Tempest', 'Crown Zenith',
    ],
    jp: [
      'Sword', 'Shield', 'Rebellion Crash', 'Infinity Zone', 'Amazing Volt Tackle',
      'Single Strike Master', 'Rapid Strike Master', 'Silver Lance', 'Jet-Black Spirit',
      'Skyscraping Perfection', 'Blue Sky Stream', 'Fusion Arts', 'Star Birth',
      'Time Gazer', 'Space Juggler', 'Lost Abyss', 'Paradigm Trigger',
      'VMAX Rising', 'Explosive Walker', 'Legendary Heartbeat', 'Peerless Fighters',
      'Eevee Heroes', '25th Anniversary Collection', 'Battle Region', 'Dark Phantasma',
      'Pokémon GO', 'Incandescent Arcana', 'Shiny Star V', 'VMAX Climax', 'VSTAR Universe',
    ],
    cn: [
      'Dynamax Clash', 'Dynamax Clash Thunder', 'Dynamax Clash Flame', 'Dynamax Tactics',
      'Vivid Portrayals', 'Vivid Portrayals Obsidian', 'Vivid Portrayals Indigo',
      'Brilliant Counterattack', 'Primordial Arts', 'Primordial Arts Overgrow',
      'Primordial Arts Torrent', 'Scorching Skies', 'Polychromatic Gathering',
      'Polychromatic Gathering Friends', 'Polychromatic Gathering Origin',
      'Flame Dance of the End', 'Gallant Galaxy', 'Gallant Galaxy Charm',
      'Gallant Galaxy Brave', 'Overshadowed Radiance', 'Marine Shadow',
      'Marine Shadow Roar', 'Marine Shadow Banish', 'Victory Lodestar',
    ],
    extras: [
      'shining-fates', 'champions-path', 'champion-s-path', 'pokemon-go',
      'shiny-star-v', 'vmax-climax', 'vstar-universe', 'vmax-rising',
      'single-strike', 'rapid-strike', 'starter-set-v', 'vmax-starter',
      'lightning-starter', 'fire-starter-set-v', 'v-starter', 'swsh',
      'dynamax-clash', 'dynamax-tactics',
    ],
  },
  {
    id: 'Sun & Moon',
    years: '2016/2017–2019',
    en: [
      'Sun & Moon', 'Guardians Rising', 'Burning Shadows', 'Shining Legends',
      'Crimson Invasion', 'Ultra Prism', 'Forbidden Light', 'Celestial Storm',
      'Dragon Majesty', 'Lost Thunder', 'Team Up', 'Detective Pikachu',
      'Unbroken Bonds', 'Unified Minds', 'Hidden Fates', 'Cosmic Eclipse',
    ],
    jp: [
      'Collection Sun', 'Collection Moon', 'Islands Await You', 'Alolan Moonlight',
      'To Have Seen the Battle Rainbow', 'Darkness that Consumes Light',
      'Awakened Heroes', 'Ultradimensional Beasts', 'Ultra Sun', 'Ultra Moon',
      'Forbidden Light', 'Sky-Splitting Charisma', 'Super-Burst Impact', 'Tag Bolt',
      'Double Blaze', 'Miracle Twin', 'Alter Genesis',
      'Facing a New Trial', 'Shining Legends', 'Ultra Force', 'Dragon Storm',
      'Champion Road', 'Thunderclap Spark', 'Fairy Rise', 'Dark Order', 'Night Unison',
      'Full Metal Wall', 'GG End', 'Sky Legend', 'Remix Bout', 'Dream League',
      'GX Battle Boost', 'GX Ultra Shiny', 'TAG TEAM GX: Tag All Stars',
      'Great Detective Pikachu',
    ],
    cn: [
      'Storming Emergence', 'Storming Emergence Radiant', 'Storming Emergence Verdant',
      'Storming Emergence Abundant', 'Battle Elite', 'Shining Synergy',
      'Shining Synergy Shower', 'Shining Synergy Supreme', 'Shining Synergy Summon',
      'Striking Competition', 'Golden Energy',
    ],
    extras: [
      'hidden-fates', 'shining-legends', 'tag-all-stars', 'tag-team',
      'gx-battle-boost', 'gx-ultra-shiny', 'gx-starter', 'detective-pikachu',
      'collection-sun', 'collection-moon', 'storming-emergence', 'csm',
      'legendary-starter-set', 'trainer-battle-decks', 'eevee-gx-starter',
    ],
  },
  {
    id: 'XY',
    years: '2013–2016',
    en: [
      'Kalos Starter Set', 'XY', 'Flashfire', 'Furious Fists', 'Phantom Forces',
      'Primal Clash', 'Double Crisis', 'Roaring Skies', 'Ancient Origins',
      'BREAKthrough', 'BREAKpoint', 'Generations', 'Fates Collide', 'Steam Siege',
      'Evolutions',
    ],
    jp: [
      'Collection X', 'Collection Y', 'Wild Blaze', 'Rising Fist', 'Phantom Gate',
      'Gaia Volcano', 'Tidal Storm', 'Emerald Break', 'Bandit Ring',
      'Blue Shock', 'Red Flash', 'Rage of the Broken Heavens', 'Awakening Psychic King',
      'Fever-Burst Fighter', 'Cruel Traitor',
      'Magma Gang VS Aqua Gang: Double Crisis', 'Legendary Shine Collection',
      'PokéKyun Collection', 'Premium Champion Pack EX×M×BREAK',
      'Mythical & Legendary Dream Shine Collection',
      'Expansion Pack 20th Anniversary', 'THE BEST OF XY',
    ],
    cn: [],
    extras: [
      'kalos', 'flashfire', 'furious-fists', 'phantom-forces', 'primal-clash',
      'roaring-skies', 'ancient-origins', 'breakpoint', 'breakthrough',
      'fates-collide', 'steam-siege', 'double-crisis', 'pokekyun',
      'expansion-pack-20th', '20th-anniversary', 'best-of-xy',
      'collection-x', 'collection-y',
    ],
  },
  {
    id: 'Black & White',
    years: '2010/2011–2013',
    en: [
      'Black & White', 'Emerging Powers', 'Noble Victories', 'Next Destinies',
      'Dark Explorers', 'Dragons Exalted', 'Dragon Vault', 'Boundaries Crossed',
      'Plasma Storm', 'Plasma Freeze', 'Plasma Blast', 'Legendary Treasures',
    ],
    jp: [
      'Black Collection', 'White Collection', 'Red Collection', 'Psycho Drive',
      'Hail Blizzard', 'Dark Rush', 'Dragon Selection', 'Dragon Blast', 'Dragon Blade',
      'Freeze Bolt', 'Cold Flare', 'Plasma Gale', 'Spiral Force', 'Thunder Knuckle',
      'Megalo Cannon', 'Shiny Collection', 'EX Battle Boost',
    ],
    cn: [],
    extras: [
      'emerging-powers', 'noble-victories', 'next-destinies', 'dark-explorers',
      'dragons-exalted', 'dragon-vault', 'boundaries-crossed', 'legendary-treasures',
      'ex-battle-boost', 'plasma-storm', 'plasma-freeze', 'plasma-blast',
      'plasma-gale', 'bw-black-star',
    ],
  },
  {
    id: 'Call of Legends',
    years: '2011',
    en: ['Call of Legends'],
    jp: [],
    cn: [],
    extras: ['call-of-legends', 'col-promo'],
  },
  {
    id: 'HeartGold & SoulSilver',
    years: '2009/2010',
    en: [
      'HeartGold & SoulSilver', 'Unleashed', 'Undaunted', 'Triumphant',
    ],
    jp: [
      'HeartGold Collection', 'SoulSilver Collection', 'Reviving Legends',
      'Clash at the Summit', 'Lost Link',
    ],
    cn: [],
    extras: ['heartgold', 'soulsilver', 'lost-link', 'hgss', 'undaunted', 'triumphant'],
  },
  {
    id: 'Platinum',
    years: '2008/2009',
    en: ['Platinum', 'Rising Rivals', 'Supreme Victors', 'Arceus'],
    jp: [
      "Galactic's Conquest", 'Bonds to the End of Time', 'Beat of the Frontier',
      'Advent of Arceus',
    ],
    cn: [],
    extras: [
      'rising-rivals', 'supreme-victors', 'galactic-conquest',
      'bonds-to-the-end-of-time', 'beat-of-the-frontier', 'advent-of-arceus',
    ],
  },
  {
    id: 'Diamond & Pearl',
    years: '2006/2007–2008',
    en: [
      'Diamond & Pearl', 'Mysterious Treasures', 'Secret Wonders', 'Great Encounters',
      'Majestic Dawn', 'Legends Awakened', 'Stormfront',
    ],
    jp: [
      'Space-Time Creation: Diamond Collection', 'Pearl Collection',
      'Secret of the Lakes', 'Shining Darkness', 'Moonlit Pursuit', 'Dawn Dash',
      'Cry from the Mysterious', 'Temple of Anger', 'Intense Fight in the Destroyed Sky',
    ],
    cn: [],
    extras: [
      'mysterious-treasures', 'secret-wonders', 'great-encounters', 'majestic-dawn',
      'legends-awakened', 'stormfront', 'diamond-collection', 'pearl-collection',
      'secret-of-the-lakes', 'super-legend', 'dp-black-star', 'space-time-creation',
    ],
  },
  {
    id: 'EX',
    years: '2003–2007',
    en: [
      'EX Ruby & Sapphire', 'EX Sandstorm', 'EX Dragon', 'EX Team Magma vs Team Aqua',
      'EX Hidden Legends', 'EX FireRed & LeafGreen', 'EX Team Rocket Returns',
      'EX Deoxys', 'EX Emerald', 'EX Unseen Forces', 'EX Delta Species',
      'EX Legend Maker', 'EX Holon Phantoms', 'EX Crystal Guardians',
      'EX Dragon Frontiers', 'EX Power Keepers',
    ],
    jp: [
      'ADV Expansion Pack', 'Miracle of the Desert', 'Rulers of the Heavens',
      'Magma VS Aqua: Two Ambitions', 'Undone Seal',
      'Flight of Legends', 'Clash of the Blue Sky', 'Rocket Gang Strikes Back',
      'Golden Sky, Silvery Ocean', 'Mirage Forest', 'Holon Research Tower',
      'Holon Phantom', 'Miracle Crystal', 'Offense and Defense of the Furthest Ends',
      'World Champions Pack',
    ],
    cn: [],
    extras: [
      'ruby-and-sapphire', 'sandstorm', 'dragon-frontiers', 'hidden-legends',
      'firered', 'leafgreen', 'team-rocket-returns', 'rocket-returns',
      'delta-species', 'legend-maker', 'holon-phantoms', 'holon-phantom',
      'crystal-guardians', 'power-keepers', 'unseen-forces', 'adv-expansion',
      'undone-seal', 'holon-research', 'world-champions-pack',
      'rocket-gang-strikes-back', 'adv-promos', 'adv-promo',
    ],
  },
  {
    id: 'e-Card',
    years: '2001/2002–2003',
    en: ['Expedition Base Set', 'Aquapolis', 'Skyridge'],
    jp: [
      'Base Expansion Pack', 'The Town on No Map', 'Wind from the Sea',
      'Split Earth', 'Mysterious Mountains',
    ],
    cn: [],
    extras: [
      'expedition', 'aquapolis', 'skyridge', 'base-expansion-pack',
      'town-on-no-map', 'wind-from-the-sea', 'split-earth', 'mysterious-mountains',
      'e-card',
    ],
  },
  {
    id: 'Legendary Collection',
    years: '2002',
    en: ['Legendary Collection'],
    jp: [],
    cn: [],
    extras: [],
  },
  {
    id: 'VS / web',
    years: '2001–2002',
    en: [],
    jp: ['Pokémon Card VS', 'Pokémon Card web', 'Pokémon Card★VS', 'Pokémon Card★web'],
    cn: [],
    extras: ['pokemon-card-vs', 'pokemon-card-web', 'pokemon-vs', 'pokemon-web'],
  },
  {
    id: 'Neo',
    years: '2000–2002',
    en: ['Neo Genesis', 'Neo Discovery', 'Southern Islands', 'Neo Revelation', 'Neo Destiny'],
    jp: [
      'Gold, Silver, to a New World', 'Crossing the Ruins', 'Awakening Legends',
      'Darkness, and to Light', 'Southern Islands',
    ],
    cn: [],
    extras: [
      'neo-genesis', 'neo-discovery', 'neo-revelation', 'neo-destiny',
      'southern-islands', 'to-a-new-world', 'crossing-the-ruins',
      'awakening-legends', 'darkness-and-to-light',
    ],
  },
  {
    id: 'Original',
    years: '1996/1999–2000',
    en: [
      'Base Set', 'Jungle', 'Fossil', 'Base Set 2', 'Team Rocket',
      'Gym Heroes', 'Gym Challenge',
    ],
    jp: [
      'Expansion Pack', 'Pokémon Jungle', 'Mystery of the Fossils', 'Rocket Gang',
      "Leaders' Stadium", 'Challenge from the Darkness',
    ],
    cn: [],
    extras: [
      'base-set-2', 'base-set', 'team-rocket', 'gym-heroes', 'gym-challenge',
      'gym-booster', 'pokemon-jungle', 'mystery-of-the-fossils', 'leaders-stadium',
      'challenge-from-the-darkness', 'wizards', 'nintendo-black-star',
    ],
  },
];

/**
 * CardTrader spellings and product-cycle overrides. Not official set names.
 * 30th Anniversary First Partner is Mega Evolution by catalog era, not ME*.
 */
export const TCG_ERA_ALIASES = [
  ['Mega Evolution', [
    'MEGA Start Deck 100 Battle Collection',
    'MEGA Start Deck 100 Battle Collection CoroCoro Version',
    'MEGA Start Deck 100 Battle Collection Corociao Version',
    'MEGA Starter Set',
    'Starter Set MEGA',
    'Premium Trainer Box MEGA',
    '30th Anniversary Celebration First Partner Illustration Collection',
    '30th Anniversary Celebration',
  ]],
  ['Scarlet & Violet', [
    'Hot Wind Arena',
    'Heat Wave Arena',
    'Transformation Mask',
    'Mask of Change',
    'Collection Sheet Journey Partners',
    'Brilliant Fantasy',
    'Brilliant Illusions',
    'Eternal Birth',
    'Dark Crystal Blaze',
    'True Mystery',
    'Chasing Glory',
    'Battle Party Dream Together',
    'Land of Kitakami Special Pack',
    'Battle Academy 2024',
    'My First Battle',
    'Southeast Asia Gym Promos',
    'Battle Master Deck',
    'Generations Start Decks',
    'ex Start Decks',
    'ex Starter Set',
    'Starter Deck & Build Set',
    'Starter Set ex',
    'Stellar Tera Type Starter Set',
    'Terastal Festival',
    'Terastal Starter Set',
    'Pokémon TCG Classic',
    'Pokémon Card Game Classic',
    'Venusaur & Charizard & Blastoise Special Deck Set ex',
  ]],
  ['Sword & Shield', [
    'Explosive Walker',
    'Explosive Flame Walker',
    'Matchless Fighters',
    'Peerless Fighters',
    'Shocking Volt Tackle',
    'Amazing Volt Tackle',
    'Towering Perfection',
    'Skyscraping Perfection',
    '25th Anniversary Edition',
    '25th Anniversary Golden Box',
    'Primordial Martial Arts',
    'Nine Colors Gathering',
    'Brave Enchanting Stars',
    'Azure Shadow',
    'Return of the Dragon',
    'Dragon Resurgence',
    'Final Flame Dance',
    'Victory Star Guide',
    'Shadow of Glory',
    'Shadow of the Blue Sea',
    'Battle Academy 2020',
    'Battle Academy 2022',
    'First Partner Pack',
    'Futsal Promos',
    'Gengar VMAX High-Class Deck',
    'Inteleon VMAX High-Class Deck',
    'McDonald\'s Collection 25th Anniversary',
    'POKÉMON TRAINERS Off Shot',
    'Special Deck Set Zacian Zamazenta vs Eternatus',
    'Start Deck 100',
    'Start Deck 100 CoroCoro Comic Version',
    'V-UNION Special Card Sets',
    'V-UNION Special Collection',
    'VMAX Special Set',
    'Zacian + Zamazenta BOX',
    'Zacian Zamazenta BOX',
  ]],
  ['Sun & Moon', [
    'Extra Regulation Box',
    'Rockruff Full Power Deck',
    'Thailand & Indonesia Products',
    'Arceus & Dialga & Palkia-GX',
    'Arceus, Dialga & Palkia-GX',
  ]],
  ['XY', [
    'Premium Champion Pack',
    'Premium Champion Pack EX×M×BREAK',
    'Hyper Metal Chain Deck',
    'M Master Deck Build Box Power Style',
    'M Master Deck Build Box Speed Style',
    'Mega Battle Deck',
    'Noivern BREAK Evolution Pack',
    'Radiant Collection Generation',
    'Starter Pack',
    'Xerneas Half Deck',
    'Yveltal Half Deck',
    'Golduck BREAK',
    'Zygarde EX Perfect Battle Deck',
    'Emboar EX vs Togekiss EX Deck Kit',
  ]],
  ['Black & White', [
    'Battle Gift Set: Thundurus vs Tornadus',
    'Battle Strength Deck',
    'Battle Strength Decks',
    'Blastoise + Kyurem EX Combo Deck',
    'Battle Theme Deck: Victini',
    'Beginning Set',
    'Beginning Set Plus',
    'Everyone\'s Exciting Battle',
    'Garchomp Half Deck',
    'Hydreigon Half Deck',
    'Keldeo Battle Strength Deck',
    'National Pokédex Beginning Set',
    'Mewtwo vs Genesect Deck Kit',
    'Radiant Collection Legendary Treasure',
    'Master Deck Build Box EX',
  ]],
  ['HeartGold & SoulSilver', [
    'Blastoise Battle Starter Deck',
    'L-P Promo',
    'Leafeon Expert Deck',
    'Magmortar Battle Starter Deck',
    'Metagross Expert Deck',
    'Pikachu World Collection',
    'Raichu Battle Starter Deck',
    'Steelix Constructed Standard Deck',
    'Torterra Battle Starter Deck',
    'Tyranitar Constructed Standard Deck',
  ]],
  ['Platinum', [
    'Charizard SP Half Deck',
    'Gallade SP Half Deck',
    'Garchomp vs Charizard SP Deck Kit',
    'Infernape SP Half Deck',
    'Melee! Pokémon Scramble',
    'Mewtwo LV.X Collection Pack',
    'Movie Commemoration Random',
    'Pokémon Rumble',
    'Regigigas LV.X Collection',
    'Shaymin LV. X COLLECTION PACK',
  ]],
  ['Diamond & Pearl', [
    '10th Movie Commemoration Set',
    '11th Movie Commemoration Set',
    'Bastiodon the Defender',
    'Dialga Half Deck',
    'Dialga LV.X Constructed Standard Deck',
    'Entry Pack',
    'Entry Pack 08',
    'Giratina Half Deck',
    'Heatran vs Regigigas Deck Kit',
    'Magmortar vs Electivire Deck Kit',
    'Palkia LV.X Constructed Standard Deck',
    'PPP Promos',
    'Rampardos the Attacker',
  ]],
  ['EX', [
    'Aqua Deck Kit',
    'Black Deck Kit',
    "Earth's Groudon ex Constructed Starter Deck",
    'EX Battle Stadium',
    'EX Trainer Kit',
    'EX Trainer Kit 2',
    'EX Trainer Kit 2 (Minun)',
    'EX Trainer Kit 2 (Plusle)',
    'Imprison! Gardevoir ex Constructed Standard Deck',
    'Latias ex Half Deck',
    'Latios ex Half Deck',
    "Ocean's Kyogre ex Constructed Starter Deck",
    'Shockwave! Tyranitar ex Constructed Standard Deck',
    'Feraligatr Constructed Starter Deck',
    'Fighting Quick Construction Pack',
    'Fire Quick Construction Pack',
    'Flygon Constructed Starter Deck',
    'Gift Box Emerald Rayquaza Half Deck',
    'Gift Box Mew Lucario',
    'Grass Quick Construction Pack',
    'Lightning Quick Construction Pack',
    'Magma Deck Kit',
    'Master Kit',
    'Meganium Constructed Starter Deck',
    'Metagross Constructed Starter Deck',
    'Mirage\'s Mew Constructed Starter Deck',
    'Movie Commemoration VS Pack',
    'Mudkip Constructed Starter Deck',
    'PCG Promos',
    'PLAY Promos',
    'PokéPark Blue',
    'PokéPark Forest',
    'Psychic Quick Construction Pack',
    'Rayquaza Constructed Starter Deck',
    'Salamence Constructed Starter Deck',
    'Silver Deck Kit',
    'Torchic Constructed Starter Deck',
    'Treecko Constructed Starter Deck',
    'Typhlosion Constructed Starter Deck',
    'Venusaur, Charizard & Blastoise Random Constructed Starter Decks',
    'Water Quick Construction Pack',
  ]],
  ['e-Card', [
    'Best of Game',
    'Box Topper',
    'For Position Only',
    'McDonald\'s Pokémon-e Minimum Pack',
    'P Promos',
    'Pokémon-e Starter Deck',
    'T Promos',
  ]],
  ['VS / web', [
    'Theater Limited VS Pack',
  ]],
  ['Original', [
    'Expansion Sheet',
    "Gym Booster 1 Leaders' Stadium",
    'Gym Booster 2: Challenge from the Darkness',
    'Guren Town Gym',
    'Hanada City Gym',
    'Intro Pack Bulbasaur',
    'Intro Pack Squirtle',
    'Kuchiba City Gym',
    'Nivi City Gym',
    'Pokémon Misprints',
    'Quick Starter Gift Set 1998',
    'Tamamushi City Gym',
    'Yamabuki City Gym',
  ]],
];

export function eraHaystack(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/['’★☆✦✧✪⭐]/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function hasNeedle(hay, needle) {
  if (!needle) return false;
  if (hay === needle || hay.startsWith(`${needle}-`)) return true;
  // p-promos / t-promos must not match m-p-promos or ppp-promos.
  if (/^[a-z]-/.test(needle)) return false;
  if (hay.endsWith(`-${needle}`)) return true;
  return hay.includes(`-${needle}-`);
}

function needlesFrom(groups) {
  const rows = [];
  for (const [era, names] of groups) {
    for (const name of names) {
      const needle = eraHaystack(name);
      if (!needle || (needle.length < 3 && needle !== '151')) continue;
      rows.push({ needle, era, length: needle.length });
    }
  }
  rows.sort((a, b) => b.length - a.length || a.needle.localeCompare(b.needle));
  return rows;
}

function catalogNeedles() {
  return needlesFrom(TCG_ERA_CATALOG.map((era) => [era.id, [...era.en, ...era.jp, ...era.cn, ...(era.extras || [])]]));
}

const ALIAS_NEEDLES = needlesFrom(TCG_ERA_ALIASES);
const ERA_NEEDLES = catalogNeedles();

/**
 * Simplified Chinese codes. CSV before CS. Never `CS*` (that would eat CSV).
 * MEGA product names are aliases, not this ME* rule.
 * CSM* is Sun & Moon — CSMA gift boxes name Arceus in the title; that is not
 * the Platinum Arceus expansion (same class of leak as substring `ex`).
 */
export function eraFromChineseCode(hay) {
  const key = eraHaystack(hay);
  if (!key) return null;
  if (/^csv/.test(key) || /(?:^|-)csv(?:[a-z]|\d)/.test(key)) {
    return 'Scarlet & Violet';
  }
  if (/^me(?:\d|p)(?:-|$)/.test(key) || /^me-p(?:-|$)/.test(key)) {
    return 'Mega Evolution';
  }
  if (/^csm/.test(key) || /(?:^|-)csm(?:[a-z]|\d)/.test(key)) {
    return 'Sun & Moon';
  }
  if (
    /^cs[1-6]/.test(key)
    || /^csf(?:c)?(?:-|$)/.test(key)
    || /^csdc(?:-|$)/.test(key)
    || /^csgc(?:-|$)/.test(key)
    || /^csuc(?:-|$)/.test(key)
    || /^cshc(?:-|$)/.test(key)
    || /^csh(?:-|$)/.test(key)
  ) {
    return 'Sword & Shield';
  }
  return null;
}

function worldChampionshipEra(year) {
  if (year >= 2004 && year <= 2007) return 'EX';
  if (year === 2008) return 'Diamond & Pearl';
  if (year === 2009 || year === 2010) return 'HeartGold & SoulSilver';
  if (year >= 2011 && year <= 2013) return 'Black & White';
  if (year >= 2014 && year <= 2016) return 'XY';
  if (year >= 2017 && year <= 2019) return 'Sun & Moon';
  if (year >= 2022 && year <= 2023) return 'Sword & Shield';
  if (year >= 2024 && year <= 2026) return 'Scarlet & Violet';
  return null;
}

function mcdonaldCollectionEra(year) {
  if (year >= 2011 && year <= 2013) return 'Black & White';
  if (year >= 2014 && year <= 2016) return 'XY';
  if (year >= 2017 && year <= 2019) return 'Sun & Moon';
  return null;
}

function popSeriesEra(n) {
  if (n >= 1 && n <= 5) return 'EX';
  if (n >= 6 && n <= 8) return 'Diamond & Pearl';
  if (n === 9) return 'Platinum';
  return null;
}

/** WCD year, McDonald's Collection year, POP n, Trick or Trade. Yokohama 2023 is SV. */
export function eraFromDatedProduct(hay) {
  const key = eraHaystack(hay);
  if (!key) return null;
  if (/yokohama/.test(key)) return 'Scarlet & Violet';
  const wcd = key.match(/world-championship-decks-(\d{4})/);
  if (wcd) return worldChampionshipEra(Number(wcd[1]));
  const mcd = key.match(/mcdonald-s-collection-(\d{4})/);
  if (mcd) return mcdonaldCollectionEra(Number(mcd[1]));
  if (/mcdonald-s-match-battle-2022/.test(key)) return 'Sword & Shield';
  if (/mcdonald-s-match-battle-2023/.test(key)) return 'Scarlet & Violet';
  if (/mcdonald-s-dragon-discovery/.test(key)) return 'Scarlet & Violet';
  const pop = key.match(/(?:^|-)pop-series-(\d+)(?:-|$)/);
  if (pop) return popSeriesEra(Number(pop[1]));
  if (/trick-or-trade-202[34]/.test(key)) return 'Scarlet & Violet';
  if (/(?:^|-)trick-or-trade(?:-|$)/.test(key)) return 'Sword & Shield';
  return null;
}

/**
 * Code / promo lines that are not a main expansion title.
 * Hidden Fates is Sun & Moon. Dynamax Clash is CN Sword & Shield, not SV.
 * EX Battle Boost is BW. Never treat substring `ex` / `EX` as the EX block.
 * Official EN EX slugs are `ex-ruby-and-sapphire` etc. Paldea `ex Starter Set`,
 * XY Pokémon-EX decks, Mega Pokémon ex, and `foo-ex` + `Foo ex` haystacks
 * (`-ex-` from concatenating slug and name) stay off `/marketplace/eras/ex`.
 */
const TCG_ERA_FALLBACK = [
  ['Mega Evolution', /(^|-)mep-|(^|-)m-p-|storm-emeralda|nihil-zero|mega-brave|mega-symphonia|mega-dream|inferno-x|ninja-spinner|abyss-eye|aura-seeker/],
  ['Scarlet & Violet', /(^|-)sv\d|(^|-)sv-|black-bolt|white-flare|paldean-|paradox-rift|obsidian-flames|temporal-forces|twilight-masquerade|shrouded-fable|stellar-crown|surging-sparks|prismatic-evolutions|journey-together|destined-rivals|pokemon-card-151/],
  ['Sword & Shield', /(^|-)swsh-|(^|-)s\d{1,2}($|-)|shiny-star-v|vmax-climax|vstar-universe|vstar|starter-set-v|vmax-starter|single-strike|rapid-strike|dynamax-clash|pokemon-go/],
  ['Sun & Moon', /(^|-)sm\d|(^|-)sm-|(^|-)csm|hidden-fates|tag-team|gx-battle-boost|collection-sun|collection-moon|ultra-sun|ultra-moon/],
  ['XY', /(^|-)xy\d|(^|-)xy($|-)|flashfire|phantom-forces|evolutions|double-crisis|breakpoint|breakthrough/],
  ['Black & White', /(^|-)bw-|(^|-)bw\d|plasma-|legendary-treasures|dragon-vault|ex-battle-boost/],
  ['Call of Legends', /call-of-legends/],
  ['HeartGold & SoulSilver', /heartgold|soulsilver|lost-link|(^|-)hgss-|(^|-)hs-/],
  ['Platinum', /rising-rivals|supreme-victors|advent-of-arceus|galactic-conquest|(^|-)pl($|-)/],
  ['Diamond & Pearl', /mysterious-treasures|stormfront|super-legend|(^|-)dpt-|(^|-)dp-/],
  ['EX', /(^|-)ex-(ruby-and-sapphire|sandstorm|dragon|team-magma|team-rocket|hidden-legends|firered|deoxys|emerald|unseen-forces|delta-species|legend-maker|holon|crystal-guardians|power-keepers|trainer-kit|battle-stadium)|ruby-and-sapphire|holon|delta-species|legend-maker|power-keepers|firered|deoxys|unseen-forces|adv-expansion|adv-promo/],
  ['e-Card', /expedition|aquapolis|skyridge|e-card|split-earth|town-on-no-map/],
  ['Legendary Collection', /legendary-collection/],
  ['VS / web', /pokemon-card-vs|pokemon-card-web|pokemon-vs|pokemon-web/],
  ['Neo', /neo-genesis|neo-discovery|neo-revelation|neo-destiny|southern-islands|(^|-)neo-/],
  ['Original', /base-set|gym-heroes|gym-challenge|gym-booster|team-rocket|wizards|nintendo-black-star|(^|-)jungle($|-)|(^|-)fossil($|-)/],
];

export function matchTcgEra(key) {
  const hay = eraHaystack(key);
  if (!hay) return null;
  const coded = eraFromChineseCode(hay);
  if (coded) return coded;
  const dated = eraFromDatedProduct(hay);
  if (dated) return dated;
  for (const row of ALIAS_NEEDLES) {
    if (hasNeedle(hay, row.needle)) return row.era;
  }
  for (const row of ERA_NEEDLES) {
    if (hasNeedle(hay, row.needle)) return row.era;
  }
  for (const [era, pattern] of TCG_ERA_FALLBACK) {
    if (pattern.test(hay)) return era;
  }
  return null;
}

export function tcgEraYears(id) {
  return TCG_ERA_CATALOG.find((era) => era.id === id)?.years || '';
}

/** Lower is older. Era first, then official expansion order inside that block. */
export function expansionSortValue(card = {}) {
  const hay = eraHaystack(
    `${card.slug || ''} ${card.set || card.set_name || card.expansion_name || ''}`,
  );
  const era = matchTcgEra(hay) || 'Other';
  const eraRank = TCG_ERA_OLDEST_FIRST.indexOf(era);
  const eraIdx = eraRank < 0 ? TCG_ERA_OLDEST_FIRST.length : eraRank;
  const catalog = TCG_ERA_CATALOG.find((row) => row.id === era);
  let setIdx = 5000;
  let bestLen = 0;
  if (catalog && hay) {
    for (const names of [catalog.en, catalog.jp, catalog.cn]) {
      names.forEach((name, idx) => {
        const needle = eraHaystack(name);
        if (!needle || needle.length < bestLen) return;
        if (!hasNeedle(hay, needle) && hay !== needle && !hay.includes(needle)) return;
        bestLen = needle.length;
        setIdx = idx;
      });
    }
  }
  return eraIdx * 10000 + setIdx;
}
