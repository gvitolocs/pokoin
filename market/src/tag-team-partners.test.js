import assert from 'node:assert/strict';
import test from 'node:test';
import { pokedexPartnerNumbers } from './pokedex.js';
import { tagTeamKey, tagTeamPartners } from './tag-team-partners.js';

const TAG_TEAMS = [
  ['Arceus & Dialga & Palkia GX', [493, 483, 484]],
  ['Blastoise & Piplup GX', [9, 393]],
  ['Celebi & Venusaur GX', [251, 3]],
  ['Charizard & Braixen GX', [6, 654]],
  ['Eevee & Snorlax GX', [133, 143]],
  ['Espeon & Deoxys GX', [196, 386]],
  ['Garchomp & Giratina GX', [445, 487]],
  ['Gardevoir & Sylveon GX', [282, 700]],
  ['Gengar & Mimikyu GX', [94, 778]],
  ['Greninja & Zoroark GX', [658, 571]],
  ['Latias & Latios GX', [380, 381]],
  ['Lucario & Melmetal GX', [448, 809]],
  ['Lucario & MelmetalTag Team GX', [448, 809]],
  ['Magikarp & Wailord GX', [129, 321]],
  ['Marshadow & Machamp GX', [802, 68]],
  ['Mega Lopunny & Jigglypuff GX', [428, 39]],
  ['Mega Lopunny & Jigglypuff Tag Team GX', [428, 39]],
  ['Mega Sableye & Tyranitar GX', [302, 248]],
  ['Mewtwo & Mew GX', [150, 151]],
  ['Moltres & Zapdos & Articuno GX', [146, 145, 144]],
  ['Muk & Alolan Muk GX', [89]],
  ['Naganadel & Guzzlord GX', [804, 799]],
  ['Pheromosa & Buzzwole GX', [795, 794]],
  ['Pikachu & Zekrom GX', [25, 644]],
  ['Pikachu & Zekrom-GX', [25, 644]],
  ['Raichu & Alolan Raichu GX', [26]],
  ['Reshiram & Charizard GX', [643, 6]],
  ['Reshiram & Charizard Tag Team GX', [643, 6]],
  ['Reshiram & Zekrom GX', [643, 644]],
  ['Rowlet & Alolan Exeggutor GX', [722, 103]],
  ['Rowlet & Alolan exeggutor GX', [722, 103]],
  ['Slowpoke & Psyduck GX', [79, 54]],
  ['Solgaleo & Lunala GX', [791, 792]],
  ['Togepi & Cleffa & Igglybuff GX', [175, 173, 174]],
  ['Trevenant & Dusknoir GX', [709, 477]],
  ['Umbreon & Darkrai GX', [197, 491]],
  ['Venusaur & Snivy GX', [3, 495]],
];

test('every Tag Team GX leftover has a hand-listed partner Dex', () => {
  for (const [name, nums] of TAG_TEAMS) {
    assert.deepEqual(tagTeamPartners(name), nums, name);
    assert.deepEqual(pokedexPartnerNumbers(name), [...new Set(nums)], name);
  }
});

test('LEGEND pairs, trainers, and sealed SKUs are not Tag Team clones', () => {
  for (const name of [
    'Palkia & Dialga LEGEND',
    'Tate & Liza GX',
    'Charizard & Braixen Coin (TAG TEAM Generations Collection)',
    'League Battle Decks: Pikachu & Zekrom GX',
    'Tag Team Tins: Eevee & Snorlax GX Tin',
    'Sun & Moon GX Starter Set',
  ]) {
    assert.equal(tagTeamPartners(name), null, name);
    assert.ok(tagTeamKey(name));
  }
});
