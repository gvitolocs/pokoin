import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectorSplit,
  deskClipCandidates,
  deskSetShortcuts,
  deskShowMoreVersions,
  isRaritySibling,
  printLangBadge,
  mergePrintingRows,
  rarityStep,
  rarityVersions,
  inheritEraFromArtwork,
  isPromoExpansion,
  splitVersionPage,
  versionOptionLabel,
} from './card-versions.js';

const jpRegular = {
  id: '734318',
  name: 'Espurr',
  set: 'Nihil Zero',
  number: '032/080',
};
const jpIr = {
  id: '736062',
  name: 'Espurr',
  set: 'Nihil Zero',
  number: 'Illustration Rare | 087/080',
  rarity: 'Card',
};
const enIr = {
  id: '757880',
  name: 'Espurr',
  set: 'Perfect Order',
  number: 'Illustration Rare | 095/088',
};
const enRegular = {
  id: '757756',
  name: 'Espurr',
  set: 'Perfect Order',
  number: '033/088',
};
const cottoneeSky = {
  id: '236234',
  name: 'Cottonee',
  set: 'Emerging Powers',
  number: '010/098',
};
const cottoneeFlowers = {
  id: '236230',
  name: 'Cottonee',
  set: 'Emerging Powers',
  number: '009/098',
};
const cottoneeJp = {
  id: '271986',
  name: 'Cottonee',
  set: 'Black Collection',
  number: '004/053',
  nationality: 'japanese',
};
const pokeBall = {
  id: '781464',
  name: 'Espurr',
  set: 'CSV9: Poké Ball Reverse',
  number: 'CSV9C | Poké Ball Reverse | 088/208',
};

test('secret collector numbers are n greater than the printed total', () => {
  assert.equal(collectorSplit('087/080').secret, true);
  assert.equal(collectorSplit('032/080').secret, false);
  assert.equal(collectorSplit('010/098').secret, false);
});

test('promo expansions have no rarity lineup', () => {
  const adv = {
    id: '221400',
    name: 'Jirachi',
    set: 'ADV Promos',
    number: '014/ADV-P',
  };
  const cosmos = {
    id: '221402',
    name: 'Jirachi',
    set: 'ADV Promos',
    number: 'Cosmos Holo | 025/ADV-P',
    rarity: 'Cosmos Holo',
  };
  const svp = {
    id: '791000',
    name: 'Pikachu',
    set: 'SV Black Star Promos',
    number: '214',
  };
  assert.equal(isPromoExpansion(adv), true);
  assert.equal(isPromoExpansion(svp), true);
  assert.equal(isPromoExpansion(jpRegular), false);
  assert.equal(isRaritySibling(adv, cosmos), false);
  assert.deepEqual(rarityVersions(adv, [cosmos]).map((row) => row.id), ['221400']);
  const split = splitVersionPage({
    current: adv,
    nameRows: [adv, cosmos],
    artRows: [adv],
  });
  assert.deepEqual(split.versions.map((row) => row.id), ['221400']);
  assert.deepEqual(split.eras, []);
});

test('League Promos dump cards are not a rarity lineup', () => {
  const pxp = {
    id: '792992',
    name: 'Rayquaza',
    set: 'League Promos',
    number: '053/217 | PXP Stamp',
  };
  const gym = {
    id: '220100',
    name: 'Rayquaza',
    set: 'League Promos',
    number: 'Gym Challenge | 22/107',
  };
  assert.equal(isPromoExpansion(pxp), true);
  assert.equal(isRaritySibling(pxp, gym), false);
  const split = splitVersionPage({
    current: pxp,
    nameRows: [pxp, gym],
    artRows: [pxp],
  });
  assert.deepEqual(split.versions.map((row) => row.id), ['792992']);
  assert.deepEqual(split.eras, []);
});

test('Nihil Zero regular and illustration rare are versions of each other', () => {
  assert.equal(isRaritySibling(jpIr, jpRegular), true);
  assert.equal(isRaritySibling(jpIr, enIr), false);
  assert.equal(isRaritySibling(jpIr, pokeBall), false);
  assert.deepEqual(
    rarityVersions(jpIr, [jpRegular, enIr, enRegular, pokeBall]).map((row) => row.id),
    ['734318', '736062'],
  );
});

test('two in-set Cottonee arts in the same expansion are not versions', () => {
  assert.equal(isRaritySibling(cottoneeSky, cottoneeFlowers), false);
  assert.deepEqual(
    rarityVersions(cottoneeSky, [cottoneeFlowers, cottoneeJp]).map((row) => row.id),
    ['236234'],
  );
});

