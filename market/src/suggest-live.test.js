import assert from 'node:assert/strict';
import test from 'node:test';
import { compactQuery, nameRow } from './suggest-rank.js';
import {
  cachedPrintings,
  isLiveStub,
  liveSuggestGroups,
  rememberPrintings,
  rememberSuggestGroups,
  resetSuggestLive,
  stubPrinting,
  suggestLiveReady,
} from './suggest-live.js';

const pool = [
  nameRow('Pikachu', 200),
  nameRow('Charizard', 80),
  nameRow('Cynthia', 40),
];

test('one-letter Meili cache is ready when the popup opens at three characters', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    { name: 'Cynthia', printings: [{ id: '20', name: 'Cynthia', set: 'Ultra Prism' }] },
  ]);
  assert.equal(liveSuggestGroups('c', { pool }).groups.length, 0);
  const live = liveSuggestGroups('cyn', { pool, preferPerGroup: 1 });
  assert.equal(live.groups[0].name, 'Cynthia');
  assert.equal(live.groups[0].printings[0].id, '20');
});

test('search tabs fill singles or product, not a mixed 20', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    {
      name: 'Mimikyu',
      printings: [
        { id: 'card', name: 'Mimikyu', itemKind: 'single', productType: 'card' },
        { id: 'box', name: 'Mimikyu ex Box', itemKind: 'product', productType: 'product' },
      ],
    },
  ]);
  const singles = liveSuggestGroups('mim', { pool: [nameRow('Mimikyu', 200)], preferPerGroup: 4, kind: 'singles' });
  assert.deepEqual(singles.groups.flatMap((group) => group.printings.map((row) => row.id)), ['card']);
  const product = liveSuggestGroups('mim', { pool: [nameRow('Mimikyu', 200)], preferPerGroup: 4, kind: 'product' });
  assert.deepEqual(product.groups.flatMap((group) => group.printings.map((row) => row.id)), ['box']);
});

test('third keystroke paints cached ranked printings, never name stubs', () => {
  resetSuggestLive();
  const empty = liveSuggestGroups('pik', { pool, preferPerGroup: 1 });
  assert.equal(empty.groups.length, 0);
  rememberSuggestGroups([
    { name: 'Pikachu', printings: [{ id: 'p1', name: 'Pikachu', set: 'Base' }] },
  ]);
  const live = liveSuggestGroups('pik', { pool, preferPerGroup: 1 });
  assert.equal(live.groups[0].name, 'Pikachu');
  assert.equal(live.groups[0].printings[0].id, 'p1');
  assert.equal(isLiveStub(live.groups[0].printings[0]), false);
});

test('remembered printings replace stubs and keep moving as the query grows', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    { name: 'Charizard', printings: [{ id: '10', name: 'Charizard', set: 'Base Set' }] },
    { name: 'Cynthia', printings: [{ id: '20', name: 'Cynthia', set: 'Ultra Prism' }] },
  ]);
  const first = liveSuggestGroups('cha', { pool, preferPerGroup: 1 });
  assert.equal(first.groups.find((group) => group.name === 'Charizard').printings[0].id, '10');
  const next = liveSuggestGroups('cyn', { pool, preferPerGroup: 1 });
  assert.equal(next.groups[0].name, 'Cynthia');
  assert.equal(next.groups[0].printings[0].id, '20');
  assert.ok(!next.groups.some((group) => group.name === 'Charizard'));
});

test('cache merge keeps both printings of a name', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    { name: 'Cynthia', printings: [{ id: '20', name: 'Cynthia' }] },
  ]);
  rememberSuggestGroups([
    { name: 'Cynthia', printings: [{ id: '21', name: 'Cynthia' }, { id: '20', name: 'Cynthia' }] },
  ]);
  assert.deepEqual(cachedPrintings('Cynthia').map((row) => row.id).sort(), ['20', '21']);
});

