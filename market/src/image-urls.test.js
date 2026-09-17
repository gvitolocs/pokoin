import assert from 'node:assert/strict';
import test from 'node:test';
import { leftoverUrlFromCard } from './card-stub.js';
import { catalogSlugMatchesCard, homepageDerivativeUrl, homepageMatchesCatalog, leftoverKeyMatchesCard, ownCatalogImage, preferFullImage, rasterSiblings, rewriteCatalogImageId } from './image-urls.js';

test('Scarlet Violet 312px leftovers bust after CardTrader full ingest', () => {
  assert.equal(
    preferFullImage('https://cdn.pokoin.com/241905_magnemite-063-198-scarlet-violet.jpg'),
    '/card-images/241905_magnemite-063-198-scarlet-violet.jpg?v=sv312',
  );
  assert.equal(
    homepageDerivativeUrl('/card-images/241905_magnemite-063-198-scarlet-violet.jpg'),
    '/card-images/241905_magnemite-063-198-scarlet-violet_homepage.webp?v=sv312',
  );
});

test('Chilling Reign Rapidash V leftover busts the 255px catalog thumb', () => {
  assert.equal(
    preferFullImage('https://cdn.pokoin.com/158374_galarian-rapidash-v-rare-ultra-168-198-chilling-reign.jpg'),
    '/card-images/158374_galarian-rapidash-v-rare-ultra-168-198-chilling-reign.jpg?v=ctf1',
  );
  assert.equal(
    homepageDerivativeUrl('/card-images/158374_galarian-rapidash-v-rare-ultra-168-198-chilling-reign.jpg'),
    '/card-images/158374_galarian-rapidash-v-rare-ultra-168-198-chilling-reign_homepage.webp?v=ctf1',
  );
});

test('Shiny Treasure ex 255px leftovers bust after CardTrader full ingest', () => {
  assert.equal(
    preferFullImage('https://cdn.pokoin.com/269648_natu-078-190-shiny-treasure-ex.jpg'),
    '/card-images/269648_natu-078-190-shiny-treasure-ex.jpg?v=ctf1',
  );
});

test('Vivid Voltage leftovers bust orange-cloud cache after CardTrader ingest', () => {
  assert.equal(
    preferFullImage('https://cdn.pokoin.com/150266_zarude-v-022-185-vivid-voltage.jpg'),
    '/card-images/150266_zarude-v-022-185-vivid-voltage.jpg?v=vv1',
  );
  assert.equal(
    homepageDerivativeUrl('https://cdn.pokoin.com/150266_zarude-v-022-185-vivid-voltage.jpg'),
    '/card-images/150266_zarude-v-022-185-vivid-voltage_homepage.webp?v=vv1',
  );
  assert.equal(
    preferFullImage('https://cdn.pokoin.com/351691_mega-lucario-ex.jpg'),
    '/card-images/351691_mega-lucario-ex.jpg',
  );
});

test('Chaos Rising leftovers bust cache after CardTrader placeholder ingest', () => {
  assert.equal(
    preferFullImage('https://cdn.pokoin.com/389942_weedle-001-086-chaos-rising.jpg'),
    '/card-images/389942_weedle-001-086-chaos-rising.jpg?v=cr2',
  );
  assert.equal(
    homepageDerivativeUrl('/card-images/389942_weedle-001-086-chaos-rising.jpg'),
    '/card-images/389942_weedle-001-086-chaos-rising_homepage.webp?v=cr2',
  );
});

test('World Championship Decks 2025 leftovers bust cache after PNG ingest', () => {
  assert.equal(
    preferFullImage('https://cdn.pokoin.com/385547_air-balloon-wcd-2025-liao-fu-guan-world-championship-decks-2025.jpg'),
    '/card-images/385547_air-balloon-wcd-2025-liao-fu-guan-world-championship-decks-2025.jpg?v=wcd25',
  );
  assert.equal(
    homepageDerivativeUrl('/card-images/385525_fan-rotom-wcd-2025-yuya-okita-world-championship-decks-2025.jpg'),
    '/card-images/385525_fan-rotom-wcd-2025-yuya-okita-world-championship-decks-2025_homepage.webp?v=wcd25',
  );
});

test('Battle Party and SV-P Chinese leftovers bust cache after CardTrader webp ingest', () => {
  assert.equal(
    preferFullImage('https://cdn.pokoin.com/373736_pikachu-csmpd-001-021-csmpdc-battle-party-combo-lightning-deck.jpg'),
    '/card-images/373736_pikachu-csmpd-001-021-csmpdc-battle-party-combo-lightning-deck.jpg?v=ph2',
  );
  assert.equal(
    homepageDerivativeUrl('https://cdn.pokoin.com/379040_fletchinder-022-svp-scarlet-violet-simplified-chinese-promos.jpg'),
    '/card-images/379040_fletchinder-022-svp-scarlet-violet-simplified-chinese-promos_homepage.webp?v=ph2',
  );
});

