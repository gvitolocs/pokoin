const assert = require('node:assert/strict');
const test = require('node:test');

const {
  artistCardsForSlug,
  artistCoverTier,
  artistProfileFromRow,
  artistSummaries,
  leftoverArtistImage,
  lookupAliasesForArtistName,
  normalizeArtistLookupName,
  normalizeArtistSlug,
  pickArtistCover,
  slugAliasesForArtistSlug,
  projectedRaritySql,
} = require('./marketplace-artist-cards');

test('artist endpoint normalizes URL slug and raw artist lookup keys', () => {
  assert.equal(normalizeArtistSlug('Raita Kazama'), 'raita-kazama');
  assert.equal(normalizeArtistSlug(' raita_kazama!! '), 'raita-kazama');
  assert.equal(normalizeArtistSlug('Narumi Sato'), 'narumi-sato');
  assert.equal(normalizeArtistLookupName('Raita-Kazama'), 'raita kazama');
  assert.equal(normalizeArtistLookupName('  Raita   Kazama  '), 'raita kazama');
  assert.equal(normalizeArtistLookupName('Narumi-Sato'), 'narumi sato');
});

test('artist endpoint keeps Pikachu Project slug aliases compatible', async () => {
  assert.deepEqual(lookupAliasesForArtistName('Pikachu Project'), [
    'pikachu project',
    '2017 pikachu project',
    'pikachu project 2017',
  ]);
  assert.deepEqual(slugAliasesForArtistSlug('2017-pikachu-project'), [
    '2017-pikachu-project',
    'pikachu-project-2017',
  ]);
  assert.deepEqual(slugAliasesForArtistSlug('pikachu-project'), [
    'pikachu-project',
    '2017-pikachu-project',
    'pikachu-project-2017',
  ]);
  assert.deepEqual(slugAliasesForArtistSlug('pikachu-project-2017'), [
    'pikachu-project-2017',
    '2017-pikachu-project',
  ]);

  const queries = [];
  const payload = await artistCardsForSlug({
    artistSlug: 'pikachu-project',
    limit: 5,
    overlayCheapest: async (rows) => rows,
    query: async (sql, values) => {
      queries.push({ sql, values });
      return {
        rows: [
          {
            card_id: '123',
            name: 'Pikachu',
            expansion_name: 'Promo',
            expansion_number: 'SM-P',
            blueprint_id: '123',
            preview_image_url: 'https://cdn.pokoin.test/pikachu.webp',
            artist: '2017 Pikachu Project',
            illustrator: '2017 Pikachu Project',
            normalized_artist: '2017 pikachu project',
            artist_slug: '2017-pikachu-project',
            artist_card_count: 7,
            total_artist_card_count: 7,
          },
        ],
      };
    },
  });

  assert.match(queries[0].sql, /any\(\$1::text\[\]\)/);
  assert.deepEqual(queries[0].values, [
    ['pikachu-project', '2017-pikachu-project', 'pikachu-project-2017'],
    5,
  ]);
  assert.equal(payload.artist.name, 'Pikachu Project');
  assert.equal(payload.artist.normalizedArtist, '2017 pikachu project');
  assert.equal(payload.artist.slug, '2017-pikachu-project');
  assert.equal(payload.profile.displayName, 'Pikachu Project');
  assert.equal(payload.cards[0].artist, 'Pikachu Project');
  assert.equal(payload.cards[0].normalized_artist, '2017 pikachu project');
});