test('same-number reverse finish in the same set is a version', () => {
  const regular = { id: '1', name: 'Espurr', set: 'Surging Sparks', number: '084/191' };
  const reverse = {
    id: '2',
    name: 'Espurr',
    set: 'Surging Sparks',
    number: 'Poké Ball Reverse | 084/191',
  };
  assert.equal(isRaritySibling(regular, reverse), true);
});

test('desk shortcuts follow this illustration, not every rarity of the name', () => {
  const ur = {
    id: '739436',
    name: 'Blacephalon GX',
    set: 'CSM1.5: Battle Elite',
    number: 'Ultra Rare | 003/060',
  };
  const fa = {
    id: '739514',
    name: 'Blacephalon GX',
    set: 'CSM1.5: Battle Elite',
    number: 'Full-Art | 061/060',
  };
  const urArt = [
    { id: '286448', name: 'Blacephalon GX', set: 'Super-Burst Impact', number: 'Ultra Rare | 023/095' },
    { id: '515988', name: 'Blacephalon GX', set: 'Tag Team GX: Tag All Stars', number: 'Ultra Rare | 028/173' },
    { id: '244780', name: 'Blacephalon GX', set: 'Lost Thunder', number: 'Ultra Rare | 052/214' },
    { id: '631100', name: 'Blacephalon GX', set: 'World Championship Decks 2019', number: '052/214' },
    ur,
  ];
  const faArt = [
    { id: '286596', name: 'Blacephalon GX', set: 'Super-Burst Impact', number: 'Full-Art | 097/095' },
    { id: '245368', name: 'Blacephalon GX', set: 'Lost Thunder', number: 'Rainbow Secret Rare | 219/214' },
    fa,
  ];
  // Default order is the era catalog, newest block first — not "current set
  // first" — so a circle keeps its position when the seller clicks another.
  assert.deepEqual(
    deskSetShortcuts(ur, urArt).map((row) => row.set),
    [
      'World Championship Decks 2019',
      'Tag Team GX: Tag All Stars',
      'Super-Burst Impact',
      'Lost Thunder',
      'CSM1.5: Battle Elite',
    ],
  );
  assert.deepEqual(
    deskSetShortcuts(fa, faArt).map((row) => row.set),
    ['Super-Burst Impact', 'Lost Thunder', 'CSM1.5: Battle Elite'],
  );
});

test('CLIP Dialga reprints become four desk shortcuts, not the Dialga name dump', () => {
  const csdc = {
    id: '770422',
    name: 'Dialga',
    set: 'CSDC: Pikachu Legendary Celebration',
    number: 'CSDC | 007/024',
  };
  const clip = [
    { id: '342770', name: 'Dialga', set: '25th Anniversary Collection', number: '171385' },
    { id: '403516', name: 'Dialga', set: 'Celebrations', number: '201758' },
    { id: '756240', name: 'Dialga', set: 'CSVH2: Happy Combination Lucario & Greninja & Zamazenta & Mabosstiff', number: 'CSVH2 | 026/058' },
    csdc,
  ];
  assert.deepEqual(
    deskSetShortcuts(csdc, deskClipCandidates([], clip)).map((row) => row.id),
    ['756240', '770422', '342770', '403516'],
  );
  const nameDump = Array.from({ length: 20 }, (_, i) => ({
    id: String(800000 + i),
    name: 'Dialga',
    set: `Set ${i}`,
    number: '001/100',
  }));
  assert.deepEqual(deskSetShortcuts(csdc, nameDump), []);
  assert.deepEqual(
    deskSetShortcuts(csdc, deskClipCandidates([], clip)).length,
    4,
  );
});