test('stubs are tagged live:', () => {
  assert.equal(stubPrinting('Cynthia').id, 'live:cynthia');
  assert.equal(isLiveStub({ id: '220028' }), false);
});

test('artist intent paints cached printings instead of a name stub', () => {
  resetSuggestLive();
  // Real hydrated artist cards carry the illustrator (cardFromCatalogRow.artist);
  // the one scorer surfaces them via artist EVIDENCE — no separate artist branch.
  rememberSuggestGroups([
    { name: 'Cynthia', printings: [{ id: '1', name: 'Cynthia', set: 'Ultra Prism', artist: 'Tomokazu Komiya', nationality: 'western' }] },
    { name: 'Garchomp', printings: [{ id: '2', name: 'Garchomp', set: 'Ultra Prism', artist: 'Tomokazu Komiya', nationality: 'western' }] },
  ]);
  const live = liveSuggestGroups('komiya', { preferPerGroup: 4 });
  assert.equal(live.intent.kind, 'artist');
  assert.ok(live.groups.some((group) => group.name === 'Cynthia'));
  assert.equal(live.groups.find((group) => group.name === 'Cynthia').printings[0].id, '1');
});

test('expedition live paints 20 Expedition Base Set cards, not Uniform', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    {
      name: 'Expedition Uniform',
      printings: [{
        id: 'uniform',
        name: 'Expedition Uniform',
        set: 'Chilling Reign',
        number: '137/198',
      }],
    },
  ]);
  rememberPrintings('set:expedition-base-set', Array.from({ length: 24 }, (_, index) => ({
    id: `ex${index}`,
    name: index === 0 ? 'Alakazam' : `Expedition Mon ${index}`,
    set: 'Expedition Base Set',
    number: `${index + 1}/165`,
  })));
  const live = liveSuggestGroups('expedition', { preferPerGroup: 4, kind: 'singles' });
  assert.equal(live.intent.kind, 'set');
  assert.equal(live.intent.slug, 'expedition-base-set');
  const ids = live.groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.equal(ids.length, 20);
  assert.equal(ids[0], 'ex0');
  assert.ok(!ids.includes('uniform'));
  assert.ok(ids.every((id) => String(id).startsWith('ex')));
});

test('Sh1 paints cached SH codes across names, not Shinx leftovers', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    {
      name: 'Shinx',
      printings: [
        { id: 'lv', name: 'Shinx', number: 'LV.11', set: 'Perfect Order', nationality: 'western' },
        { id: 'sh12', name: 'Shinx', number: 'SH12', set: 'Platinum Arceus', nationality: 'western' },
        { id: 'jp', name: 'Shinx', number: '012/100', nationality: 'japanese' },
      ],
    },
    {
      name: 'Drifloon Lv.16',
      printings: [{
        id: 'drift',
        name: 'Drifloon Lv.16',
        number: 'Holo Rare | SH1',
        set: 'Stormfront',
        nationality: 'western',
      }],
    },
    {
      name: 'Bagon',
      printings: [{
        id: 'bagon',
        name: 'Bagon',
        number: 'SH10 | Holo Rare',
        set: 'Platinum Arceus',
        nationality: 'western',
      }],
    },
    {
      name: 'Shuppet',
      printings: [{ id: 'pup', name: 'Shuppet', number: '068/146', nationality: 'western' }],
    },
  ]);
  const live = liveSuggestGroups('Sh1', { printLang: 'western' });
  const ids = live.groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.ok(ids.includes('drift'));
  assert.ok(ids.includes('bagon'));
  assert.ok(ids.includes('sh12'));
  assert.ok(ids.includes('lv'));
  assert.ok(ids.includes('pup'));
  assert.ok(!ids.includes('jp'));
  assert.ok(!ids.some((id) => String(id).startsWith('live:')));
  assert.equal(ids.length, 5);
  assert.ok(live.groups[0].printings.some((row) => (
    row.id === 'drift' || row.id === 'bagon' || row.id === 'sh12'
  )));
  assert.equal(liveSuggestGroups('shi').parsed.numberTokens.length, 0);
  assert.equal(liveSuggestGroups('shi').groups[0].name, 'Shinx');
});

