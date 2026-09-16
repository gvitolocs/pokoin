import { collectorSplit } from './card-versions.js';
import { printingIdentity } from './identity.js';

/**
 * Pokémon TCG Celebrations (SWSH, 2021). Official checklist:
 * https://assets.pokemon.com/assets/cms2/pdf/trading-card-game/checklist/25th_web_cardlist_en.pdf
 * Main 001/025–025/025, then Classic Collection in that PDF order (not the vintage number).
 */
const CELEBRATIONS = [
  { name: 'Ho-Oh', number: '001/025' },
  { name: 'Reshiram', number: '002/025' },
  { name: 'Kyogre', number: '003/025' },
  { name: 'Palkia', number: '004/025' },
  { name: 'Pikachu', number: '005/025' },
  { name: 'Flying Pikachu V', number: '006/025' },
  { name: 'Flying Pikachu VMAX', number: '007/025' },
  { name: 'Surfing Pikachu V', number: '008/025' },
  { name: 'Surfing Pikachu VMAX', number: '009/025' },
  { name: 'Zekrom', number: '010/025' },
  { name: 'Mew', number: '011/025' },
  { name: 'Xerneas', number: '012/025' },
  { name: 'Cosmog', number: '013/025' },
  { name: 'Cosmoem', number: '014/025' },
  { name: 'Lunala', number: '015/025' },
  { name: 'Zacian V', number: '016/025' },
  { name: 'Groudon', number: '017/025' },
  { name: 'Zamazenta V', number: '018/025' },
  { name: 'Yveltal', number: '019/025' },
  { name: 'Dialga', number: '020/025' },
  { name: 'Solgaleo', number: '021/025' },
  { name: 'Lugia', number: '022/025' },
  { name: "Professor's Research", number: '023/025' },
  { name: "Professor's Research", number: '024/025' },
  { name: 'Mew', number: '025/025' },
  { name: 'Blastoise', number: '2/102' },
  { name: 'Charizard', number: '4/102' },
  { name: 'Venusaur', number: '15/102' },
  { name: 'Imposter Professor Oak', number: '73/102' },
  { name: 'Dark Gyarados', number: '8/82' },
  { name: 'Here Comes Team Rocket!', number: '15/82' },
  { name: "Rocket's Zapdos", number: '15/132' },
  { name: "_____'s Pikachu", number: '24' },
  { name: 'Cleffa', number: '20/111' },
  { name: 'Shining Magikarp', number: '66/64' },
  { name: "Team Magma's Groudon", number: '9/95' },
  { name: "Rocket's Admin.", number: '86/109' },
  { name: 'Mew ex', number: '88/92' },
  { name: 'Gardevoir ex δ', number: '93/101' },
  { name: 'Umbreon ★', number: '17/17' },
  { name: 'Claydol', number: '15/106' },
  { name: 'Luxray GL LV.X', number: '109/111' },
  { name: 'Garchomp C LV.X', number: '145/147' },
  { name: 'Donphan', number: '107/123' },
  { name: 'Reshiram', number: '113/114' },
  { name: 'Zekrom', number: '114/114' },
  { name: 'Mewtwo-EX', number: '54/99' },
  { name: 'Xerneas-EX', number: '97/146' },
  { name: 'M Rayquaza-EX', number: '76/108' },
  { name: 'Tapu Lele-GX', number: '60/145' },
];

/**
 * Pokémon TCG Lost Origin (SWSH11, 2022). Official English order:
 * https://assets.pokemon.com/assets/cms2/pdf/trading-card-game/checklist/swsh11_web_cardlist_en.pdf
 * PDF is 001/196–196/196. Secrets 197/196–217/196 and Trainer Gallery TG01–TG30
 * complete the English set. Reverse holos and stamp promos are not extra slots.
 */