test('artist endpoint resolves Tomokazu Komiya slug without aliases', async () => {
  assert.deepEqual(lookupAliasesForArtistName('Tomokazu Komiya'), [
    'tomokazu komiya',
  ]);
  assert.deepEqual(slugAliasesForArtistSlug('tomokazu-komiya'), [
    'tomokazu-komiya',
  ]);

  const queries = [];
  const payload = await artistCardsForSlug({
    artistSlug: 'tomokazu-komiya',
    limit: 300,
    overlayCheapest: async (rows) => rows,
    query: async (sql, values) => {
      queries.push({ sql, values });
      return {
        rows: [
          {
            card_id: '261118',
            name: 'Gastly',
            expansion_name: '151',
            expansion_number: '092/165',
            blueprint_id: '261118',
            preview_image_url: 'https://cdn.pokoin.test/gastly.webp',
            artist: 'Tomokazu Komiya',
            illustrator: 'Tomokazu Komiya',
            normalized_artist: 'tomokazu komiya',
            artist_slug: 'tomokazu-komiya',
            artist_card_count: 0,
            total_artist_card_count: 261,
          },
        ],
      };
    },
  });

  assert.deepEqual(queries[0].values, [['tomokazu-komiya'], 300]);
  assert.match(queries[0].sql, /marketplace_leftover_art_layouts/);
  assert.match(queries[0].sql, /pokoin_version_sets/);
  assert.match(queries[0].sql, /nullif\(candidates\.version, ''\) as version/);
  assert.match(queries[0].sql, /candidates\.pokedex_sort/);
  assert.match(queries[0].sql, /order by\s+candidates\.pokedex_sort asc nulls last/i);
  assert.equal(payload.artist.name, 'Tomokazu Komiya');
  assert.equal(payload.artist.normalizedArtist, 'tomokazu komiya');
  assert.equal(payload.artist.slug, 'tomokazu-komiya');
  assert.equal(payload.artist.cardCount, 261);
  assert.equal(payload.cards[0].artist, 'Tomokazu Komiya');
});

test('artist cards overlay listed PKN from cheapest_homepage_cache_blueprint', async () => {
  const payload = await artistCardsForSlug({
    artistSlug: 'tomokazu-komiya',
    limit: 5,
    overlayCheapest: async (rows) => rows.map((row) => (
      String(row.card_id) === '522236'
        ? { ...row, lowest_price_pkn: 226, listed_quantity: 103, has_cardtrader_listing: true }
        : row
    )),
    query: async () => ({
      rows: [
        {
          card_id: '522236',
          name: 'Gastly',
          expansion_name: '151',
          expansion_number: '092/165',
          blueprint_id: '261118',
          artist: 'Tomokazu Komiya',
          illustrator: 'Tomokazu Komiya',
          normalized_artist: 'tomokazu komiya',
          artist_slug: 'tomokazu-komiya',
          artist_card_count: 250,
          total_artist_card_count: 250,
        },
      ],
    }),
  });

  assert.equal(payload.cards[0].lowest_price_pkn, 226);
  assert.equal(payload.cards[0].has_cardtrader_listing, true);
});

test('artist cards include expansion nationality for print chips', async () => {
  const queries = [];
  const payload = await artistCardsForSlug({
    artistSlug: 'sui',
    limit: 5,
    overlayCheapest: async (rows) => rows,
    query: async (sql, values) => {
      queries.push({ sql, values });
      return {
        rows: [
          {
            card_id: '1',
            name: 'Jolteon',
            expansion_name: '151',
            expansion_number: '051/165',
            nationality: 'western',
            artist: 'sui',
            illustrator: 'sui',
            normalized_artist: 'sui',
            artist_slug: 'sui',
            artist_card_count: 2,
            total_artist_card_count: 2,
          },
        ],
      };
    },
  });

  assert.match(queries[0].sql, /expansions\.nationality/);
  assert.match(queries[0].sql, /min\(nationality\) as nationality/);
  assert.equal(payload.cards[0].nationality, 'western');
});