test('palkai call of live ranks Palkia from Call of Legends, not LV.X', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    {
      name: 'Palkia',
      printings: [
        { id: 'col', name: 'Palkia', set: 'Call of Legends', number: '11/95', nationality: 'western' },
        { id: 'ge', name: 'Palkia', set: 'Great Encounters', number: '106/106', nationality: 'western' },
      ],
    },
    {
      name: 'Palkia LV.X',
      printings: [{ id: 'lvx', name: 'Palkia LV.X', set: 'Great Encounters', number: '106/106', nationality: 'western' }],
    },
  ]);
  const live = liveSuggestGroups('palkai call of', { preferPerGroup: 4 });
  // `call of` set words add set evidence to the Call of Legends printing; the
  // Palkia name reading still leads (one scorer, not a set-branch takeover).
  assert.equal(live.groups[0].name, 'Palkia');
  assert.equal(live.groups[0].printings[0].id, 'col');
  assert.ok(live.groups.findIndex((group) => group.name === 'Palkia')
    < live.groups.findIndex((group) => group.name === 'Palkia LV.X'));
});

test('flareon call of legendsd live ranks Flareon, not sealed products', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    {
      name: 'Flareon',
      printings: [
        { id: 'col', name: 'Flareon', set: 'Call of Legends', number: '44/95', nationality: 'western' },
        { id: 'sv', name: 'Flareon', set: 'Obsidian Flames', number: '014/197', nationality: 'western' },
      ],
    },
    {
      name: 'Call of Legends Booster',
      printings: [{ id: 'pack', name: 'Call of Legends Booster', set: 'Call of Legends' }],
    },
  ]);
  const live = liveSuggestGroups('flareon call of legendsd', { preferPerGroup: 4 });
  // Flareon name reading leads; the set phrase is evidence, never a takeover.
  assert.equal(live.groups[0].name, 'Flareon');
  assert.equal(live.groups[0].printings[0].id, 'col');
  assert.ok(!live.groups.some((group) => /Booster|Theme Deck/i.test(group.name)));
});

test('pikahc gx live ranks Pikachu GX before Pikachu', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    { name: 'Pikachu GX', printings: [{ id: 'gx', name: 'Pikachu GX', set: 'Burning Shadows' }] },
    { name: 'Pikachu', printings: [{ id: 'base', name: 'Pikachu', set: 'Base Set' }] },
  ]);
  const live = liveSuggestGroups('pikahc gx', { preferPerGroup: 4 });
  assert.equal(live.groups[0].name, 'Pikachu GX');
  assert.ok(live.groups.findIndex((group) => group.name === 'Pikachu GX')
    < live.groups.findIndex((group) => group.name === 'Pikachu'));
});

test('hgss energy live ranks HeartGold energies, not Aquapolis Switch', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    {
      name: 'Energy Switch',
      printings: [
        { id: 'aq', name: 'Energy Switch', set: 'Aquapolis', number: '120/147', nationality: 'western' },
        { id: 'hgss', name: 'Energy Switch', set: 'HeartGold & SoulSilver', number: '091/123', nationality: 'western' },
      ],
    },
    {
      name: 'Fire Energy',
      printings: [{
        id: 'fire',
        name: 'Fire Energy',
        set: 'HeartGold & SoulSilver',
        number: '116/123',
        nationality: 'western',
      }],
    },
    {
      name: 'Lightning Energy',
      printings: [{
        id: 'light',
        name: 'Lightning Energy',
        set: 'HeartGold Collection',
        number: '061/070',
        nationality: 'western',
      }],
    },
  ]);
  const live = liveSuggestGroups('hgss energy', { preferPerGroup: 4, kind: 'singles' });
  assert.equal(compactQuery(live.parsed.nameQuery), 'energy');
  const ids = live.groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.ok(!ids.includes('aq'));
  assert.equal(live.groups[0].name, 'Fire Energy');
  assert.ok(ids.includes('fire'));
  assert.ok(ids.includes('light'));
  assert.ok(ids.includes('hgss'));
});

