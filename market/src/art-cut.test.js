import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ART_CUT_BLEED,
  ART_CUT_HALFART,
  ART_CUT_LAYOUTS,
  POKEMON_ART_CUT,
  artCutFor,
  artCutLayoutName,
  artCutPixels,
  artCutVars,
  isLandscapePrintName,
  isFeatureAlbumArt,
} from './art-cut.js';

function assertLandscape(cut, label) {
  const box = {
    width: cut.width * (63 / 88),
    height: cut.height,
  };
  const ratio = box.width / box.height;
  assert.ok(ratio > 1.4, `${label} ratio ${ratio}`);
  assert.ok(ratio < 2.2, `${label} ratio ${ratio}`);
}

test('default art cut is the modern family window', () => {
  assert.equal(artCutLayoutName({}), 'modern');
  assert.equal(artCutFor(), POKEMON_ART_CUT);
  const box = artCutPixels(330, 460);
  assert.ok(box);
  assert.ok(box.width > box.height);
  assert.ok(box.width / box.height > 1.4);
  assert.ok(box.width / box.height < 2);
});

test('art cut stays inside leftover JPEG and 240px homepage webp', () => {
  for (const [w, h] of [[330, 460], [240, 335], [326, 456], [737, 1021], [761, 1038], [600, 825]]) {
    for (const layout of Object.keys(ART_CUT_LAYOUTS)) {
      const card = layout === 'ex' ? { set: 'EX Emerald' }
        : layout === 'wotc' ? { set: 'Base Set' }
          : layout === 'neo' ? { set: 'Neo Genesis' }
            : layout === 'ecard' ? { set: 'Expedition Base Set' }
              : layout === 'dp' ? { set: 'Diamond & Pearl' }
                : { set: 'Scarlet & Violet' };
      const box = artCutPixels(w, h, card);
      assert.ok(box.x >= 0 && box.y >= 0, `${layout} ${w}x${h} origin`);
      assert.ok(box.x + box.width <= w, `${layout} ${w}x${h} right`);
      assert.ok(box.y + box.height <= h, `${layout} ${w}x${h} bottom`);
    }
  }
});

test('modern default misses the name bar and attack band', () => {
  assert.ok(POKEMON_ART_CUT.top >= 0.12);
  assert.ok(POKEMON_ART_CUT.top + POKEMON_ART_CUT.height <= 0.49);
  assert.ok(POKEMON_ART_CUT.left >= 0.07);
  assert.ok(POKEMON_ART_CUT.left + POKEMON_ART_CUT.width <= 0.93);
});

test('every era layout is a landscape painting window', () => {
  for (const [name, cut] of Object.entries(ART_CUT_LAYOUTS)) {
    assertLandscape(cut, name);
  }
});

test('era maps onto the measured leftover layout family', () => {
  assert.equal(artCutLayoutName({ set: 'Base Set' }), 'wotc');
  assert.equal(artCutLayoutName({ set: 'Jungle' }), 'wotc');
  assert.equal(artCutLayoutName({ set: 'Neo Genesis' }), 'neo');
  assert.equal(artCutLayoutName({ set: 'Southern Islands' }), 'neo');
  assert.equal(artCutLayoutName({ set: 'Southern Islands JP' }), 'neo');
  assert.equal(artCutLayoutName({ set: 'Legendary Collection' }), 'wotc');
  assert.equal(artCutLayoutName({ set: 'Expedition Base Set' }), 'ecard');
  assert.equal(artCutLayoutName({ set: 'EX Emerald' }), 'ex');
  assert.equal(artCutLayoutName({ set: 'EX Holon Phantoms' }), 'ex');
  assert.equal(artCutLayoutName({ set: 'EX Power Keepers' }), 'ex');
  assert.equal(artCutLayoutName({ set: 'Diamond & Pearl' }), 'dp');
  assert.equal(artCutLayoutName({ set: 'HeartGold & SoulSilver' }), 'dp');
  assert.equal(artCutLayoutName({ set: 'Undaunted' }), 'dp');
  assert.equal(artCutLayoutName({ set: 'Black & White' }), 'modern');
  assert.equal(artCutLayoutName({ set: 'Primal Clash' }), 'modern');
  assert.equal(artCutLayoutName({ set: 'Sun & Moon' }), 'modern');
  assert.equal(artCutLayoutName({ set: 'Sword & Shield' }), 'modern');
  assert.equal(artCutLayoutName({ set: 'Scarlet & Violet' }), 'modern');
});

test('EX crop ends above the STAGE / Illus overlay', () => {
  const cut = artCutFor({ set: 'EX Emerald' });
  assert.equal(cut, ART_CUT_LAYOUTS.ex);
  assert.ok(cut.top + cut.height <= 0.44);
  const box = artCutPixels(600, 825, { set: 'EX Emerald' });
  assert.ok((box.y + box.height) / 825 <= 0.44);
});

test('Neo and Southern Islands use the larger painting window, not Original gold-frame', () => {
  const neo = artCutFor({ set: 'Southern Islands' });
  assert.equal(neo, ART_CUT_LAYOUTS.neo);
  assert.ok(neo.height > ART_CUT_LAYOUTS.wotc.height);
  assert.ok(neo.width > ART_CUT_LAYOUTS.wotc.width);
  assert.deepEqual(
    artCutPixels(500, 688, { set: 'Southern Islands' }),
    { x: 41, y: 105, width: 418, height: 246 },
  );
  assert.deepEqual(
    artCutPixels(600, 825, { set: 'Neo Genesis' }),
    { x: 49, y: 125, width: 502, height: 295 },
  );
});

