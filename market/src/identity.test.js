import assert from 'node:assert/strict';
import test from 'node:test';
import { cardDocumentTitle, clipSuggestCollector, collectorFromImageUrl, displayName, printingIdentity, sanitizeCardName, suggestCardName, suggestKind, suggestTranslatedLine, translatedName, vintedSearchText, vintedSearchUrl } from './identity.js';

test('suggest kind treats pin collections as products even without itemKind', () => {
  assert.equal(suggestKind({ name: 'Mimikyu', number: '042/094' }), 'Singles');
  assert.equal(suggestKind({ name: 'Mimikyu Pin Collection' }), 'Product');
  assert.equal(suggestKind({ name: 'Mimikyu Pin' }), 'Product');
  assert.equal(suggestKind({ name: 'Mimikyu Coin' }), 'Product');
  assert.equal(suggestKind({ name: 'Mimikyu ex Box' }), 'Product');
  assert.equal(suggestKind({ name: 'Mimikyu δ Delta Species' }), 'Singles');
  assert.equal(suggestKind({
    name: 'Palkia & Dialga LEGEND',
    number: 'Jumbo Oversized',
  }), 'Jumbo');
  assert.equal(suggestKind({ name: 'Jumbo Oversized Pikachu' }), 'Jumbo');
  assert.equal(suggestKind({
    name: 'Charizard',
    number: '017',
    rarity: 'Jumbo Oversized',
    set: 'XY Black Star Promos',
  }), 'Jumbo');
  assert.equal(suggestKind({
    name: 'Venusaur',
    number: 'Jumbo Oversized | 017',
    set: 'XY Black Star Promos',
  }), 'Jumbo');
  assert.equal(suggestKind({ name: 'Arceus: Flamemaster Theme Deck' }), 'Product');
  assert.equal(suggestKind({ name: 'Arceus: Stormshaper Theme Deck' }), 'Product');
  assert.equal(suggestKind({ name: 'Arceus Spring 2022 Collector\'s Chest' }), 'Product');
  assert.equal(suggestKind({ name: 'Charizard ex League Battle Deck' }), 'Product');
  assert.equal(suggestKind({
    name: 'Charizard ex League Battle Deck',
    set: 'Scarlet & Violet Products',
  }), 'Product');
  assert.equal(suggestKind({
    name: 'Charizard ex League Battle Deck Dice Set',
    set: 'Scarlet & Violet Products',
  }), 'Product');
  assert.equal(suggestKind({
    name: 'Mimikyu',
    card_number: 'Non-Holo Theme Deck | 58/145',
    item_kind: 'single',
    product_type: 'card',
  }), 'Singles', 'the API single stamp outranks the sealed-sounding rarity label');
  assert.equal(suggestKind({
    name: 'Mimikyu',
    productType: 'card',
    rarity: 'Non-Holo Theme Deck',
    number: '58/145',
  }), 'Singles', 'camelCase card stamp wins too');
  assert.equal(suggestKind({
    name: 'Mimikyu',
    card_number: 'Non-Holo Theme Deck | 58/145',
  }), 'Product', 'without the stamp the sealed label still wins');
  assert.equal(suggestKind({
    name: 'Charizard ex Paldean Fates Collections',
    set: 'Scarlet & Violet Products',
    number: 'Portuguese Exclusive',
  }), 'Product');
  assert.equal(suggestKind({
    name: 'Charizard ex',
    set: 'Scarlet & Violet Products',
    number: 'Portuguese Exclusive',
  }, 'Charizard ex Paldean Fates Collections'), 'Product');
  assert.equal(suggestKind({
    name: 'Charizard ex',
    number: '001/001',
    set: 'Scarlet & Violet Products',
  }, 'Charizard ex League Battle Deck'), 'Product');
  assert.equal(suggestKind({ name: 'Mega Charizard X ex', number: 'MEP 023' }), 'Singles');
  assert.equal(suggestKind({
    name: 'Charizard ☆ Gold Star δ Delta Species',
    number: '100/101',
    set: 'EX Dragon Frontiers',
  }), 'Singles');
  assert.equal(suggestKind({ name: '151: 9-Pocket Binder' }), 'Product');
  assert.equal(suggestKind({ name: 'Astral Radiance: Build & Battle Kit' }), 'Product');
  assert.equal(suggestKind({ name: 'First Partner Pack: Kanto' }), 'Product');
  assert.equal(suggestKind({ name: 'WCD 2004: Blaziken Tech Deck' }), 'Product');
  assert.equal(suggestKind({ name: 'WCD 2015: Honorstoise' }), 'Product');
  assert.equal(suggestKind({ name: 'Pokémon GO Special Set' }), 'Product');
  assert.equal(suggestKind({ name: 'Pokémon 151 Poster' }), 'Product');
  assert.equal(suggestKind({ name: 'Deck Exchange', number: '091/198' }), 'Singles');
  assert.equal(suggestKind({ name: 'Gift Energy', number: '171/198' }), 'Singles');
  assert.equal(suggestKind({ name: 'Fossil Excavation Kit', number: '100/091' }), 'Singles');
  assert.equal(suggestKind({ name: 'Suspicious Food Tin', number: '162/202' }), 'Singles');
  assert.equal(suggestKind({ name: 'Ancient Booster Energy Capsule', number: '159/182' }), 'Singles');
  assert.equal(suggestKind({ name: 'Wonder Platinum', number: '83/99' }), 'Singles');
  assert.equal(suggestKind({ name: 'Academy at Night', number: '159/167' }), 'Singles');
});

