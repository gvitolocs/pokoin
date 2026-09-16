import assert from 'node:assert/strict';
import test from 'node:test';
import { cardStubFromRoute, leftoverCdnId, leftoverUrlFromCard, mergeDeskCard, parseMarketplaceCardSlug, preferCatalogName, preferCatalogNumber, realPublicCardId, expandProvisionalCardIds, normalizeRecentCardIds, rewriteCanonicalCardPath } from './card-stub.js';

test('SVP promo slug keeps Pikachu, not Illustration Contest in the title', () => {
  const parsed = parseMarketplaceCardSlug(
    'card-pikachu-illustration-contest-2024-svp-214-sv-black-star-promos',
  );
  assert.equal(parsed.name, 'Pikachu');
  assert.equal(parsed.nameSlug, 'pikachu');
  assert.equal(parsed.rarity, 'Illustration Contest 2024');
  assert.equal(parsed.number, 'SVP 214');
  assert.equal(parsed.set, 'SV Black Star Promos');
  const stub = cardStubFromRoute({
    cardId: '643450',
    lang: 'en',
    slug: 'card-pikachu-illustration-contest-2024-svp-214-sv-black-star-promos',
  });
  assert.equal(stub.name, 'Pikachu');
  assert.equal(stub.number, 'Illustration Contest 2024 | SVP 214');
  assert.equal(stub.heroImageUrl, '/card-images/321725_pikachu.jpg');
});

test('MEP promo slug keeps Quaxly and MEP Black Star Promos', () => {
  const parsed = parseMarketplaceCardSlug('card-quaxly-mep-063-mep-black-star-promos');
  assert.equal(parsed.name, 'Quaxly');
  assert.equal(parsed.nameSlug, 'quaxly');
  assert.equal(parsed.number, 'MEP 063');
  assert.equal(parsed.set, 'MEP Black Star Promos');
  const stub = cardStubFromRoute({
    cardId: '791574',
    lang: 'en',
    slug: 'card-quaxly-mep-063-mep-black-star-promos',
  });
  assert.equal(stub.name, 'Quaxly');
  assert.equal(stub.heroImageUrl, '/card-images/395787_quaxly.jpg');
});

test('desk identity prefers the catalog name and keeps emoji/artist on the card id', () => {
  assert.equal(
    preferCatalogName(
      'Pikachu Illustration Contest 2024 Svp 214 Sv Black Star Promos',
      'Pikachu',
    ),
    'Pikachu',
  );
  const merged = mergeDeskCard(
    { id: '643450', name: 'Pikachu Illustration Contest 2024 Svp 214 Sv Black Star Promos' },
    { id: '643450', name: 'Pikachu', emoji: '🐭 ⚡', artist: 'Kazuki Minami' },
  );
  assert.equal(merged.name, 'Pikachu');
  assert.equal(merged.emoji, '🐭 ⚡');
  assert.equal(merged.artist, 'Kazuki Minami');
  const reload = mergeDeskCard(
    { id: '643450', name: 'Pikachu', emoji: '🐭 ⚡', artist: 'Kazuki Minami' },
    { id: '643450', name: 'Pikachu Illustration Contest 2024 Svp 214 Sv Black Star Promos', emoji: '' },
  );
  assert.equal(reload.name, 'Pikachu');
  assert.equal(reload.emoji, '🐭 ⚡');
  assert.equal(reload.artist, 'Kazuki Minami');
  const firstPaint = mergeDeskCard(
    cardStubFromRoute({
      cardId: '643450',
      lang: 'en',
      slug: 'card-pikachu-illustration-contest-2024-svp-214-sv-black-star-promos',
    }),
    {
      id: '643450',
      name: 'Pikachu Illustration Contest 2024 Svp 214 Sv Black Star Promos',
      emoji: '🐭 ⚡',
      artist: 'Kazuki Minami',
    },
  );
  assert.equal(firstPaint.name, 'Pikachu');
  assert.equal(firstPaint.emoji, '🐭 ⚡');
  assert.equal(firstPaint.artist, 'Kazuki Minami');
  assert.equal(
    preferCatalogNumber('SVP 214', 'Illustration Contest 2024 | SVP 214'),
    'Illustration Contest 2024 | SVP 214',
  );
});

test('desk merge keeps the CLIP version from the card-page payload', () => {
  const fromPage = mergeDeskCard(
    cardStubFromRoute({
      cardId: '802368',
      lang: 'en',
      slug: 'card-quaxly-027-30th-p-30th-anniversary-celebration-first-partner-illustration-collection',
    }),
    { id: '802368', name: 'Quaxly', version: 'v791574', versionCount: 3 },
  );
  assert.equal(fromPage.version, 'v791574');
  const reload = mergeDeskCard(fromPage, { id: '802368', name: 'Quaxly', version: '' });
  assert.equal(reload.version, 'v791574');
});