test('WotC crop sits inside the gold art frame', () => {
  const cut = artCutFor({ set: 'Base Set' });
  assert.ok(cut.left >= 0.12);
  assert.ok(cut.top >= 0.16);
  assert.ok(cut.left + cut.width <= 0.88);
});

test('Lucario leftover 330×460 matches the modern crop', () => {
  assert.deepEqual(artCutPixels(330, 460), { x: 28, y: 58, width: 273, height: 155 });
});

test('CSS vars follow the card era', () => {
  const modern = artCutVars();
  assert.equal(modern['--art-left'], '0.086');
  assert.equal(modern['--art-top'], '0.126');
  assert.equal(modern['--art-width'], '0.828');
  assert.equal(modern['--art-height'], '0.338');
  const ex = artCutVars({ set: 'EX Emerald' });
  assert.equal(ex['--art-top'], '0.112');
  assert.equal(ex['--art-height'], '0.318');
});

test('LEGEND and BREAK names are landscape prints; set titles are not', () => {
  assert.equal(isLandscapePrintName('Palkia & Dialga LEGEND'), true);
  assert.equal(isLandscapePrintName('Palkia & Dialga Legend'), true);
  assert.equal(isLandscapePrintName('Ho-Oh LEGEND'), true);
  assert.equal(isLandscapePrintName('Greninja BREAK'), true);
  assert.equal(isLandscapePrintName('Arcanine BREAK'), true);
  assert.equal(isLandscapePrintName('Call of Legends'), false);
  assert.equal(isLandscapePrintName('Legendary Collection'), false);
  assert.equal(isLandscapePrintName('BREAKthrough'), false);
  assert.equal(isLandscapePrintName('BREAKpoint'), false);
  assert.equal(isLandscapePrintName('Golduck BREAK + Palkia EX Combo Deck'), false);
  assert.equal(isLandscapePrintName('BREAK Evolution Box: Arcanine BREAK'), false);
  assert.equal(isLandscapePrintName('Pikachu'), false);
});

test('album full-art uses a taller painting crop, not the whole card', () => {
  const sir = {
    rarity: 'Special Illustration Rare',
    number: '274/217',
    set: 'Ascended Heroes',
  };
  assert.equal(artCutFor(sir), POKEMON_ART_CUT);
  assert.equal(artCutFor(sir, 'album'), ART_CUT_BLEED);
  assert.ok(ART_CUT_BLEED.height > POKEMON_ART_CUT.height);
  assert.ok(ART_CUT_BLEED.top + ART_CUT_BLEED.height < 0.78);
  assert.deepEqual(
    artCutPixels(660, 920, sir, 'album'),
    { x: 32, y: 26, width: 597, height: 569 },
  );
});

test('illustration and full-art printings are two-row album tiles', () => {
  assert.equal(isFeatureAlbumArt({
    number: 'Illustration Rare | TG12/TG30',
    set: 'Brilliant Stars',
  }), true);
  assert.equal(isFeatureAlbumArt({
    rarity: 'Special Illustration Rare',
    number: '237/198',
    set: 'Scarlet & Violet',
  }), true);
  assert.equal(isFeatureAlbumArt({
    number: 'Full Art | 188/185',
    set: 'Vivid Voltage',
  }), true);
  assert.equal(isFeatureAlbumArt({
    rarity: 'Shiny Rare',
    number: 'SV44/SV94',
    set: 'Paldea Fates',
  }), true);
  assert.equal(isFeatureAlbumArt({
    number: 'Promo | 088/198',
    set: 'Play! Pokémon Prize Pack Series',
  }), false);
  assert.equal(isFeatureAlbumArt({
    number: 'Full-Art | 098/159',
    set: 'Play! Pokémon Prize Pack Series',
  }), true);
  assert.equal(isFeatureAlbumArt({ name: 'Greninja BREAK' }), true);
  assert.equal(isFeatureAlbumArt({
    rarity: 'Common',
    number: '104/214',
    set: 'Unbroken Bonds',
  }), false);
  assert.equal(isFeatureAlbumArt({
    rarity: 'Rare',
    number: '059/202',
    set: 'Sword & Shield',
  }), false);
});

test('SM gold trainer Gold Secret album uses the bleed cut; stored window keeps the name-bar crop', () => {
  const gold = {
    name: 'Mysterious Treasure',
    number: 'Gold Secret Rare | 145/131',
    set: 'Forbidden Light',
  };
  assert.equal(artCutFor({ ...gold, artLayout: 'bleed' }, 'album'), ART_CUT_BLEED);
  assert.equal(artCutFor({ ...gold, artLayout: 'window' }, 'album'), POKEMON_ART_CUT);
  assert.equal(artCutFor({
    name: 'M Charizard ex',
    number: 'Gold Secret Rare | 108/106',
    set: 'Flashfire',
    artLayout: 'window',
  }, 'album'), POKEMON_ART_CUT);
});

test('Amazing Rare album/suggest uses the half-art cut, not bleed', () => {
  const raikou = {
    name: 'Raikou',
    number: 'Illustration Rare | 050/185',
    set: 'Vivid Voltage',
    artLayout: 'bleed',
  };
  assert.equal(artCutFor(raikou, 'album'), ART_CUT_HALFART);
  assert.equal(artCutFor(raikou, 'suggest'), ART_CUT_HALFART);
  assert.ok(ART_CUT_HALFART.top > ART_CUT_BLEED.top);
  assert.ok(ART_CUT_HALFART.top + ART_CUT_HALFART.height < 0.52);
  assert.equal(isFeatureAlbumArt(raikou), false);
});