test('few expansion reprints become desk set shortcuts; many do not', () => {
  const lost = { id: '245170', name: 'Ditto ◇ Prism Star', set: 'Lost Thunder', number: '154/214' };
  const stars = { id: '520098', name: 'Ditto ◇ Prism Star', set: 'Tag Team GX: Tag All Stars', number: '108/173' };
  const spark = { id: '586974', name: 'Ditto ◇ Prism Star', set: 'Thunderclap Spark', number: '043/060' };
  assert.deepEqual(
    deskSetShortcuts(lost, [stars, spark]).map((row) => row.set),
    ['Tag Team GX: Tag All Stars', 'Thunderclap Spark', 'Lost Thunder'],
  );
  assert.deepEqual(deskSetShortcuts(lost, []).map((row) => row.id), ['245170']);
  const four = Array.from({ length: 4 }, (_, i) => ({
    id: String(i + 1),
    name: 'Ditto ◇ Prism Star',
    set: `Set ${i}`,
    number: '001/100',
  }));
  assert.equal(deskSetShortcuts(lost, four).length, 5);
  const five = Array.from({ length: 5 }, (_, i) => ({
    id: String(i),
    name: 'Ditto ◇ Prism Star',
    set: `Set ${i}`,
    number: '001/100',
  }));
  assert.deepEqual(deskSetShortcuts(lost, five), []);
});

test('set circles keep More versions for rarity lineup and other artwork', () => {
  const rainbow = {
    id: '245368',
    name: 'Blacephalon GX',
    set: 'Lost Thunder',
    number: 'Rainbow Secret Rare | 219/214',
  };
  const ultra = {
    id: '244780',
    name: 'Blacephalon GX',
    set: 'Lost Thunder',
    number: 'Ultra Rare | 052/214',
  };
  const jpFa = {
    id: '286596',
    name: 'Blacephalon GX',
    set: 'Super-Burst Impact',
    number: 'Full-Art | 097/095',
  };
  const clip = [rainbow, jpFa];
  assert.equal(deskSetShortcuts(rainbow, clip).length, 2);
  assert.equal(deskShowMoreVersions(rainbow, { nameRows: [ultra], clipRows: clip }), true);
  assert.equal(
    deskShowMoreVersions(rainbow, { nameRows: [rainbow], clipRows: [rainbow], versionCount: 1 }),
    false,
  );
});

test('same-set rarities collapse to one shortcut, not two Mega Evolution circles', () => {
  const ur = { id: '703000', name: 'Mega Gardevoir ex', set: 'Mega Evolution', number: 'Ultra Rare | 060/132' };
  const fa = { id: '703002', name: 'Mega Gardevoir ex', set: 'Mega Evolution', number: 'Full-Art | 159/132' };
  const jp = { id: '689172', name: 'Mega Gardevoir ex', set: 'Mega Symphonia', number: 'Ultra Rare | 049/063' };
  assert.deepEqual(
    deskSetShortcuts(ur, [fa, jp]).map((row) => row.id),
    ['689172', '703000'],
  );
});

test('Lost Thunder star rare labels Rare, not Illustration Rare', () => {
  assert.equal(
    versionOptionLabel({
      id: '245040',
      name: 'Alolan Persian',
      set: 'Lost Thunder',
      number: 'Rare | 119/214',
      rarity: 'Card',
    }),
    'Rare 119/214',
  );
});

test('version select names the rarity, not the set pair', () => {
  assert.equal(versionOptionLabel(jpIr), 'Illustration Rare 087/080');
  assert.equal(versionOptionLabel(jpRegular), '032/080');
});

test('same artwork stays the CLIP group; versions stay the rarity pair', () => {
  const split = splitVersionPage({
    current: jpIr,
    nameRows: [jpRegular, enIr, cottoneeSky],
    artRows: [jpIr, enIr],
  });
  assert.deepEqual(split.versions.map((row) => row.id), ['734318', '736062']);
  assert.deepEqual(split.eras.map((group) => group.label), ['Mega Evolution']);
  assert.deepEqual(split.eras[0].rows.map((row) => row.id), ['736062', '757880']);
  assert.equal(printLangBadge(cottoneeJp), 'JP');
});

test('same-set regular and full-art are versions, not the same illustration', () => {
  const regular = {
    id: '798852',
    name: "Misty's Vitality",
    set: 'Pitch Black',
    number: '080/084',
  };
  const fullArt = {
    id: '798914',
    name: "Misty's Vitality",
    set: 'Pitch Black',
    number: 'Ultra Rare | 111/084',
    rarity: 'Ultra Rare',
  };
  assert.equal(isRaritySibling(regular, fullArt), true);
  const split = splitVersionPage({
    current: regular,
    nameRows: [regular, fullArt],
    artRows: [regular, fullArt],
  });
  assert.deepEqual(split.versions.map((row) => row.id), ['798852', '798914']);
  assert.deepEqual(split.eras, []);
});