test('CardTrader 186×260 leftover backs bust cache after Pokoin missing-card stamp', () => {
  assert.equal(
    preferFullImage('https://cdn.pokoin.com/286874_fighting-energy-unnumbered-latios-ex-half-deck.jpg'),
    '/card-images/286874_fighting-energy-unnumbered-latios-ex-half-deck.jpg?v=pkph1',
  );
  assert.equal(
    homepageDerivativeUrl('/card-images/286874_fighting-energy-unnumbered-latios-ex-half-deck.jpg'),
    '/card-images/286874_fighting-energy-unnumbered-latios-ex-half-deck_homepage.webp?v=pkph1',
  );
});

test('rescanned Latios desk rewrites its public id and busts the placeholder cache', () => {
  const card = {
    id: '573732',
    name: 'Latios ex',
    canonicalPath: '/marketplace/en/cards/573732/card-latios-ex-holo-rare-011-018-latios-ex-half-deck',
  };
  assert.equal(
    ownCatalogImage(
      card,
      '/card-images/573732_latios-ex-holo-rare-011-018-latios-ex-half-deck.jpg',
    ),
    '/card-images/286866_latios-ex-holo-rare-011-018-latios-ex-half-deck.jpg?v=rscan1',
  );
});

test('CSM2d Shining Synergy leftovers bust cache after placeholder ingest', () => {
  assert.equal(
    preferFullImage('https://cdn.pokoin.com/373219_latios-csm2d-120-342-csm2d-shining-synergy-gx-starter-deck.jpg'),
    '/card-images/373219_latios-csm2d-120-342-csm2d-shining-synergy-gx-starter-deck.jpg?v=ph1',
  );
  assert.equal(
    homepageDerivativeUrl('/card-images/373219_latios-csm2d-120-342-csm2d-shining-synergy-gx-starter-deck.jpg'),
    '/card-images/373219_latios-csm2d-120-342-csm2d-shining-synergy-gx-starter-deck_homepage.webp?v=ph1',
  );
});

test('Team Up Charizard 397269 busts the pokemontcg.io leftover after CardTrader scan', () => {
  assert.equal(
    preferFullImage('https://cdn.pokoin.com/397269_charizard.jpg'),
    '/card-images/397269_charizard.jpg?v=ct397',
  );
  assert.equal(
    homepageDerivativeUrl('/card-images/397269_charizard.jpg'),
    '/card-images/397269_charizard_homepage.webp?v=ct397',
  );
});

test('Base Set leftovers bust 1st Edition / shadowless scans after unlimited reimport', () => {
  assert.equal(
    preferFullImage('https://cdn.pokoin.com/111151_charizard-holo-rare-4-102-base-set.jpg'),
    '/card-images/111151_charizard-holo-rare-4-102-base-set.jpg?v=bsu2',
  );
  assert.equal(
    homepageDerivativeUrl('https://cdn.pokoin.com/55595_abra-43-102-base-set.jpg'),
    '/card-images/55595_abra-43-102-base-set_homepage.webp?v=bsu2',
  );
});

test('grid tiles rewrite leftover JPEG to _homepage.webp', () => {
  const src = homepageDerivativeUrl('https://cdn.pokoin.com/351691_mega-lucario-ex.jpg?v=ct1');
  assert.equal(src, '/card-images/351691_mega-lucario-ex_homepage.webp?v=ct1');
  assert.deepEqual(rasterSiblings(src), [
    '/card-images/351691_mega-lucario-ex_homepage.webp?v=ct1',
    '/card-images/351691_mega-lucario-ex.jpg?v=ct1',
  ]);
});

test('existing homepage URLs are kept for grid', () => {
  assert.equal(
    homepageDerivativeUrl('/card-images/138045_koffing-jp-expansion-pack-starter-pack_homepage.webp'),
    '/card-images/138045_koffing-jp-expansion-pack-starter-pack_homepage.webp',
  );
});

test('hero JPEG is not upgraded to homepage webp', () => {
  assert.deepEqual(
    rasterSiblings('/card-images/351691_mega-lucario-ex.jpg?v=ct1'),
    ['/card-images/351691_mega-lucario-ex.jpg?v=ct1'],
  );
});

test('full raster prefers leftover JPEG then the leftover homepage tile', () => {
  assert.deepEqual(
    rasterSiblings('/card-images/703354_lillie-s-determination_homepage.webp', { full: true }),
    [
      '/card-images/703354_lillie-s-determination.jpg',
      '/card-images/703354_lillie-s-determination_homepage.webp',
    ],
  );
});