test('artist card lookup filters by normalized artist slug and preserves card rows', async () => {
  const queries = [];
  const payload = await artistCardsForSlug({
    artistSlug: 'Raita Kazama',
    limit: 5,
    overlayCheapest: async (rows) => rows,
    query: async (sql, values) => {
      queries.push({ sql, values });
      return {
        rows: [
          {
            card_id: '370923',
            name: "N's Zoroark ex",
            expansion_name: 'Ascended Heroes',
            expansion_number: '',
            blueprint_id: '370923',
            canonical_path:
              '/marketplace/en/cards/741846/card-n-s-zoroark-ex-ascended-heroes',
            preview_image_url: 'https://cdn.pokoin.test/zoroark.webp',
            artist: 'Raita Kazama',
            illustrator: 'Raita Kazama',
            normalized_artist: 'raita kazama',
            artist_slug: 'raita-kazama',
            artist_card_count: 0,
            total_artist_card_count: 2,
            profile_display_name: 'Raita Kazama',
            profile_summary: 'Japanese illustrator.',
            profile_bio: 'Illustrator known for dynamic Pokemon card art.',
            profile_image_url: 'https://example.test/raita.jpg',
            profile_image_cdn_url: 'https://cdn.pokoin.test/artists/raita.webp',
            profile_image_object_key: 'artist-profiles/raita-kazama.webp',
            profile_pocketmonsters_url: 'https://www.pocketmonsters.net/staff/view/7159',
            profile_pocketmonsters_id: '7159',
            profile_bulbapedia_url: 'https://bulbapedia.bulbagarden.net/wiki/Raita_Kazama',
            profile_bulbapedia_title: 'Raita Kazama',
            profile_source_name: 'PocketMonsters.Net + Bulbapedia',
            profile_source_url: 'https://www.pocketmonsters.net/staff/view/7159',
            profile_source_attribution: {
              pocketmonsters: {
                name: 'PocketMonsters.Net',
                url: 'https://www.pocketmonsters.net/staff/view/7159',
              },
              bulbapedia: {
                name: 'Bulbapedia',
                url: 'https://bulbapedia.bulbagarden.net/wiki/Raita_Kazama',
                license: 'CC BY-NC-SA',
              },
            },
          },
        ],
      };
    },
  });

  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /marketplace_blueprint_artists/);
  assert.match(queries[0].sql, /marketplace_card_versions/);
  assert.match(queries[0].sql, /marketplace_card_urls urls/);
  assert.match(queries[0].sql, /urls\.canonical_path/);
  assert.match(queries[0].sql, /total_artist_card_count/);
  assert.match(queries[0].sql, /blueprints\.id = versions\.ct_id/);
  assert.match(queries[0].sql, /tcg_metadata\.card_id = versions\.card_id/);
  assert.match(queries[0].sql, /tcg_metadata\.blueprint_id = versions\.ct_id/);
  assert.doesNotMatch(queries[0].sql, /blueprints\.id = versions\.card_id/);
  assert.doesNotMatch(queries[0].sql, /tcg_metadata\.blueprint_id = versions\.card_id/);
  assert.deepEqual(queries[0].values, [['raita-kazama'], 5]);
  assert.deepEqual(payload.artist, {
    name: 'Raita Kazama',
    illustrator: 'Raita Kazama',
    normalizedArtist: 'raita kazama',
    slug: 'raita-kazama',
    cardCount: 2,
  });
  assert.deepEqual(payload.profile, {
    displayName: 'Raita Kazama',
    summary: 'Japanese illustrator.',
    bio: 'Illustrator known for dynamic Pokemon card art.',
    imageUrl: 'https://cdn.pokoin.test/artists/raita.webp',
    sourceImageUrl: 'https://example.test/raita.jpg',
    imageObjectKey: 'artist-profiles/raita-kazama.webp',
    pocketmonstersUrl: 'https://www.pocketmonsters.net/staff/view/7159',
    pocketmonstersId: '7159',
    bulbapediaUrl: 'https://bulbapedia.bulbagarden.net/wiki/Raita_Kazama',
    bulbapediaTitle: 'Raita Kazama',
    sourceName: 'PocketMonsters.Net + Bulbapedia',
    sourceUrl: 'https://www.pocketmonsters.net/staff/view/7159',
    sourceAttribution: {
      pocketmonsters: {
        name: 'PocketMonsters.Net',
        url: 'https://www.pocketmonsters.net/staff/view/7159',
      },
      bulbapedia: {
        name: 'Bulbapedia',
        url: 'https://bulbapedia.bulbagarden.net/wiki/Raita_Kazama',
        license: 'CC BY-NC-SA',
      },
    },
    generatedProfileImage: {},
  });
  assert.equal(payload.cards.length, 1);
  assert.equal(payload.cards[0].card_id, '370923');
  assert.equal(
    payload.cards[0].canonical_path,
    '/marketplace/en/cards/741846/card-n-s-zoroark-ex-ascended-heroes',
  );
});

