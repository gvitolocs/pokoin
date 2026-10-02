const assert = require('node:assert/strict');
const test = require('node:test');
const {
  rewriteCdnKeyPrefix,
  rewriteCdnPokoinPrefix,
  normalizeMarketplaceRow,
} = require('./_marketplace_row');

test('rewrites leftover CardTrader CDN prefixes to our id', () => {
  assert.equal(
    rewriteCdnPokoinPrefix(
      'https://cdn.pokoin.com/110481_espurr-58-122-breakpoint.jpg',
      { card_id: 220962, ct_id: 110481 },
    ),
    'https://cdn.pokoin.com/220962_espurr-58-122-breakpoint.jpg',
  );
  assert.equal(
    rewriteCdnPokoinPrefix(
      'https://cdn.pokoin.com/220962_espurr-58-122-breakpoint.jpg',
      { card_id: 220962, ct_id: 110481 },
    ),
    'https://cdn.pokoin.com/220962_espurr-58-122-breakpoint.jpg',
  );
  assert.equal(
    rewriteCdnPokoinPrefix(
      'https://cdn.pokoin.com/previews/110481_espurr.jpg',
      { card_id: 220962, ct_id: 110481 },
    ),
    'https://cdn.pokoin.com/previews/220962_espurr.jpg',
  );
});

test('keeps every multi-game CDN prefix on the leftover ct_id', () => {
  for (const prefix of [
    'one-piece',
    'riftbound',
    'magic',
    'yugioh',
    'lorcana',
    'flesh-and-blood',
    'digimon',
    'dragon-ball-super',
    'vanguard',
    'star-wars',
    'union-arena',
    'gundam',
    'sorcery',
    'palworld',
    'cyberpunk',
    'weiss-schwarz',
    'final-fantasy',
    'force-of-will',
    'world-of-warcraft',
    'battle-spirits-saga',
    'star-wars-destiny',
    'dragon-born',
    'my-little-pony',
    'the-spoils',
  ]) {
    const url = `https://cdn.pokoin.com/${prefix}/404909_hi-speedroid-clear-wing-rider.jpg`;
    assert.equal(
      rewriteCdnPokoinPrefix(url, { card_id: 809818, ct_id: 404909 }),
      url,
    );
  }
});

test('does not rewrite a leftover Nacli key when the row is Drifloon public 248768', () => {
  assert.equal(
    rewriteCdnKeyPrefix('/card-images/248768_nacli.jpg', '124384', '248768'),
    '/card-images/248768_nacli.jpg',
  );
  assert.equal(
    rewriteCdnPokoinPrefix('/card-images/124384_drifloon.jpg', {
      card_id: 248768,
      ct_id: 124384,
    }),
    '/card-images/248768_drifloon.jpg',
  );
  assert.equal(
    rewriteCdnPokoinPrefix('/card-images/248768_nacli.jpg', {
      card_id: 497536,
      ct_id: 248768,
    }),
    '/card-images/497536_nacli.jpg',
  );
});

test('normalizeMarketplaceRow fills ct_id and rewrites image fields to our id', () => {
  const row = normalizeMarketplaceRow({
    card_id: 220962,
    image_url: 'https://cdn.pokoin.com/110481_espurr.jpg',
    card_number: '58/122',
  });
  assert.equal(row.ct_id, 110481);
  assert.equal(row.image_url, 'https://cdn.pokoin.com/220962_espurr.jpg');
  assert.equal(row.item_kind, 'single');
});

test('normalizeMarketplaceRow prefers jpg over fragile preview webp', () => {
  const row = normalizeMarketplaceRow({
    card_id: 483348,
    ct_id: 241674,
    card_number: '210/198',
    image_url: 'https://cdn.pokoin.com/241674_drowzee-210-198-scarlet-violet.jpg',
    preview_image_url: 'https://cdn.pokoin.com/previews/241674_drowzee-210-198-scarlet-violet.webp',
  });
  assert.equal(
    row.preview_image_url,
    'https://cdn.pokoin.com/241674_drowzee-210-198-scarlet-violet.jpg'.replace(
      '241674_',
      '483348_',
    ),
  );
  assert.equal(
    row.image_url,
    'https://cdn.pokoin.com/483348_drowzee-210-198-scarlet-violet.jpg',
  );
  assert.equal(row.item_kind, 'single');
});

test('isMarketAvailable is derived for React clients', () => {
  const { normalizeMarketplaceRow } = require('./_marketplace_row');
  const oos = normalizeMarketplaceRow({
    card_id: 483348,
    card_number: '210/198',
    listed_quantity: 0,
    has_cardtrader_listing: false,
  });
  assert.equal(oos.isMarketAvailable, false);
  const live = normalizeMarketplaceRow({
    card_id: 587148,
    card_number: '062/060',
    listed_quantity: 5,
    has_cardtrader_listing: true,
  });
  assert.equal(live.isMarketAvailable, true);
  assert.equal(live.inStock, true);
});