test('Juniper leftover 342356 keeps its own dump, not Pikachu V-UNION leftover/4', () => {
  const juniper = {
    id: '684712',
    name: "Professor's Research - Professor Juniper",
    canonicalPath: '/marketplace/en/cards/684712/card-professor-s-research-professor-juniper-085-086-black-bolt',
  };
  assert.equal(
    leftoverUrlFromCard(juniper),
    '/card-images/342356_professor-s-research-professor-juniper.jpg',
  );
  assert.deepEqual(
    rasterSiblings(leftoverUrlFromCard(juniper), { full: true }),
    [
      '/card-images/342356_professor-s-research-professor-juniper.jpg',
      '/card-images/342356_professor-s-research-professor-juniper_homepage.webp',
    ],
  );
});

test('preferFullImage strips homepage webp back to leftover JPEG', () => {
  assert.equal(
    preferFullImage('/card-images/703382_mega-lucario-ex_homepage.webp?v=ct1'),
    '/card-images/703382_mega-lucario-ex.jpg?v=ct1',
  );
});

test('One Piece and Riftbound keep png/webp masters', () => {
  assert.equal(
    preferFullImage('/card-images/one-piece/409179_sanji.png'),
    '/card-images/one-piece/409179_sanji.png',
  );
  assert.equal(
    preferFullImage('https://cdn.pokoin.com/riftbound/400791_seraphine-not-alone.webp'),
    '/card-images/riftbound/400791_seraphine-not-alone.webp',
  );
  assert.equal(
    preferFullImage('/card-images/competitive/sprites/dragapult.png'),
    '/card-images/competitive/sprites/dragapult.png',
  );
  assert.equal(
    preferFullImage('/card-images/351691_mega-lucario-ex.png'),
    '/card-images/351691_mega-lucario-ex.jpg',
  );
});

test('competitive rasters do not invent _homepage.webp', () => {
  assert.deepEqual(
    rasterSiblings('/card-images/competitive/scans/TWM_130_R_EN.png'),
    ['/card-images/competitive/scans/TWM_130_R_EN.png'],
  );
});

test('multigame desk tries png/webp siblings after a missing jpeg', () => {
  assert.deepEqual(
    rasterSiblings('/card-images/one-piece/409179_sanji.png', { full: true }),
    [
      '/card-images/one-piece/409179_sanji.png',
      '/card-images/one-piece/409179_sanji.jpg',
      '/card-images/one-piece/409179_sanji.webp',
    ],
  );
  assert.deepEqual(
    rasterSiblings('/card-images/riftbound/400791_seraphine-not-alone_homepage.webp', { full: true }),
    [
      '/card-images/riftbound/400791_seraphine-not-alone.jpg',
      '/card-images/riftbound/400791_seraphine-not-alone.png',
      '/card-images/riftbound/400791_seraphine-not-alone.webp',
    ],
  );
});

test('homepage slug must match leftover JPEG or it is a leftover/public-id collision', () => {
  assert.equal(
    homepageMatchesCatalog(
      '/card-images/241930_kirlia-212-198-scarlet-violet_homepage.webp',
      '/card-images/241930_pikachu-non-holo-trainer-kit-16-30-hs-trainer-kit-raichu.jpg',
    ),
    false,
  );
  assert.equal(
    homepageMatchesCatalog(
      '/card-images/587148_magcargo_homepage.webp',
      '/card-images/587148_magcargo.jpg',
    ),
    true,
  );
});

test('leftover key is leftover ct_id only — public-id prefixes collide', () => {
  assert.equal(leftoverKeyMatchesCard('/card-images/703072_mega-lucario-ex.jpg', '703072'), false);
  assert.equal(leftoverKeyMatchesCard('/card-images/351536_mega-lucario-ex.jpg', '703072'), true);
  assert.equal(leftoverKeyMatchesCard('/card-images/21971_mega-lucario-ex.jpg', '703072'), false);
  assert.equal(leftoverKeyMatchesCard('/card-images/one-piece/409179_sanji.png', '818358'), true);
  assert.equal(leftoverKeyMatchesCard('/card-images/806068_combee.jpg', '806068'), false);
  assert.equal(leftoverKeyMatchesCard('/card-images/403034_combee.jpg', '806068'), true);
  assert.equal(leftoverKeyMatchesCard('/card-images/703382_mega-lucario-ex.jpg?v=ct1', '703382'), false);
  assert.equal(leftoverKeyMatchesCard('/card-images/351691_mega-lucario-ex.jpg?v=ct1', '703382'), true);
  assert.equal(leftoverKeyMatchesCard('/card-images/245292_net-ball.jpg', '245292'), false);
  assert.equal(leftoverKeyMatchesCard('/card-images/122646_net-ball.jpg', '245292'), true);
  assert.equal(leftoverKeyMatchesCard('/card-images/241930_kirlia.jpg', '241930'), false);
});