test('Espurr URL slug is name + illustration rare + collector + set', () => {
  const parsed = parseMarketplaceCardSlug('card-espurr-illustration-rare-087-080-nihil-zero');
  assert.equal(parsed.name, 'Espurr');
  assert.equal(parsed.nameSlug, 'espurr');
  assert.equal(parsed.rarity, 'Illustration Rare');
  assert.equal(parsed.number, '087/080');
  assert.equal(parsed.set, 'Nihil Zero');
  const stub = cardStubFromRoute({
    cardId: '736062',
    lang: 'en',
    slug: 'card-espurr-illustration-rare-087-080-nihil-zero',
  });
  assert.equal(stub.name, 'Espurr');
  assert.equal(stub.heroImageUrl, '/card-images/368031_espurr.jpg');
  assert.equal(
    stub.canonicalPath,
    '/marketplace/en/cards/736062/card-espurr-illustration-rare-087-080-nihil-zero',
  );
});

test('empty collector slot in the slug is name + set, not one mashed title', () => {
  const parsed = parseMarketplaceCardSlug('card-eevee--pokemon-jungle');
  assert.equal(parsed.name, 'Eevee');
  assert.equal(parsed.nameSlug, 'eevee');
  assert.equal(parsed.number, '');
  assert.equal(parsed.set, 'Pokemon Jungle');
  const stub = cardStubFromRoute({
    cardId: '281978',
    lang: 'en',
    slug: 'card-eevee--pokemon-jungle',
  });
  assert.equal(stub.name, 'Eevee');
  assert.equal(stub.set, 'Pokemon Jungle');
  assert.equal(stub.number, '');
});

test('Gambler slug has collector + set and no rarity token', () => {
  const parsed = parseMarketplaceCardSlug('card-gambler-060-062-fossil');
  assert.equal(parsed.name, 'Gambler');
  assert.equal(parsed.number, '060/062');
  assert.equal(parsed.set, 'Fossil');
  assert.equal(parsed.rarity, '');
  const stub = cardStubFromRoute({ cardId: '239324', slug: 'card-gambler-060-062-fossil' });
  assert.equal(stub.heroImageUrl, '/card-images/119662_gambler.jpg');
});

test('Urshifu JP set-code before full-art does not leak into the leftover stem', () => {
  const parsed = parseMarketplaceCardSlug(
    'card-rapid-strike-urshifu-v-cs3bc-full-art-139-122-cs3b-primordial-martial-arts-torrent',
  );
  assert.equal(parsed.name, 'Rapid Strike Urshifu V');
  assert.equal(parsed.nameSlug, 'rapid-strike-urshifu-v');
  assert.equal(parsed.rarity, 'Full Art');
  assert.equal(parsed.number, '139/122');
  const stub = cardStubFromRoute({
    cardId: '737678',
    slug: 'card-rapid-strike-urshifu-v-cs3bc-full-art-139-122-cs3b-primordial-martial-arts-torrent',
  });
  assert.equal(stub.heroImageUrl, '/card-images/368839_rapid-strike-urshifu-v.jpg');
});

test('possessive names round-trip from the catalog slug, not "Arven S"', () => {
  const parsed = parseMarketplaceCardSlug(
    'card-arven-s-mabosstiff-ex-273-167-csv10c-chasing-glory',
  );
  assert.equal(parsed.name, "Arven's Mabosstiff ex");
  assert.equal(parsed.nameSlug, 'arven-s-mabosstiff-ex');
  assert.equal(parsed.number, '273/167');
  assert.equal(parsed.set, 'Csv10c Chasing Glory');
  const stub = cardStubFromRoute({
    cardId: '123',
    slug: 'card-arven-s-mabosstiff-ex-273-167-csv10c-chasing-glory',
  });
  assert.equal(stub.name, "Arven's Mabosstiff ex");
});

test('canonical rarity-first slug keeps the catalog name, not rarity + Arven S', () => {
  const parsed = parseMarketplaceCardSlug(
    'special-illustration-rare-arven-s-mabosstiff-ex-235-182-destined-rivals',
  );
  assert.equal(parsed.name, "Arven's Mabosstiff ex");
  assert.equal(parsed.nameSlug, 'arven-s-mabosstiff-ex');
  assert.equal(parsed.rarity, 'Special Illustration Rare');
  assert.equal(parsed.number, '235/182');
  assert.equal(parsed.set, 'Destined Rivals');
});

test('numeric id without a slug still paints leftover art by ct_id', () => {
  const stub = cardStubFromRoute({ cardId: '736062', lang: 'en' });
  assert.equal(stub.id, '736062');
  assert.equal(stub.canonicalPath, '/marketplace/en/cards/736062');
  assert.equal(stub.heroImageUrl, '/card-images/368031_.jpg');
  const juniper = cardStubFromRoute({ cardId: '684712', lang: 'en' });
  assert.equal(juniper.heroImageUrl, '/card-images/342356_.jpg');
  assert.equal(cardStubFromRoute({ cardId: 'nope' }), null);
});

