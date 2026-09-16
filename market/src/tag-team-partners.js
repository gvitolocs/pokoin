/** SM Tag Team GX leftovers — National Dex for each partner, listed by hand.
 * Same-species Alolan pairs stay one slot. Sealed tins / LEGEND names are not here.
 */
export const TAG_TEAM_PARTNERS = {
  arceusdialgapalkia: [493, 483, 484],
  blastoisepiplup: [9, 393],
  celebivenusaur: [251, 3],
  charizardbraixen: [6, 654],
  eeveesnorlax: [133, 143],
  espeondeoxys: [196, 386],
  garchompgiratina: [445, 487],
  gardevoirsylveon: [282, 700],
  gengarmimikyu: [94, 778],
  greninjazoroark: [658, 571],
  latiaslatios: [380, 381],
  lucariomelmetal: [448, 809],
  magikarpwailord: [129, 321],
  marshadowmachamp: [802, 68],
  lopunnyjigglypuff: [428, 39],
  sableyetyranitar: [302, 248],
  mewtwomew: [150, 151],
  moltreszapdosarticuno: [146, 145, 144],
  mukalolanmuk: [89],
  naganadelguzzlord: [804, 799],
  pheromosabuzzwole: [795, 794],
  pikachuzekrom: [25, 644],
  raichualolanraichu: [26],
  reshiramcharizard: [643, 6],
  reshiramzekrom: [643, 644],
  rowletalolanexeggutor: [722, 103],
  slowpokepsyduck: [79, 54],
  solgaleolunala: [791, 792],
  togepicleffaigglybuff: [175, 173, 174],
  trevenantdusknoir: [709, 477],
  umbreondarkrai: [197, 491],
  venusaursnivy: [3, 495],
};

export function tagTeamKey(name) {
  return String(name || '')
    .replace(/\s*Tag Team GX\s*$/i, ' GX')
    .replace(/\b(?:tag\s*team\s*)?gx\b/gi, '')
    .replace(/\bmega\b/gi, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function tagTeamPartners(name) {
  const nums = TAG_TEAM_PARTNERS[tagTeamKey(name)];
  return nums ? [...nums] : null;
}