test('suggest expansion is the set name only, not a repeated #collector', () => {
  const identity = printingIdentity({
    name: 'Mimikyu',
    set: 'Paldean Fates',
    number: '037/091',
  });
  assert.equal(identity.suggestExpansion, 'Paldean Fates');
  assert.equal(identity.number, '037/091');
  assert.equal(identity.suggestExpansion.includes('#'), false);
  assert.equal(identity.suggestExpansionShort, 'Paldean Fates');
});

test('suggest expansion line caps at 20 characters', () => {
  const identity = printingIdentity({
    name: 'Mimikyu',
    set: 'Stellar Tera Type Starter Set Sylveon ex',
    number: '008/022',
  });
  assert.equal(identity.suggestExpansionShort, 'Stellar Tera Type St…');
  assert.ok(identity.suggestExpansionShort.length <= 21);
  assert.equal(identity.suggestExpansion, 'Stellar Tera Type Starter Set Sylveon ex');
  assert.equal(
    printingIdentity({ set: 'SM Black Star Promos' }).suggestExpansionShort,
    'SM Black Star Promos',
  );
  assert.equal(
    printingIdentity({ set: 'Guardians Rising' }).suggestExpansionShort,
    'Guardians Rising',
  );
});


test('Pokemon Vinted query is name + collector, not name alone', () => {
  const query = vintedSearchText({
    name: 'Gumshoos',
    set: 'Destined Rivals',
    number: 'Illustration Rare | 184/182',
  });
  assert.equal(query, 'Gumshoos 184');
  assert.equal(query.includes('Illustration'), false);
  assert.equal(query.includes('Destined'), false);
});

test('Pokemon Vinted query strips the printedTotal side of 113/156', () => {
  const query = vintedSearchText({
    name: 'Gumshoos',
    set_name: 'Ultra Prism',
    number: '113/156',
  });
  assert.equal(query, 'Gumshoos 113');
});

test('One Piece and Riftbound keep their game prefix and collector', () => {
  assert.equal(
    vintedSearchText({ name: 'Sanji', set: 'Romance Dawn', number: 'OP01-013' }, 'one_piece'),
    'One Piece Card Game Sanji OP01-013',
  );
  assert.equal(
    vintedSearchText({ name: 'Kai', set: 'Spiritforged', number: '001' }, 'riftbound'),
    'Riftbound TCG Kai 001',
  );
});