test('palkai sl live ranks Call of Legends Palkia, not LV.X or jumbos', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    {
      name: 'Palkia',
      printings: [
        { id: 'col', name: 'Palkia', set: 'Call of Legends', number: '11/95', nationality: 'western' },
        { id: 'ge', name: 'Palkia', set: 'Great Encounters', number: '26/106', nationality: 'western' },
      ],
    },
    {
      name: 'Palkia LV.X',
      printings: [{
        id: 'lvx',
        name: 'Palkia LV.X',
        set: 'Great Encounters',
        number: '106/106',
        nationality: 'western',
      }],
    },
    {
      name: 'Palkia & Dialga LEGEND',
      printings: [{
        id: 'jumbo',
        name: 'Palkia & Dialga LEGEND',
        number: 'Jumbo Oversized',
        set: 'Triumphant',
        nationality: 'western',
      }],
    },
  ]);
  const live = liveSuggestGroups('palkai sl', { preferPerGroup: 4, kind: 'singles' });
  // `sl` is now set-alias EVIDENCE (not a hard peel): Call of Legends Palkia
  // leads on coverage, other Palkia readings stay eligible (one scorer, §4).
  const ids = live.groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.equal(ids[0], 'col');
  assert.ok(ids.includes('ge'));
  assert.ok(!ids.includes('jumbo'));
  const product = liveSuggestGroups('palkai', { preferPerGroup: 4, kind: 'product' });
  assert.ok(product.groups.some((group) => group.printings.some((row) => row.id === 'jumbo')));
  assert.ok(!product.groups.some((group) => group.printings.some((row) => row.id === 'col')));
});

test('Palkia & Dialga Legend live ranks the LEGEND pair, not Dialga', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    {
      name: 'Dialga',
      printings: [
        { id: 'csv', name: 'Dialga', set: 'Stellar Crown', number: 'Holo Rare', nationality: 'western' },
      ],
    },
    {
      name: 'Palkia & Dialga LEGEND',
      printings: [
        { id: 'legend', name: 'Palkia & Dialga LEGEND', set: 'Triumphant', number: '101/102', nationality: 'western' },
      ],
    },
  ]);
  const live = liveSuggestGroups('Palkia & Dialga Legend', { preferPerGroup: 4 });
  assert.equal(live.groups[0].name, 'Palkia & Dialga LEGEND');
  assert.equal(live.groups[0].printings[0].id, 'legend');
  assert.ok(!live.parsed.eras.includes('Scarlet & Violet'));
});

test('palkia legen live fills 20 Palkia singles, not Paldea tins or jumbos', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    {
      name: 'Palkia Premium Box',
      printings: [{ id: 'box', name: 'Palkia Premium Box', itemKind: 'product', productType: 'product' }],
    },
    {
      name: 'Paldea Legends Tins: Miraidon ex Tin',
      printings: [{
        id: 'tin',
        name: 'Paldea Legends Tins: Miraidon ex Tin',
        itemKind: 'product',
        productType: 'product',
      }],
    },
    {
      name: 'Palkia',
      printings: [
        { id: 'col', name: 'Palkia', set: 'Call of Legends', number: '11/95', nationality: 'western' },
        {
          id: 'jumbo',
          name: 'Palkia',
          number: '017',
          rarity: 'Jumbo Oversized',
          set: 'Call of Legends',
          nationality: 'western',
        },
        ...Array.from({ length: 24 }, (_, index) => ({
          id: `p${index}`,
          name: 'Palkia',
          set: 'Great Encounters',
          number: `${index + 1}/106`,
          nationality: 'western',
        })),
      ],
    },
  ]);
  const live = liveSuggestGroups('palkia legen', { preferPerGroup: 4, kind: 'singles' });
  const ids = live.groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.equal(ids[0], 'col');
  assert.equal(ids.length, 20);
  assert.ok(!ids.includes('box'));
  assert.ok(!ids.includes('tin'));
  assert.ok(!ids.includes('jumbo'));
  const product = liveSuggestGroups('palkia legen', { preferPerGroup: 4, kind: 'product' });
  assert.ok(product.groups.some((group) => group.printings.some((row) => row.id === 'jumbo')));
});