test('Storm Emeralda Mega Rayquaza secrets share one rarity lineup', () => {
  const ur = {
    id: '806172',
    name: 'Mega Rayquaza ex',
    set: 'Storm Emeralda',
    number: 'Ultra Rare | 058/076',
  };
  const fa = {
    id: '806356',
    name: 'Mega Rayquaza ex',
    set: 'Storm Emeralda',
    number: 'Full-Art | 095/076',
  };
  const sir = {
    id: '806056',
    name: 'Mega Rayquaza ex',
    set: 'Storm Emeralda',
    number: 'Special Illustration Rare | 110/076',
  };
  const gold = {
    id: '806390',
    name: 'Mega Rayquaza ex',
    set: 'Storm Emeralda',
    number: 'Gold Secret Rare | 113/076',
  };
  const all = [ur, fa, sir, gold];
  assert.deepEqual(
    rarityVersions(fa, all).map((row) => row.id),
    ['806172', '806356', '806056', '806390'],
  );
  assert.deepEqual(
    rarityVersions(ur, all).map((row) => row.id),
    ['806172', '806356', '806056', '806390'],
  );
  const split = splitVersionPage({
    current: fa,
    nameRows: all,
    artRows: [fa],
  });
  assert.deepEqual(split.versions.map((row) => row.id), ['806172', '806356', '806056', '806390']);
  assert.deepEqual(split.eras, []);
  assert.equal(rarityStep(all, fa.id, 1).id, sir.id);
  assert.equal(rarityStep(all, gold.id, 1).id, ur.id);
  assert.equal(rarityStep(all, ur.id, -1).id, gold.id);
  assert.equal(rarityStep([fa], fa.id, 1), null);
  assert.deepEqual(
    mergePrintingRows([fa], [ur, fa, sir]).map((row) => row.id),
    ['806356', '806172', '806056'],
  );
});

test('mergePrintingRows keeps a listed PKN when a later sibling has none', () => {
  const bare = { id: '1', name: 'Mega Hawlucha ex' };
  const listed = { id: '1', name: 'Mega Hawlucha ex', price: 222 };
  assert.equal(mergePrintingRows([bare], [listed])[0].price, 222);
  assert.equal(mergePrintingRows([listed], [bare])[0].price, 222);
});

test('same-era full art stays with that era; other generations are separate', () => {
  const regular = {
    id: '741638',
    name: 'Air Balloon',
    set: 'Ascended Heroes',
    number: '181/217',
  };
  const megaFa = {
    id: '703348',
    name: 'Air Balloon',
    set: 'Mega Evolution',
    number: 'Ultra Rare | 166/132',
  };
  const sv = {
    id: '684690',
    name: 'Air Balloon',
    set: 'Black Bolt',
    number: '079/086',
  };
  const swsh = {
    id: '258812',
    name: 'Air Balloon',
    set: 'Sword & Shield',
    number: 'Secret Rare | 213/202',
  };
  const swshRegular = {
    id: '258636',
    name: 'Air Balloon',
    set: 'Sword & Shield',
    number: '156/202',
  };
  const jpSwsh = {
    id: '286774',
    name: 'Air Balloon',
    set: 'Sword',
    number: 'Ultra Rare | 75/060',
  };
  const jpSwshRegular = {
    id: '286738',
    name: 'Air Balloon',
    set: 'Sword',
    number: '57/060',
  };
  const split = splitVersionPage({
    current: regular,
    nameRows: [regular],
    artRows: [regular, megaFa, sv, swsh, swshRegular, jpSwsh, jpSwshRegular],
  });
  assert.deepEqual(split.eras.map((group) => [group.label, group.rows.map((row) => row.id)]), [
    ['Mega Evolution', ['741638', '703348']],
    ['Scarlet & Violet', ['684690']],
    ['Sword & Shield', ['258812', '258636', '286774', '286738']],
  ]);
});

test('JP Lightning Starter Marnie is Sword & Shield, not a reprint bucket', () => {
  const western = {
    id: '294450',
    name: 'Marnie',
    set: "Champion's Path",
    number: 'Holo Rare | 056/073',
  };
  const jpFa = {
    id: '643162',
    name: 'Marnie',
    set: 'Lightning Starter Set V',
    number: '024/023',
    nationality: 'japanese',
  };
  const split = splitVersionPage({
    current: western,
    nameRows: [western],
    artRows: [western, jpFa],
  });
  assert.deepEqual(split.eras.map((group) => [group.label, group.rows.map((row) => row.id)]), [
    ['Sword & Shield', ['294450', '643162']],
  ]);
});