test('leftover ct_id is not a collector number', () => {
  const identity = printingIdentity({
    id: '281978',
    name: 'Eevee',
    set: 'Pokémon Jungle',
    number: '140989',
    rarity: 'Card',
  });
  assert.equal(identity.number, '');
  assert.equal(identity.tileLine, 'Pokémon Jungle');
  assert.equal(
    cardDocumentTitle(
      { id: '281978', name: 'Eevee', set: 'Pokémon Jungle', number: '140989' },
      'Eevee · 140989 · Pokémon Jungle',
    ),
    'Eevee Pokémon Jungle Price & Cards for Sale | Pokoin',
  );
});

test('CardTrader version ids are not collector numbers unless the leftover filename has n/m', () => {
  assert.equal(
    printingIdentity({
      id: '228472',
      name: "Team Magma's Aron",
      set: 'Double Crisis',
      number: '12754',
    }).number,
    '',
  );
  assert.equal(
    printingIdentity({
      id: '228472',
      name: "Team Magma's Aron",
      set: 'Double Crisis',
      number: '12754',
      imageUrl: '/card-images/114236_team-magma-s-aron-12-34-double-crisis.jpg',
    }).number,
    '12/34',
  );
  assert.equal(
    printingIdentity({
      id: '228450',
      number: '12420',
      gridImageUrl: '/card-images/114225_team-magma-s-numel-full-v4.jpg',
    }).number,
    '',
  );
  assert.equal(
    collectorFromImageUrl(
      '/uploads/blueprints/image/114225/team-magma-s-numel-1-34-double-crisis.jpg',
    ),
    '1/34',
  );
  assert.equal(
    collectorFromImageUrl('https://cdn.pokoin.com/114225_team-magma-s-numel-full-v4.jpg'),
    '',
  );
});

test('CT pokemon_rarity on a Sun and Moon star rare is Rare, not Illustration Rare', () => {
  const identity = printingIdentity({
    id: '245040',
    name: 'Alolan Persian',
    set: 'Lost Thunder',
    number: 'Rare | 119/214',
    rarity: 'Card',
  });
  assert.equal(identity.rarity, 'Rare');
  assert.equal(identity.number, '119/214');
  assert.equal(identity.tileLine, 'Rare · 119/214 · Lost Thunder');
});

test('real collector numbers stay visible', () => {
  assert.equal(
    printingIdentity({ id: '703358', number: 'Illustration Rare | 184/132' }).number,
    '184/132',
  );
  assert.equal(printingIdentity({ id: '239324', number: '060/062' }).number, '060/062');
  assert.equal(printingIdentity({ id: '281978', number: '51' }).number, '51');
  assert.equal(printingIdentity({ number: 'TG27/TG30' }).number, 'TG27/TG30');
  assert.equal(printingIdentity({ number: 'OP01-013' }).number, 'OP01-013');
  assert.equal(printingIdentity({ number: '053/217 | PXP Stamp' }).number, '053/217');
  assert.equal(printingIdentity({ number: '053/217 | PXP Stamp' }).rarity, 'PXP Stamp');
  assert.equal(printingIdentity({ number: 'SH10 | Holo Rare' }).number, 'SH10');
  assert.equal(printingIdentity({ number: 'SH10 | Holo Rare' }).rarity, 'Holo Rare');
  assert.equal(printingIdentity({ number: 'Holo Rare | AR1' }).number, 'AR1');
  assert.equal(printingIdentity({ number: 'Holo Rare | AR1' }).rarity, 'Holo Rare');
});

test('search popup cuts collector text to nine characters; desk keeps the full value', () => {
  const identity = printingIdentity({
    name: 'Espeon',
    set: 'Battle Academy 2020',
    number: 'Mewtwo Stamp',
  });
  assert.equal(identity.number, 'Mewtwo Stamp');
  assert.equal(identity.tileLine, 'Mewtwo Stamp · Battle Academy 2020');
  assert.equal(clipSuggestCollector(identity.number), 'Mewtwo St');
  assert.equal(clipSuggestCollector('089/214'), '089/214');
  assert.equal(clipSuggestCollector('TG27/TG30'), 'TG27/TG30');
});