test('arceus platinum singles drop theme decks, chests, and binders', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    {
      name: 'Arceus: Flamemaster Theme Deck',
      printings: [{
        id: 'deck',
        name: 'Arceus: Flamemaster Theme Deck',
        set: 'HeartGold & SoulSilver Platinum',
        productType: 'card',
      }],
    },
    {
      name: 'Arceus: Stormshaper Theme Deck',
      printings: [{
        id: 'storm',
        name: 'Arceus: Stormshaper Theme Deck',
        set: 'HeartGold & SoulSilver Platinum',
        productType: 'card',
      }],
    },
    {
      name: 'Arceus Spring 2022 Collector\'s Chest',
      printings: [{
        id: 'chest',
        name: 'Arceus Spring 2022 Collector\'s Chest',
        productType: 'card',
      }],
    },
    {
      name: 'Arceus ◇ Prism Star',
      printings: [{
        id: 'prism',
        name: 'Arceus ◇ Prism Star',
        set: 'Forbidden Light',
        number: '96/131',
        nationality: 'western',
      }],
    },
    {
      name: 'Arceus Lv.100',
      printings: [{
        id: 'ar1',
        name: 'Arceus Lv.100',
        set: 'Platinum Arceus',
        number: 'AR1',
        nationality: 'western',
      }],
    },
  ]);
  const singles = liveSuggestGroups('arceus platinum', { preferPerGroup: 4, kind: 'singles' });
  // `platinum` is set-alias evidence: Platinum Arceus singles rank up, all
  // Arceus singles stay eligible, products are dropped by scope (not by peel).
  const ids = singles.groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.ok(ids.includes('prism'));
  assert.ok(ids.includes('ar1'));
  assert.ok(!ids.includes('deck'));
  assert.ok(!ids.includes('storm'));
  assert.ok(!ids.includes('chest'));
  const product = liveSuggestGroups('arceus platinum', { preferPerGroup: 4, kind: 'product' });
  const productIds = product.groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.ok(productIds.includes('deck'));
  assert.ok(productIds.includes('chest'));
  assert.ok(!productIds.includes('prism'));
});

test('singles typeahead drops Paldean Fates Collections and League Battle decks', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    {
      name: 'Mega Charizard X ex',
      printings: [{
        id: 'mep',
        name: 'Mega Charizard X ex',
        set: 'MEP Black Star Promo',
        number: 'MEP 023',
      }],
    },
    {
      name: 'Charizard ex Paldean Fates Collections',
      printings: [{
        id: 'collections',
        name: 'Charizard ex Paldean Fates Collections',
        set: 'Scarlet & Violet Products',
        number: 'Portuguese Exclusive',
      }],
    },
    {
      name: 'Charizard ex League Battle Deck',
      printings: [{
        id: 'deck',
        name: 'Charizard ex League Battle Deck',
        set: 'Scarlet & Violet Products',
        number: '',
      }],
    },
    {
      name: 'Charizard ex League Battle Deck Dice Set',
      printings: [{
        id: 'dice',
        name: 'Charizard ex League Battle Deck Dice Set',
        set: 'Scarlet & Violet Products',
      }],
    },
    {
      name: 'Charizard ☆ Gold Star δ Delta Species',
      printings: [{
        id: 'gold',
        name: 'Charizard ☆ Gold Star δ Delta Species',
        set: 'EX Dragon Frontiers',
        number: '100/101',
      }],
    },
  ]);
  const pool = [
    nameRow('Mega Charizard X ex', 20),
    nameRow('Charizard ex Paldean Fates Collections', 1),
    nameRow('Charizard ex League Battle Deck', 1),
    nameRow('Charizard ex League Battle Deck Dice Set', 1),
    nameRow('Charizard ☆ Gold Star δ Delta Species', 10),
  ];
  const singles = liveSuggestGroups('charizard', { pool, preferPerGroup: 4, kind: 'singles' });
  const ids = singles.groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.ok(ids.includes('gold'));
  assert.ok(!ids.includes('collections'));
  assert.ok(!ids.includes('deck'));
  assert.ok(!ids.includes('dice'));
  const mega = liveSuggestGroups('mega charizard', { pool, preferPerGroup: 4, kind: 'singles' });
  assert.ok(mega.groups.flatMap((group) => group.printings.map((row) => row.id)).includes('mep'));
  const product = liveSuggestGroups('charizard', { pool, preferPerGroup: 4, kind: 'product' });
  const productIds = product.groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.ok(productIds.includes('collections'));
  assert.ok(productIds.includes('deck'));
  assert.ok(productIds.includes('dice'));
  assert.ok(!productIds.includes('gold'));
});