const LOST_ORIGIN = [
  { name: "Oddish", number: '001/196' },
  { name: "Gloom", number: '002/196' },
  { name: "Vileplume", number: '003/196' },
  { name: "Paras", number: '004/196' },
  { name: "Parasect", number: '005/196' },
  { name: "Wurmple", number: '006/196' },
  { name: "Silcoon", number: '007/196' },
  { name: "Beautifly", number: '008/196' },
  { name: "Cascoon", number: '009/196' },
  { name: "Dustox", number: '010/196' },
  { name: "Seedot", number: '011/196' },
  { name: "Nuzleaf", number: '012/196' },
  { name: "Shiftry", number: '013/196' },
  { name: "Roselia", number: '014/196' },
  { name: "Roserade", number: '015/196' },
  { name: "Phantump", number: '016/196' },
  { name: "Trevenant", number: '017/196' },
  { name: "Blipbug", number: '018/196' },
  { name: "Dottler", number: '019/196' },
  { name: "Orbeetle", number: '020/196' },
  { name: "Slugma", number: '021/196' },
  { name: "Magcargo", number: '022/196' },
  { name: "Torkoal", number: '023/196' },
  { name: "Litwick", number: '024/196' },
  { name: "Lampent", number: '025/196' },
  { name: "Chandelure", number: '026/196' },
  { name: "Delphox V", number: '027/196' },
  { name: "Litleo", number: '028/196' },
  { name: "Pyroar", number: '029/196' },
  { name: "Poliwag", number: '030/196' },
  { name: "Poliwhirl", number: '031/196' },
  { name: "Politoed", number: '032/196' },
  { name: "Seel", number: '033/196' },
  { name: "Dewgong", number: '034/196' },
  { name: "Horsea", number: '035/196' },
  { name: "Seadra", number: '036/196' },
  { name: "Kingdra", number: '037/196' },
  { name: "Luvdisc", number: '038/196' },
  { name: "Shellos", number: '039/196' },
  { name: "Finneon", number: '040/196' },
  { name: "Lumineon", number: '041/196' },
  { name: "Snover", number: '042/196' },
  { name: "Abomasnow", number: '043/196' },
  { name: "Hisuian Basculin", number: '044/196' },
  { name: "Hisuian Basculegion", number: '045/196' },
  { name: "Ducklett", number: '046/196' },
  { name: "Swanna", number: '047/196' },
  { name: "Kyurem V", number: '048/196' },
  { name: "Kyurem VMAX", number: '049/196' },
  { name: "Cramorant", number: '050/196' },
  { name: "Glastrier", number: '051/196' },
  { name: "Pikachu", number: '052/196' },
  { name: "Raichu", number: '053/196' },
  { name: "Electrike", number: '054/196' },
  { name: "Manectric", number: '055/196' },
  { name: "Magnezone V", number: '056/196' },
  { name: "Magnezone VSTAR", number: '057/196' },
  { name: "Rotom V", number: '058/196' },
  { name: "Tynamo", number: '059/196' },
  { name: "Eelektrik", number: '060/196' },
  { name: "Eelektross", number: '061/196' },
  { name: "Clefairy", number: '062/196' },
  { name: "Clefable", number: '063/196' },
  { name: "Gastly", number: '064/196' },
  { name: "Haunter", number: '065/196' },
  { name: "Gengar", number: '066/196' },
  { name: "Mr. Mime", number: '067/196' },
  { name: "Jynx", number: '068/196' },
  { name: "Radiant Gardevoir", number: '069/196' },
  { name: "Sableye", number: '070/196' },
  { name: "Mawile", number: '071/196' },
  { name: "Shuppet", number: '072/196' },
  { name: "Banette", number: '073/196' },
  { name: "Cresselia", number: '074/196' },
  { name: "Hisuian Zorua", number: '075/196' },
  { name: "Hisuian Zoroark", number: '076/196' },
  { name: "Inkay", number: '077/196' },
  { name: "Malamar", number: '078/196' },
  { name: "Comfey", number: '079/196' },
  { name: "Mimikyu", number: '080/196' },
  { name: "Spectrier", number: '081/196' },
  { name: "Enamorus V", number: '082/196' },
  { name: "Hisuian Growlithe", number: '083/196' },
  { name: "Hisuian Arcanine", number: '084/196' },
  { name: "Poliwrath", number: '085/196' },
  { name: "Machop", number: '086/196' },
  { name: "Machoke", number: '087/196' },
  { name: "Machamp", number: '088/196' },
  { name: "Rhyhorn", number: '089/196' },
  { name: "Rhydon", number: '090/196' },
  { name: "Rhyperior", number: '091/196' },
  { name: "Aerodactyl V", number: '092/196' },
  { name: "Aerodactyl VSTAR", number: '093/196' },
  { name: "Sudowoodo", number: '094/196' },
  { name: "Gligar", number: '095/196' },
  { name: "Gliscor", number: '096/196' },
  { name: "Makuhita", number: '097/196' },
  { name: "Hariyama", number: '098/196' },
  { name: "Meditite", number: '099/196' },
  { name: "Medicham", number: '100/196' },
  { name: "Relicanth", number: '101/196' },
  { name: "Gastrodon", number: '102/196' },
  { name: "Mienfoo", number: '103/196' },
  { name: "Mienshao", number: '104/196' },
  { name: "Landorus", number: '105/196' },
  { name: "Binacle", number: '106/196' },
  { name: "Barbaracle", number: '107/196' },
  { name: "Carbink", number: '108/196' },
  { name: "Rockruff", number: '109/196' },
  { name: "Falinks", number: '110/196' },
  { name: "Stonjourner", number: '111/196' },
  { name: "Spinarak", number: '112/196' },
  { name: "Ariados", number: '113/196' },
  { name: "Murkrow", number: '114/196' },
  { name: "Honchkrow", number: '115/196' },
  { name: "Seviper", number: '116/196' },
  { name: "Spiritomb", number: '117/196' },
  { name: "Drapion V", number: '118/196' },
  { name: "Drapion VSTAR", number: '119/196' },
  { name: "Darkrai", number: '120/196' },
  { name: "Inkay", number: '121/196' },
  { name: "Hoopa", number: '122/196' },
  { name: "Radiant Hisuian Sneasler", number: '123/196' },
  { name: "Radiant Steelix", number: '124/196' },
  { name: "Bronzor", number: '125/196' },
  { name: "Bronzong", number: '126/196' },
  { name: "Galarian Stunfisk", number: '127/196' },
  { name: "Magearna", number: '128/196' },
  { name: "Galarian Perrserker V", number: '129/196' },
  { name: "Giratina V", number: '130/196' },
  { name: "Giratina VSTAR", number: '131/196' },
  { name: "Goomy", number: '132/196' },
  { name: "Hisuian Sliggoo", number: '133/196' },
  { name: "Hisuian Goodra", number: '134/196' },
  { name: "Hisuian Goodra V", number: '135/196' },
  { name: "Hisuian Goodra VSTAR", number: '136/196' },
  { name: "Pidgeot V", number: '137/196' },
  { name: "Lickitung", number: '138/196' },
  { name: "Lickilicky", number: '139/196' },
  { name: "Porygon", number: '140/196' },
  { name: "Porygon2", number: '141/196' },
  { name: "Porygon-Z", number: '142/196' },
  { name: "Snorlax", number: '143/196' },
  { name: "Aipom", number: '144/196' },
  { name: "Ambipom", number: '145/196' },
  { name: "Hisuian Zoroark V", number: '146/196' },
  { name: "Hisuian Zoroark VSTAR", number: '147/196' },
  { name: "Bouffalant", number: '148/196' },
  { name: "Komala", number: '149/196' },
  { name: "Skwovet", number: '150/196' },
  { name: "Greedent", number: '151/196' },
  { name: "Arc Phone", number: '152/196' },
  { name: "Arezu", number: '153/196' },
  { name: "Box of Disaster", number: '154/196' },
  { name: "Colress's Experiment", number: '155/196' },
  { name: "Damage Pump", number: '156/196' },
  { name: "Fantina", number: '157/196' },
  { name: "Iscan", number: '158/196' },
  { name: "Lady", number: '159/196' },
  { name: "Lake Acuity", number: '160/196' },
  { name: "Lost City", number: '161/196' },
  { name: "Lost Vacuum", number: '162/196' },
  { name: "Mirage Gate", number: '163/196' },
  { name: "Miss Fortune Sisters", number: '164/196' },
  { name: "Panic Mask", number: '165/196' },
  { name: "Riley", number: '166/196' },
  { name: "Thorton", number: '167/196' },
  { name: "Tool Box", number: '168/196' },
  { name: "Volo", number: '169/196' },
  { name: "Windup Arm", number: '170/196' },
  { name: "Gift Energy", number: '171/196' },
  { name: "Hisuian Electrode V", number: '172/196' },
  { name: "Delphox V", number: '173/196' },
  { name: "Kyurem V", number: '174/196' },
  { name: "Magnezone V", number: '175/196' },
  { name: "Rotom V", number: '176/196' },
  { name: "Rotom V", number: '177/196' },
  { name: "Enamorus V", number: '178/196' },
  { name: "Aerodactyl V", number: '179/196' },
  { name: "Aerodactyl V", number: '180/196' },
  { name: "Gallade V", number: '181/196' },
  { name: "Drapion V", number: '182/196' },
  { name: "Galarian Perrserker V", number: '183/196' },
  { name: "Galarian Perrserker V", number: '184/196' },
  { name: "Giratina V", number: '185/196' },
  { name: "Giratina V", number: '186/196' },
  { name: "Hisuian Goodra V", number: '187/196' },
  { name: "Pidgeot V", number: '188/196' },
  { name: "Arezu", number: '189/196' },
  { name: "Colress's Experiment", number: '190/196' },
  { name: "Fantina", number: '191/196' },
  { name: "Iscan", number: '192/196' },
  { name: "Lady", number: '193/196' },
  { name: "Miss Fortune Sisters", number: '194/196' },
  { name: "Thorton", number: '195/196' },
  { name: "Volo", number: '196/196' },
  { name: "Kyurem VMAX", number: '197/196' },
  { name: "Magnezone VSTAR", number: '198/196' },
  { name: "Aerodactyl VSTAR", number: '199/196' },
  { name: "Drapion VSTAR", number: '200/196' },
  { name: "Giratina VSTAR", number: '201/196' },
  { name: "Hisuian Goodra VSTAR", number: '202/196' },
  { name: "Hisuian Zoroark VSTAR", number: '203/196' },
  { name: "Arezu", number: '204/196' },
  { name: "Colress's Experiment", number: '205/196' },
  { name: "Fantina", number: '206/196' },
  { name: "Iscan", number: '207/196' },
  { name: "Lady", number: '208/196' },
  { name: "Miss Fortune Sisters", number: '209/196' },
  { name: "Thorton", number: '210/196' },
  { name: "Volo", number: '211/196' },
  { name: "Giratina VSTAR", number: '212/196' },
  { name: "Hisuian Zoroark VSTAR", number: '213/196' },
  { name: "Box of Disaster", number: '214/196' },
  { name: "Collapsed Stadium", number: '215/196' },
  { name: "Dark Patch", number: '216/196' },
  { name: "Lost Vacuum", number: '217/196' },
  { name: "Parasect", number: 'TG01/TG30' },
  { name: "Roserade", number: 'TG02/TG30' },
  { name: "Charizard", number: 'TG03/TG30' },
  { name: "Chandelure", number: 'TG04/TG30' },
  { name: "Pikachu", number: 'TG05/TG30' },
  { name: "Gengar", number: 'TG06/TG30' },
  { name: "Banette", number: 'TG07/TG30' },
  { name: "Hisuian Arcanine", number: 'TG08/TG30' },
  { name: "Spiritomb", number: 'TG09/TG30' },
  { name: "Snorlax", number: 'TG10/TG30' },
  { name: "Castform", number: 'TG11/TG30' },
  { name: "Orbeetle V", number: 'TG12/TG30' },
  { name: "Orbeetle VMAX", number: 'TG13/TG30' },
  { name: "Centiskorch V", number: 'TG14/TG30' },
  { name: "Centiskorch VMAX", number: 'TG15/TG30' },
  { name: "Pikachu V", number: 'TG16/TG30' },
  { name: "Pikachu VMAX", number: 'TG17/TG30' },
  { name: "Enamorus V", number: 'TG18/TG30' },
  { name: "Gallade V", number: 'TG19/TG30' },
  { name: "Crobat V", number: 'TG20/TG30' },
  { name: "Eternatus V", number: 'TG21/TG30' },
  { name: "Eternatus VMAX", number: 'TG22/TG30' },
  { name: "Adventurer's Discovery", number: 'TG23/TG30' },
  { name: "Boss's Orders", number: 'TG24/TG30' },
  { name: "Cook", number: 'TG25/TG30' },
  { name: "Kabu", number: 'TG26/TG30' },
  { name: "Nessa", number: 'TG27/TG30' },
  { name: "Opal", number: 'TG28/TG30' },
  { name: "Pikachu VMAX", number: 'TG29/TG30' },
  { name: "Mew VMAX", number: 'TG30/TG30' },
];