test('League / theme-deck dumps inherit the CLIP artwork era', () => {
  const league = {
    id: '718416',
    name: 'Pikachu',
    set: 'League Promos',
    number: 'League Promo | 049/203',
  };
  const evolving = {
    id: '332574',
    name: 'Pikachu',
    set: 'Evolving Skies',
    number: '049/203',
  };
  const trick = {
    id: '448036',
    name: 'Pikachu',
    set: 'Trick or Trade',
    number: '049/203',
  };
  assert.equal(inheritEraFromArtwork(league, [league, evolving, trick]), 'Sword & Shield');
  const split = splitVersionPage({
    current: league,
    nameRows: [league],
    artRows: [league, evolving, trick],
  });
  assert.deepEqual(split.eras.map((group) => group.label), ['Sword & Shield']);
  assert.ok(!split.eras.some((group) => group.label === 'Other'));

  const ultraDump = {
    id: '748144',
    name: 'Ultra Ball',
    set: 'League Promos',
    number: 'League Promo | 131/132',
  };
  const ultraMega = {
    id: '703306',
    name: 'Ultra Ball',
    set: 'Mega Evolution',
    number: '131/132',
  };
  const ultraSv = {
    id: '471294',
    name: 'Ultra Ball',
    set: 'Violet ex',
    number: '070/078',
  };
  assert.equal(inheritEraFromArtwork(ultraDump, [ultraDump, ultraMega, ultraSv]), 'Mega Evolution');
  const mixed = splitVersionPage({
    current: ultraDump,
    nameRows: [ultraDump],
    artRows: [ultraDump, ultraMega, ultraSv],
  });
  assert.deepEqual(
    mixed.eras.map((group) => [group.label, group.rows.map((row) => row.id)]),
    [
      ['Mega Evolution', ['748144', '703306']],
      ['Scarlet & Violet', ['471294']],
    ],
  );

  const theme = {
    id: '799656',
    name: 'Silvally',
    set: 'Theme Deck & Blisters Exclusives',
    number: 'Non-Holo | 070/084',
  };
  const pitch = {
    id: '798832',
    name: 'Silvally',
    set: 'Pitch Black',
    number: 'Holo Rare | 070/084',
  };
  assert.equal(inheritEraFromArtwork(theme, [theme, pitch]), 'Mega Evolution');
  const prize = {
    id: 'prize-svi',
    name: 'Ultra Ball',
    set: 'Play! Pokémon Prize Pack Series',
    number: 'Non-Holo / Cosmos Holo · SVI 196',
  };
  const svi = {
    id: '196198',
    name: 'Ultra Ball',
    set: 'Scarlet & Violet',
    number: '196/198',
  };
  assert.equal(inheritEraFromArtwork(prize, [prize, svi, ultraMega, ultraSv]), 'Scarlet & Violet');
});

test('Holiday Calendar stamps inherit the era from a unique same-number artwork', () => {
  const glaceonHoliday = {
    id: '706792',
    name: 'Glaceon ex',
    set: 'Holiday Calendar',
    number: '026 | Holiday Snowflake Stamp',
  };
  const glaceonBase = {
    id: '633254',
    name: 'Glaceon ex',
    set: 'Prismatic Evolutions',
    number: 'Ultra Rare | 026/131',
  };
  const glaceonLaterProduct = {
    id: '727656',
    name: 'Glaceon ex',
    set: 'MEGA Start Deck 100 Battle Collection',
    number: 'Ultra Rare | 162/742',
  };
  assert.equal(
    inheritEraFromArtwork(
      glaceonHoliday,
      [glaceonHoliday, glaceonBase, glaceonLaterProduct],
    ),
    'Scarlet & Violet',
  );

  const turtwigHoliday = {
    id: '245898',
    name: 'Turtwig Lv.9',
    set: 'Holiday Calendar',
    number: '078 | Holiday Snowflake Stamp',
  };
  const turtwigBase = {
    id: '245782',
    name: 'Turtwig Lv.9',
    set: 'Majestic Dawn',
    number: '78/100',
  };
  const turtwigLaterArt = {
    id: '467794',
    name: 'Turtwig',
    set: 'VSTAR Universe',
    number: 'Secret Rare | 206/172',
  };
  assert.equal(
    inheritEraFromArtwork(
      turtwigHoliday,
      [turtwigHoliday, turtwigBase, turtwigLaterArt],
    ),
    'Diamond & Pearl',
  );
});