test('keldeo ex live fills White Flare with EX and skips cached GX', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    {
      name: 'Keldeo EX',
      printings: [
        {
          id: 'bc',
          name: 'Keldeo EX',
          set: 'Boundaries Crossed',
          number: '49/149',
          nationality: 'western',
          itemKind: 'single',
        },
        {
          id: 'wf',
          name: 'Keldeo ex',
          set: 'White Flare',
          number: '159/086',
          nationality: 'western',
          itemKind: 'single',
        },
        {
          id: 'lt',
          name: 'Keldeo EX',
          set: 'Legendary Treasures',
          number: '45/113',
          nationality: 'western',
          itemKind: 'single',
        },
      ],
    },
    {
      name: 'Keldeo GX',
      printings: [
        {
          id: 'gx1',
          name: 'Keldeo GX',
          set: 'Unified Minds',
          number: '47/236',
          nationality: 'western',
          itemKind: 'single',
        },
        {
          id: 'gx2',
          name: 'Keldeo GX',
          set: 'Unified Minds',
          number: '240/236',
          nationality: 'western',
          itemKind: 'single',
        },
        {
          id: 'gx3',
          name: 'Keldeo GX',
          set: 'Unified Minds',
          number: '219/236',
          nationality: 'western',
          itemKind: 'single',
        },
      ],
    },
  ]);
  const live = liveSuggestGroups('keldeo ex', { preferPerGroup: 4, kind: 'singles' });
  const ids = live.groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.ok(ids.includes('wf'));
  assert.ok(ids.includes('bc'));
  assert.ok(ids.includes('lt'));
  assert.ok(!ids.some((id) => String(id).startsWith('gx')));
});

test('eevee i peels illustration shorthand and keeps the cached Eevee pool, never an Eevee Heroes set peel', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    {
      name: 'Eevee',
      printings: Array.from({ length: 7 }, (_, index) => ({
        id: `eevee-${index}`,
        name: 'Eevee',
        set: 'Hidden Fates',
        rarity: 'Special Illustration Rare',
        number: `0${index + 1}/068`,
        nationality: 'western',
        itemKind: 'single',
        productType: 'card',
      })),
    },
  ]);
  // No pool argument — the exact Chrome.jsx call, so ranked comes from
  // catalogIntent and the query must not peel `eevee` as the Eevee Heroes set.
  const live = liveSuggestGroups('eevee i', { printLang: 'all', kind: 'singles' });
  // `i` is illustration/art EVIDENCE now (no set peel, no art hard-facet): the
  // Eevee pool stays and its Illustration-Rare printing leads within the group.
  assert.equal(live.parsed.setTokens.length, 0);
  assert.equal(live.groups[0]?.name, 'Eevee');
  const filled = live.groups.reduce((n, group) => n + group.printings.length, 0);
  assert.equal(filled, 7);
});