/**
 * Pokémon TCG Platinum—Arceus (PL4, 2009). Official English checklist:
 * https://assets.pokemon.com/assets/cms2/pdf/trading-card-game/checklist/pl4_web_cardlist_en.pdf
 * Printed n/m is 1/99–99/99 (not 99/111). Secrets are AR1–AR9 then SH10–SH12.
 */
const PLATINUM_ARCEUS = [
  ['Charizard', '1/99'],
  ['Froslass', '2/99'],
  ['Heatran', '3/99'],
  ['Kabutops', '4/99'],
  ['Luxray', '5/99'],
  ['Mothim', '6/99'],
  ['Probopass', '7/99'],
  ['Salamence', '8/99'],
  ['Swalot', '9/99'],
  ['Tangrowth', '10/99'],
  ['Toxicroak', '11/99'],
  ['Zapdos G', '12/99'],
  ['Aerodactyl', '13/99'],
  ['Bronzong', '14/99'],
  ['Cherrim', '15/99'],
  ['Gengar', '16/99'],
  ['Gengar', '17/99'],
  ['Glalie', '18/99'],
  ['Golem', '19/99'],
  ['Hariyama', '20/99'],
  ['Lopunny', '21/99'],
  ['Manectric', '22/99'],
  ['Omastar', '23/99'],
  ['Pelipper', '24/99'],
  ['Pichu', '25/99'],
  ['Porygon-Z G', '26/99'],
  ['Raichu', '27/99'],
  ['Rapidash', '28/99'],
  ['Raticate', '29/99'],
  ['Sceptile', '30/99'],
  ['Sceptile', '31/99'],
  ['Spiritomb', '32/99'],
  ['Bronzong', '33/99'],
  ['Bronzor', '34/99'],
  ['Charmeleon', '35/99'],
  ['Gastly', '36/99'],
  ['Graveler', '37/99'],
  ['Grovyle', '38/99'],
  ['Grovyle', '39/99'],
  ['Gulpin', '40/99'],
  ['Haunter', '41/99'],
  ['Haunter', '42/99'],
  ['Luxio', '43/99'],
  ['Manectric', '44/99'],
  ['Pelipper', '45/99'],
  ['Ponyta', '46/99'],
  ['Rapidash', '47/99'],
  ['Shelgon', '48/99'],
  ['Wormadam Plant Cloak', '49/99'],
  ['Wormadam Sandy Cloak', '50/99'],
  ['Wormadam Trash Cloak', '51/99'],
  ['Bagon', '52/99'],
  ['Beedrill G', '53/99'],
  ['Bronzor', '54/99'],
  ['Buneary', '55/99'],
  ['Burmy Plant Cloak', '56/99'],
  ['Burmy Sandy Cloak', '57/99'],
  ['Burmy Trash Cloak', '58/99'],
  ['Charmander', '59/99'],
  ['Cherubi', '60/99'],
  ['Croagunk', '61/99'],
  ['Electrike', '62/99'],
  ['Electrike', '63/99'],
  ['Gastly', '64/99'],
  ['Geodude', '65/99'],
  ['Gulpin', '66/99'],
  ['Kabuto', '67/99'],
  ['Makuhita', '68/99'],
  ['Nosepass', '69/99'],
  ['Omanyte', '70/99'],
  ['Pikachu', '71/99'],
  ['Ponyta', '72/99'],
  ['Rattata', '73/99'],
  ['Shinx', '74/99'],
  ['Snorunt', '75/99'],
  ['Tangela', '76/99'],
  ['Tangela', '77/99'],
  ['Treecko', '78/99'],
  ['Treecko', '79/99'],
  ['Wingull', '80/99'],
  ['Wingull', '81/99'],
  ['Beginning Door', '82/99'],
  ['Bench Shield', '83/99'],
  ['Buffer Piece', '84/99'],
  ['Department Store Girl', '85/99'],
  ['Energy Restore', '86/99'],
  ['Expert Belt', '87/99'],
  ['Lucky Egg', '88/99'],
  ['Old Amber', '89/99'],
  ["Professor Oak's Visit", '90/99'],
  ['Ultimate Zone', '91/99'],
  ['Dome Fossil', '92/99'],
  ['Helix Fossil', '93/99'],
  ['Arceus LV.X', '94/99'],
  ['Arceus LV.X', '95/99'],
  ['Arceus LV.X', '96/99'],
  ['Gengar LV.X', '97/99'],
  ['Salamence LV.X', '98/99'],
  ['Tangrowth LV.X', '99/99'],
  ['Arceus', 'AR1'],
  ['Arceus', 'AR2'],
  ['Arceus', 'AR3'],
  ['Arceus', 'AR4'],
  ['Arceus', 'AR5'],
  ['Arceus', 'AR6'],
  ['Arceus', 'AR7'],
  ['Arceus', 'AR8'],
  ['Arceus', 'AR9'],
  ['Bagon', 'SH10'],
  ['Ponyta', 'SH11'],
  ['Shinx', 'SH12'],
].map(([name, number]) => ({ name, number }));