test('artist card lookup resolves Narumi Sato canonical slug', async () => {
  const queries = [];
  const payload = await artistCardsForSlug({
    artistSlug: 'narumi-sato',
    limit: 10,
    overlayCheapest: async (rows) => rows,
    query: async (sql, values) => {
      queries.push({ sql, values });
      return {
        rows: [
          {
            card_id: '409489',
            name: 'Pikachu',
            expansion_name: 'Test Expansion',
            expansion_number: '025/100',
            blueprint_id: '409489',
            preview_image_url: 'https://cdn.pokoin.test/narumi-pikachu.webp',
            artist: 'Narumi Sato',
            illustrator: 'Narumi Sato',
            normalized_artist: 'narumi sato',
            artist_slug: 'narumi-sato',
            artist_card_count: 3,
            total_artist_card_count: 3,
            profile_display_name: 'Narumi Sato',
          },
        ],
      };
    },
  });

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].values, [['narumi-sato'], 10]);
  assert.deepEqual(payload.artist, {
    name: 'Narumi Sato',
    illustrator: 'Narumi Sato',
    normalizedArtist: 'narumi sato',
    slug: 'narumi-sato',
    cardCount: 3,
  });
  assert.equal(payload.profile.displayName, 'Narumi Sato');
  assert.equal(payload.cards[0].artist, 'Narumi Sato');
  assert.equal(payload.cards[0].normalized_artist, 'narumi sato');
});

test('artist card lookup projects illustration rarity from collector labels', async () => {
  const payload = await artistCardsForSlug({
    artistSlug: 'Mitsuhiro Arita',
    limit: 5,
    overlayCheapest: async (rows) => rows,
    query: async (sql, values) => {
      assert.match(sql, /split_part/);
      assert.match(sql, /as rarity/);
      assert.deepEqual(values, [['mitsuhiro-arita'], 5]);
      return {
        rows: [
          {
            card_id: '261310',
            name: 'Squirtle',
            expansion_name: '151',
            expansion_number: 'Illustration Rare | 170/165',
            blueprint_id: '261310',
            preview_image_url: 'https://cdn.pokoin.test/squirtle.webp',
            artist: 'Mitsuhiro Arita',
            illustrator: 'Mitsuhiro Arita',
            normalized_artist: 'mitsuhiro arita',
            artist_slug: 'mitsuhiro-arita',
            artist_card_count: 768,
            total_artist_card_count: 768,
            rarity: 'Illustration Rare',
          },
        ],
      };
    },
  });

  assert.equal(payload.cards[0].rarity, 'Illustration Rare');
});

test('projected rarity SQL derives rarity from collector labels when stored rarity is generic', () => {
  const sql = projectedRaritySql({
    rarityColumn: 'candidates.rarity',
    collectorNumberSql: 'versions.expansion_number',
  });

  assert.match(sql, /split_part\(versions\.expansion_number, '\|', 1\)/);
  assert.match(sql, /lower\(candidates\.rarity\) = 'card'/);
  assert.match(sql, /sourceCard,rarity/);
});

test('artist profile row mapping is stable with empty profile fields', () => {
  assert.deepEqual(artistProfileFromRow({}), {
    displayName: '',
    summary: '',
    bio: '',
    imageUrl: '',
    sourceImageUrl: '',
    imageObjectKey: '',
    pocketmonstersUrl: '',
    pocketmonstersId: '',
    bulbapediaUrl: '',
    bulbapediaTitle: '',
    sourceName: '',
    sourceUrl: '',
    sourceAttribution: {},
    generatedProfileImage: {},
  });
});

test('artist profile row mapping does not duplicate summary into bio', () => {
  const profile = artistProfileFromRow({
    profile_summary:
      'You Iribi is an illustrator for the Pokémon Trading Card Game.',
    profile_bio: '',
  });

  assert.equal(
    profile.summary,
    'You Iribi is an illustrator for the Pokémon Trading Card Game.',
  );
  assert.equal(profile.bio, '');
});