test('name-only fallback is the card name on Pokemon', () => {
  assert.equal(vintedSearchText('Gumshoos'), 'Gumshoos');
  assert.equal(vintedSearchText(''), '');
});

test('Vinted URL pins Hobby e collezionismo catalog 4824', () => {
  const url = vintedSearchUrl({
    name: 'Dawn',
    number: 'Illustration Rare | 129/094',
  });
  assert.equal(
    url,
    'https://www.vinted.it/catalog?search_text=Dawn%20129&catalog[]=4824',
  );
  assert.equal(url.includes('search_id'), false);
  assert.equal(url.includes('time='), false);
});

test('title language keeps English names; suggest subtitle is the translation', () => {
  const card = {
    name: 'Ace Trainer',
    localized_name: 'Fantallenatori',
    set: 'Base Set',
    localized_set: 'Set Base',
    rarity: 'Rare',
    localized_rarity: 'Rara',
    number: '1/102',
  };
  assert.equal(displayName(card), 'Ace Trainer');
  assert.equal(translatedName(card), 'Fantallenatori');
  assert.equal(translatedName({ name: 'Pikachu', localized_name: 'Pikachu' }), '');
  const identity = printingIdentity(card);
  assert.equal(identity.suggestTitle, 'Ace Trainer - 1/102');
  assert.equal(identity.suggestExpansion, 'Base Set');
  assert.equal(identity.rarity, 'Rare');
  assert.equal(cardDocumentTitle(card), 'Ace Trainer Base Set 1/102 Price & Cards for Sale | Pokoin');
  assert.equal(vintedSearchText(card), 'Ace Trainer 1');
});

test('suggest uses the English group name and CardTrader translation - number line', () => {
  const card = {
    name: 'Camilla',
    localized_name: 'Camilla',
    number: '119/156',
    set: 'Ultra Prism',
  };
  assert.equal(suggestCardName(card, 'Cynthia'), 'Cynthia');
  assert.equal(translatedName(card, 'Cynthia'), 'Camilla');
  assert.equal(suggestTranslatedLine(card, 'Cynthia', '119/156'), 'Camilla - 119/156');
  assert.equal(suggestTranslatedLine({ name: 'Cynthia' }, 'Cynthia', '119/156'), '');
});

test('Japanese Tag Team GX titles match western GX names', () => {
  assert.equal(sanitizeCardName('Mega Lopunny & Jigglypuff Tag Team GX'), 'Mega Lopunny & Jigglypuff GX');
  assert.equal(sanitizeCardName('Lucario & MelmetalTag Team GX'), 'Lucario & Melmetal GX');
  assert.equal(sanitizeCardName('Mega Lopunny & Jigglypuff GX'), 'Mega Lopunny & Jigglypuff GX');
  assert.equal(
    displayName({ name: 'Mega Lopunny & Jigglypuff Tag Team GX' }),
    'Mega Lopunny & Jigglypuff GX',
  );
  assert.equal(
    sanitizeCardName('Sky Legend: Moltres & Zapdos & Articuno Tag Team GX Sleeves'),
    'Sky Legend: Moltres & Zapdos & Articuno Tag Team GX Sleeves',
  );
});

test('suggestKind classifies jumbo product type rows and name fallback', () => {
  assert.equal(suggestKind({ itemKind: 'single', productType: 'jumbo', name: 'Charizard GX' }), 'Jumbo');
  // Name/number fallback still catches rows predating the 083 stamp.
  assert.equal(suggestKind({ name: 'Charizard GX', number: 'Jumbo Oversized | 211' }), 'Jumbo');
  assert.equal(suggestKind({ name: 'Mimikyu', number: '042/094' }), 'Singles');
});