const OFFICIAL_SET_LISTS = {
  celebrations: CELEBRATIONS,
  'lost-origin': LOST_ORIGIN,
  'platinum-arceus': PLATINUM_ARCEUS,
};

export function setListKey(slug = '', name = '') {
  const raw = String(slug || name || '').trim().toLowerCase();
  return raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function officialListFor(slug, name) {
  return OFFICIAL_SET_LISTS[setListKey(slug, name)] || null;
}

export function hasOfficialSetList(slug, name) {
  return Boolean(officialListFor(slug, name));
}

export function defaultExpansionSort(slug, name) {
  return hasOfficialSetList(slug, name) ? 'official' : 'number';
}

/** Set desk waits for the full walk. Do not paint leftover-id page 1. */
export function expansionTilesReady(payload, _slug, _name) {
  if (!payload) {
    return false;
  }
  return payload.hasMore === false;
}

export function foldOfficialName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[★☆*]/g, ' star ')
    .replace(/[δ𝛿]/g, ' delta ')
    .replace(/delta\s+species/g, ' ')
    .replace(/professor'?s research\s*[-–—]?\s*professor oak/g, "professor's research")
    .replace(/boss'?s orders\s*[-–—]?\s*lysandre/g, "boss's orders")
    .replace(/[-–—]/g, ' ')
    .replace(/\blv\.?\s*(?:x|\d+)\b/g, ' ')
    .replace(/_+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameKeys(name) {
  const folded = foldOfficialName(name);
  const keys = new Set();
  if (folded) {
    keys.add(folded);
  }
  const stripped = folded.replace(/\s+(professor oak|lysandre)$/g, '').trim();
  if (stripped) {
    keys.add(stripped);
  }
  return keys;
}

function namesFit(cardName, entryName) {
  const a = nameKeys(cardName);
  const b = nameKeys(entryName);
  for (const key of a) {
    if (b.has(key)) {
      return true;
    }
  }
  return false;
}

function cardId(card) {
  return String(card?.id || card?.card_id || '');
}

function skipOfficialMatch(card) {
  return /\bpromo\b/i.test(printingIdentity(card).number);
}

export function usableOfficialNumber(card) {
  const split = collectorSplit(printingIdentity(card).number);
  if (!split || !Number.isFinite(split.n)) {
    return null;
  }
  if (split.d == null && split.n > 999) {
    return null;
  }
  return split;
}

function numberFits(cardSplit, entry) {
  const want = collectorSplit(entry.number);
  if (!want || !cardSplit) {
    return false;
  }
  if (cardSplit.n !== want.n) {
    return false;
  }
  if (cardSplit.d != null && want.d != null && cardSplit.d !== want.d) {
    return false;
  }
  return true;
}

export function assignOfficialIndexes(cards, list) {
  const assigned = new Map();
  if (!list?.length) {
    return assigned;
  }
  const remaining = list.map((entry, index) => ({ ...entry, index }));

  function take(card, entry) {
    const id = cardId(card);
    if (!id || assigned.has(id)) {
      return;
    }
    assigned.set(id, entry.index);
    const at = remaining.findIndex((row) => row === entry);
    if (at >= 0) {
      remaining.splice(at, 1);
    }
  }

  for (const card of cards || []) {
    const id = cardId(card);
    const split = usableOfficialNumber(card);
    if (!id || assigned.has(id) || !split || skipOfficialMatch(card)) {
      continue;
    }
    const hits = remaining.filter((entry) => namesFit(card.name, entry.name) && numberFits(split, entry));
    if (hits.length === 1) {
      take(card, hits[0]);
    }
  }

  for (const card of cards || []) {
    const id = cardId(card);
    if (!id || assigned.has(id) || usableOfficialNumber(card) || skipOfficialMatch(card)) {
      continue;
    }
    const hits = remaining.filter((entry) => namesFit(card.name, entry.name));
    if (hits.length) {
      take(card, hits[0]);
    }
  }

  return assigned;
}