test('artist profile row mapping rewrites blocked CDN profile images', () => {
  const profile = artistProfileFromRow({
    profile_image_cdn_url: 'https://cdn.pokoin.com/artist-profiles/shin-nagasawa.png',
    profile_image_url: 'https://media.pocketmonsters.net/staff/6960/main.png/t/250.png',
  });

  assert.equal(
    profile.imageUrl,
    'https://pokoin.com/card-images/artist-profiles/shin-nagasawa.png',
  );
  assert.equal(
    profile.sourceImageUrl,
    'https://media.pocketmonsters.net/staff/6960/main.png/t/250.png',
  );
});

test('artist profile row mapping exposes generated card art attribution', () => {
  const profile = artistProfileFromRow({
    profile_image_cdn_url: 'https://pokoin.com/card-images/artist-profiles/aky-cg-works.png',
    profile_source_attribution: {
      generatedProfileImage: {
        source: 'card_art_fallback',
        reason: 'placeholder_profile_image',
        generatedAt: '2026-05-25T20:07:53.194Z',
        sourceCard: {
          cardId: '123',
          name: 'Pikachu ex',
          rarity: 'Illustration Rare',
        },
      },
    },
  });

  assert.equal(
    profile.imageUrl,
    'https://pokoin.com/card-images/artist-profiles/aky-cg-works.png?v=2026-05-25T20%3A07%3A53.194Z',
  );
  assert.equal(profile.generatedProfileImage.reason, 'placeholder_profile_image');
  assert.equal(profile.generatedProfileImage.sourceCard.name, 'Pikachu ex');
});

test('artist summaries expose visible artist card counts', async () => {
  const queries = [];
  const payload = await artistSummaries({
    limit: 10,
    query: async (sql, values) => {
      queries.push({ sql, values });
      return {
        rows: [
          {
            artist: 'Raita Kazama',
            illustrator: 'Raita Kazama',
            normalized_artist: 'raita kazama',
            artist_slug: 'raita-kazama',
            artist_card_count: 0,
            visible_card_count: 213,
            image_url: 'https://cdn.pokoin.test/raita.webp',
            cover_name: 'Pikachu',
          },
        ],
      };
    },
  });

  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /visible_card_count/);
  assert.match(queries[0].sql, /greatest\(/);
  assert.match(queries[0].sql, /marketplace_card_versions/);
  assert.match(queries[0].sql, /cover_tier/);
  assert.match(queries[0].sql, /\^pikachu/);
  assert.match(queries[0].sql, /bulbasaur\|charmander\|squirtle/);
  assert.match(queries[0].sql, /\^eevee/);
  assert.match(queries[0].sql, /cheapest_homepage_cache_blueprint/);
  assert.match(queries[0].sql, /cdn_image_url/);
  assert.match(queries[0].sql, /marketplace_leftover_art_shades/);
  assert.doesNotMatch(queries[0].sql, /preview_image_url/);
  assert.deepEqual(queries[0].values, [10]);
  assert.deepEqual(payload, [
    {
      name: 'Raita Kazama',
      illustrator: 'Raita Kazama',
      normalizedArtist: 'raita kazama',
      slug: 'raita-kazama',
      cardCount: 213,
      imageUrl: 'https://cdn.pokoin.test/raita.webp',
      coverName: 'Pikachu',
      artShade: '',
      profileImageUrl: '',
    },
  ]);
});