test('ownCatalogImage rewrites preview_, public-id, and stale leftover keys to leftover ct_id', () => {
  const lucario = {
    id: '741502',
    name: 'Mega Lucario ex',
    canonicalPath: '/marketplace/en/cards/741502/card-mega-lucario-ex-ultra-rare-113-217-ascended-heroes',
  };
  assert.equal(
    ownCatalogImage(lucario, 'https://cardtrader.com/uploads/blueprints/image/370751/preview_mega-lucario-ex.jpg'),
    '/card-images/370751_mega-lucario-ex.jpg',
  );
  assert.equal(
    ownCatalogImage({
      id: '703072',
      name: 'Mega Lucario ex',
      canonicalPath: '/marketplace/en/cards/703072/card-mega-lucario-ex-ultra-rare-077-132-mega-evolution',
    }, '/card-images/21971_mega-lucario-ex.jpg'),
    '/card-images/351536_mega-lucario-ex.jpg',
  );
  assert.equal(
    ownCatalogImage({ id: '689316' }, '/card-images/689316_mega-lucario-ex.jpg'),
    '/card-images/344658_mega-lucario-ex.jpg',
  );
  assert.equal(
    ownCatalogImage({
      id: '703382',
      name: 'Mega Lucario ex',
      canonicalPath: '/marketplace/en/cards/703382',
    }, '/card-images/703382_mega-lucario-ex.jpg?v=ct1'),
    '/card-images/351691_mega-lucario-ex.jpg',
  );
  assert.equal(
    leftoverKeyMatchesCard('/card-images/61245_meloetta-104-214-lost-thunder.jpg', '244980'),
    false,
  );
  assert.equal(
    leftoverKeyMatchesCard('/card-images/61323_net-ball-187-214-lost-thunder.jpg', '245292'),
    false,
  );
  assert.equal(
    rewriteCatalogImageId('/card-images/245292_net-ball.jpg', '245292'),
    '/card-images/122646_net-ball.jpg',
  );
  assert.equal(
    ownCatalogImage({
      id: '244980',
      name: 'Meloetta',
      canonicalPath: '/marketplace/en/cards/244980/card-meloetta-104-214-lost-thunder',
    }, '/card-images/61245_meloetta-104-214-lost-thunder.jpg'),
    '/card-images/122490_meloetta-104-214-lost-thunder.jpg',
  );
  assert.equal(
    ownCatalogImage({
      id: '245292',
      name: 'Net Ball',
      canonicalPath: '/marketplace/en/cards/245292/card-net-ball-187-214-lost-thunder',
    }, '/card-images/61323_net-ball-187-214-lost-thunder.jpg'),
    '/card-images/122646_net-ball-187-214-lost-thunder.jpg',
  );
});

test('leftover prefix that is another card public id cannot keep that card slug', () => {
  const juniper = {
    id: '684712',
    name: "Professor's Research - Professor Juniper",
    canonicalPath: '/marketplace/en/cards/684712/card-professor-s-research-professor-juniper-085-086-black-bolt',
  };
  assert.equal(leftoverKeyMatchesCard('/card-images/342356_pikachu-v-union-139-promo-celebrations.jpg', '684712'), true);
  assert.equal(
    catalogSlugMatchesCard('/card-images/342356_pikachu-v-union-139-promo-celebrations.jpg', juniper),
    false,
  );
  assert.equal(
    ownCatalogImage(juniper, '/card-images/342356_pikachu-v-union-139-promo-celebrations.jpg'),
    '/card-images/342356_professor-s-research-professor-juniper.jpg',
  );
  assert.equal(
    ownCatalogImage(juniper, '/card-images/171178_professor-s-research-professor-juniper.jpg'),
    '/card-images/342356_professor-s-research-professor-juniper.jpg',
  );
});

test('League leftover dump slug can differ from the desk path and still count as this card', () => {
  const dusknoir = {
    id: '257442',
    name: 'Dusknoir FB Lv.50',
    canonicalPath: '/marketplace/en/cards/257442/card-dusknoir-fb-lv-50-pokemon-league-26-147-supreme-victors-promos',
  };
  assert.equal(
    leftoverUrlFromCard(dusknoir),
    '/card-images/128721_dusknoir-fb-lv-50-pokemon-league.jpg',
  );
  assert.equal(
    ownCatalogImage(dusknoir, '/card-images/128721_dusknoir-fb-pokemon-league-26-147-supreme-victors-promos.jpg'),
    '/card-images/128721_dusknoir-fb-pokemon-league-26-147-supreme-victors-promos.jpg',
  );
});