test('token typing keeps the pool rank and the top 20 visible at every keystroke', () => {
  resetSuggestLive();
  // What typing `e` … `eevee` caches: the plain blueprint plus variant groups.
  rememberSuggestGroups([
    {
      name: 'Eevee',
      printings: [
        ...Array.from({ length: 18 }, (_, index) => ({
          id: `eevee-${index}`,
          name: 'Eevee',
          set: 'Hidden Fates',
          rarity: 'Card',
          number: `04${index}/068`,
          card_number: `04${index}/068`,
          nationality: 'western',
          itemKind: 'single',
          productType: 'card',
        })),
        {
          id: 'eevee-tg11',
          name: 'Eevee',
          set: 'Brilliant Stars',
          rarity: 'Card',
          number: 'Illustration Rare | TG11/TG30',
          card_number: 'Illustration Rare | TG11/TG30',
          nationality: 'western',
          itemKind: 'single',
          productType: 'card',
        },
      ],
    },
    {
      name: 'Eevee ex',
      printings: [{
        id: 'eevee-ex-sir',
        name: 'Eevee ex',
        set: 'Prismatic Evolutions',
        rarity: 'Card',
        number: 'Special Illustration Rare | 167/131',
        card_number: 'Special Illustration Rare | 167/131',
        nationality: 'western',
        itemKind: 'single',
        productType: 'card',
      }],
    },
  ]);
  const seen = [];
  for (const query of ['eevee i', 'eevee il', 'eevee ill', 'eevee illu', 'eevee illus', 'eevee illust']) {
    const live = liveSuggestGroups(query, { printLang: 'all', kind: 'singles' });
    const rows = live.groups.flatMap((group) => group.printings);
    assert.ok(rows.length >= 19, `${query} must render the cached pool, got ${rows.length}`);
    assert.equal(live.ranked[0]?.display, 'Eevee',
      `${query} must rank the name pool, not the fuzzy catalog intent`);
    seen.push(rows[0]?.id);
  }
  assert.equal(new Set(seen).size, 1,
    `the first row must stay put while typing the token, got ${seen.join(' -> ')}`);
  assert.equal(seen[0], 'eevee-tg11',
    'the Eevee group leads its own IR; group pool rank ties the token rows');
});

test('set-token live path keeps the name pool instead of a stub intent group', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    {
      name: 'Palkia',
      printings: Array.from({ length: 6 }, (_, index) => ({
        id: `palkia-${index}`,
        name: 'Palkia',
        set: 'Call of Legends',
        rarity: 'Card',
        number: `0${index + 1}/95`,
        card_number: `0${index + 1}/95`,
        nationality: 'western',
        itemKind: 'single',
        productType: 'card',
      })),
    },
  ]);
  const live = liveSuggestGroups('palkia legen', { printLang: 'all', kind: 'singles' });
  const filled = live.groups.reduce((n, group) => n + group.printings.length, 0);
  // `legen` is Call of Legends set-alias EVIDENCE; the cached Palkia pool fills
  // the list through the one scorer (no stub intent group, no hard set filter).
  assert.equal(filled, 6, 'cached printings fill the list instead of a stub group');
});

test('a print filter with no matching rows returns an empty popup', () => {
  resetSuggestLive();
  const latiosPool = [nameRow('Latios ex', 90)];
  rememberSuggestGroups([
    {
      name: 'Latios ex',
      printings: [
        {
          id: 'half',
          name: 'Latios ex',
          set: 'Latios ex Half Deck',
          number: '011/018',
          nationality: 'japanese',
          itemKind: 'single',
          productType: 'card',
        },
      ],
    },
  ]);
  const out = liveSuggestGroups('latios ex 011', {
    pool: latiosPool,
    printLang: 'western',
    kind: 'singles',
  });
  const rows = out.groups.flatMap((group) => group.printings);
  assert.equal(rows.length, 0, 'western hard filter does not broaden to Japanese');
});