test('illustrator cover prefers Pikachu, then a gen 1 starter, then Eevee, then listed PKN', () => {
  assert.equal(artistCoverTier('Pikachu ex'), 1);
  assert.equal(artistCoverTier('Charmander'), 2);
  assert.equal(artistCoverTier('Eevee V'), 3);
  assert.equal(artistCoverTier('Weedle'), 4);
  assert.equal(leftoverArtistImage({
    preview_image_url: 'https://cdn.pokoin.com/previews/111238_bill.jpg',
    cdn_image_url: 'https://cdn.pokoin.com/111238_bill.jpg',
  }), 'https://cdn.pokoin.com/111238_bill.jpg');
  assert.equal(leftoverArtistImage({
    image_url: 'https://cdn.pokoin.com/previews/321844_fezandipiti.jpg',
  }), '');

  const cover = pickArtistCover([
    { name: 'Weedle', lowest_price_pkn: 9000, cdn_image_url: 'https://cdn.pokoin.test/weedle.jpg' },
    { name: 'Charmander', lowest_price_pkn: 400, cdn_image_url: 'https://cdn.pokoin.test/charmander.jpg' },
    { name: 'Pikachu', lowest_price_pkn: 222, cdn_image_url: 'https://cdn.pokoin.test/pika.jpg' },
    { name: 'Eevee', lowest_price_pkn: 800, cdn_image_url: 'https://cdn.pokoin.test/eevee.jpg' },
  ]);
  assert.equal(cover.name, 'Pikachu');

  const starter = pickArtistCover([
    { name: 'Weedle', lowest_price_pkn: 9000, cdn_image_url: 'https://cdn.pokoin.test/weedle.jpg' },
    { name: 'Squirtle', lowest_price_pkn: 300, cdn_image_url: 'https://cdn.pokoin.test/squirtle.jpg' },
    { name: 'Eevee', lowest_price_pkn: 800, cdn_image_url: 'https://cdn.pokoin.test/eevee.jpg' },
  ]);
  assert.equal(starter.name, 'Squirtle');

  const expensive = pickArtistCover([
    { name: 'Weedle', lowest_price_pkn: 200, cdn_image_url: 'https://cdn.pokoin.test/weedle.jpg' },
    { name: 'Charizard', lowest_price_pkn: 10500, cdn_image_url: 'https://cdn.pokoin.test/zard.jpg' },
  ]);
  assert.equal(expensive.name, 'Charizard');
});

test('tiles mode serves artist identity once instead of repeating it on every card row', async () => {
  const queries = [];
  const payload = await artistCardsForSlug({
    artistSlug: 'ken-sugimori',
    limit: 5000,
    tiles: true,
    overlayCheapest: async (rows) => rows,
    query: async (sql, values) => {
      queries.push({ sql, values });
      if (/from public\.marketplace_card_versions/.test(sql)) {
        return {
          rows: [
            {
              card_id: '633380',
              name: 'Charizard',
              expansion_name: 'Base Set',
              expansion_number: '4/102',
              blueprint_id: '100944',
              image_url: 'https://cdn.pokoin.test/633380_charizard.jpg',
              product_type: 'single',
              version: 'base1-4',
              pokedex_num: 6,
            },
          ],
        };
      }
      return {
        rows: [
          {
            normalized_artist: 'ken sugimori',
            artist_slug: 'ken-sugimori',
            artist: 'KEN SUGIMORI',
            illustrator: 'Ken Sugimori',
            artist_card_count: 950,
            profile_display_name: 'Ken Sugimori',
          },
        ],
      };
    },
  });

  assert.equal(queries.length, 2, 'tiles mode runs the cards query plus one identity lookup');
  assert.doesNotMatch(queries[0].sql, /marketplace_artist_profiles/, 'the cards query skips the profiles join');
  assert.doesNotMatch(queries[0].sql, /count\(\*\) over \(\)/, 'the cards query skips the window count');
  assert.match(queries[1].sql, /marketplace_artist_profiles/);
  assert.equal(payload.artist.name, 'Ken Sugimori');
  assert.equal(payload.artist.cardCount, 950);
  assert.equal(payload.profile.displayName, 'Ken Sugimori');
  assert.equal(payload.cards[0].image_url, 'https://cdn.pokoin.test/633380_charizard.jpg');
  assert.equal(payload.cards[0].artist, undefined, 'tiles rows carry no per-row artist column');
  assert.equal(payload.cards[0].profile_summary, undefined, 'tiles rows carry no profile columns');
  assert.equal(payload.cards[0].cdn_image_url, undefined, 'tiles rows carry one image column, not four');
});