test('leftoverUrlFromCard uses leftover ct_id (public / 2), never the public id', () => {
  assert.equal(leftoverCdnId('741502'), '370751');
  assert.equal(leftoverCdnId('245292'), '122646');
  assert.equal(leftoverCdnId('61323'), '61323');
  assert.equal(
    leftoverUrlFromCard({
      id: '741502',
      name: 'Mega Lucario ex',
      canonicalPath: '/marketplace/en/cards/741502/card-mega-lucario-ex-ultra-rare-113-217-ascended-heroes',
    }),
    '/card-images/370751_mega-lucario-ex.jpg',
  );
});

test('gold-secret-rare does not leave -gold on the leftover stem', () => {
  const parsed = parseMarketplaceCardSlug(
    'card-mega-lucario-ex-gold-secret-rare-188-132-mega-evolution',
  );
  assert.equal(parsed.nameSlug, 'mega-lucario-ex');
  assert.equal(parsed.rarity, 'Gold Secret Rare');
  assert.equal(parsed.number, '188/132');
  assert.equal(
    leftoverUrlFromCard({
      id: '703382',
      name: 'Mega Lucario ex',
      canonicalPath: '/marketplace/en/cards/703382/card-mega-lucario-ex-gold-secret-rare-188-132-mega-evolution',
    }),
    '/card-images/351691_mega-lucario-ex.jpg',
  );
});

test('id-only canonical path uses the card name, not id_id.jpg', () => {
  assert.equal(
    leftoverUrlFromCard({
      id: '703382',
      name: 'Mega Lucario ex',
      canonicalPath: '/marketplace/en/cards/703382',
    }),
    '/card-images/351691_mega-lucario-ex.jpg',
  );
});

test('holo-rare does not leak into the leftover stem', () => {
  const parsed = parseMarketplaceCardSlug(
    'card-silvally-holo-rare-070-084-pitch-black',
  );
  assert.equal(parsed.nameSlug, 'silvally');
  assert.equal(parsed.rarity, 'Holo Rare');
  assert.equal(parsed.number, '070/084');
  assert.equal(
    leftoverUrlFromCard({
      id: '798832',
      name: 'Silvally',
      canonicalPath: '/marketplace/en/cards/798832/card-silvally-holo-rare-070-084-pitch-black',
    }),
    '/card-images/399416_silvally.jpg',
  );
});

test('theme-deck cosmos-holo / non-holo tails do not leak into the leftover stem', () => {
  const cosmos = parseMarketplaceCardSlug(
    'card-tyrantrum-cosmos-holo-045-088-theme-deck-blisters-exclusives',
  );
  assert.equal(cosmos.nameSlug, 'tyrantrum');
  assert.equal(cosmos.rarity, 'Cosmos Holo');
  assert.equal(cosmos.number, '045/088');
  assert.equal(
    leftoverUrlFromCard({
      id: '805892',
      name: 'Tyrantrum',
      canonicalPath: '/marketplace/en/cards/805892/card-tyrantrum-cosmos-holo-045-088-theme-deck-blisters-exclusives',
    }),
    '/card-images/402946_tyrantrum.jpg',
  );
  const nonHolo = parseMarketplaceCardSlug(
    'card-chi-yu-non-holo-059-084-theme-deck-blisters-exclusives',
  );
  assert.equal(nonHolo.nameSlug, 'chi-yu');
  assert.equal(nonHolo.rarity, 'Non Holo');
  assert.equal(
    leftoverUrlFromCard({
      id: '799652',
      name: 'Chi-Yu',
      canonicalPath: '/marketplace/en/cards/799652/card-chi-yu-non-holo-059-084-theme-deck-blisters-exclusives',
    }),
    '/card-images/399826_chi-yu.jpg',
  );
});

test('canonical card paths keep the title-language segment', () => {
  assert.equal(
    rewriteCanonicalCardPath(
      '/marketplace/en/cards/221412/card-pikachu-48-162-breakthrough',
      '221412',
      'it',
    ),
    '/marketplace/it/cards/221412/card-pikachu-48-162-breakthrough',
  );
});

test('999 Storm Emeralda placeholders rewrite to leftover × 2', () => {
  assert.equal(realPublicCardId('999806370'), '806370');
  assert.equal(realPublicCardId('806370'), '806370');
  assert.equal(realPublicCardId('999806068'), '806068');
  assert.deepEqual(expandProvisionalCardIds(['999806370']), ['806370', '999806370']);
  assert.deepEqual(normalizeRecentCardIds(['999806370', '806370', '703382']), ['806370', '703382']);
  assert.equal(
    rewriteCanonicalCardPath(
      '/marketplace/en/cards/999806370/card-zinnia-s-trust-ultra-rare-102-076-storm-emeralda',
      '999806370',
    ),
    '/marketplace/en/cards/806370/card-zinnia-s-trust-ultra-rare-102-076-storm-emeralda',
  );
});
