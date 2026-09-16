const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  leftoverCdnObjectKey,
  homepageJpegKey,
  leftoverLookupIds,
  pickLeftoverAlias,
  candidateKeys,
  buildLeftoverIndex,
  resolveFile,
} = require('./pokoin-oracle-cdn-server.js');

test('public leftover remap still halves even ids', () => {
  assert.equal(
    leftoverCdnObjectKey('798832_silvally-holo-rare.jpg'),
    '399416_silvally-holo-rare.jpg',
  );
  assert.equal(
    leftoverCdnObjectKey('798832_silvally-holo-rare_homepage.webp'),
    '399416_silvally-holo-rare_homepage.webp',
  );
});

test('homepage webp maps to leftover jpeg candidates', () => {
  assert.equal(homepageJpegKey('798832_silvally_homepage.webp'), '798832_silvally.jpg');
  assert.ok(candidateKeys('798832_silvally-holo-rare_homepage.webp').includes('399416_silvally-holo-rare.jpg'));
});

test('leftover lookup lists requested id first, then public/2', () => {
  assert.deepEqual(leftoverLookupIds('798832_silvally-holo-rare.jpg'), ['798832', '399416']);
  assert.deepEqual(leftoverLookupIds('399416_silvally.jpg'), ['399416', '199708']);
  assert.deepEqual(leftoverLookupIds('245292_net-ball.jpg'), ['245292', '122646']);
  assert.deepEqual(leftoverLookupIds('122490_meloetta.jpg'), ['122490', '61245']);
});

test('alias picker prefers the short leftover dump name', () => {
  const files = [
    '399416_silvally-holo-rare.jpg',
    '399416_silvally.jpg',
    '399416_silvally_homepage.webp',
  ];
  assert.equal(pickLeftoverAlias(files, false), '399416_silvally.jpg');
  assert.equal(pickLeftoverAlias(files, true), '399416_silvally_homepage.webp');
  assert.equal(pickLeftoverAlias(['399416_silvally.jpg'], true), '399416_silvally.jpg');
});

test('resolveFile aliases a leaked rarity stem to the leftover dump file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pokoin-cdn-'));
  fs.writeFileSync(path.join(root, '399416_silvally.jpg'), 'jpeg');
  fs.writeFileSync(path.join(root, '399416_silvally_homepage.webp'), 'webp');
  const index = buildLeftoverIndex(root);
  const jpeg = resolveFile('798832_silvally-holo-rare.jpg', { root, index });
  const tile = resolveFile('798832_silvally-holo-rare_homepage.webp', { root, index });
  assert.equal(jpeg.key, '399416_silvally.jpg');
  assert.equal(tile.key, '399416_silvally_homepage.webp');
  fs.rmSync(root, { recursive: true, force: true });
});

test('homepage requests prefer the leftover webp over a leaked-stem jpeg hardlink', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pokoin-cdn-'));
  fs.writeFileSync(path.join(root, '399416_silvally.jpg'), 'jpeg-short');
  fs.writeFileSync(path.join(root, '399416_silvally-holo-rare.jpg'), 'jpeg-leaked');
  fs.writeFileSync(path.join(root, '399416_silvally_homepage.webp'), 'webp');
  const index = buildLeftoverIndex(root);
  const tile = resolveFile('798832_silvally-holo-rare_homepage.webp', { root, index });
  assert.equal(tile.key, '399416_silvally_homepage.webp');
  fs.rmSync(root, { recursive: true, force: true });
});

test('public-id leftover collision loses to leftover ct_id (Net Ball vs Cyndaquil)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pokoin-cdn-'));
  fs.writeFileSync(path.join(root, '245292_cyndaquil.jpg'), 'cyndaquil-jpeg');
  fs.writeFileSync(path.join(root, '245292_cyndaquil_homepage.webp'), 'cyndaquil-webp');
  fs.writeFileSync(path.join(root, '245292_net-ball.jpg'), 'wrong-public-named');
  fs.writeFileSync(path.join(root, '122646_net-ball-187-214-lost-thunder.jpg'), 'net-ball-jpeg');
  fs.writeFileSync(path.join(root, '122646_net-ball-187-214-lost-thunder_homepage.webp'), 'net-ball-webp');
  fs.writeFileSync(path.join(root, '399416_silvally.jpg'), 'silvally');
  const index = buildLeftoverIndex(root);
  const jpeg = resolveFile('245292_net-ball.jpg', { root, index });
  const tile = resolveFile('245292_net-ball_homepage.webp', { root, index });
  const leftoverHit = resolveFile('399416_silvally.jpg', { root, index });
  assert.equal(jpeg.key, '122646_net-ball-187-214-lost-thunder.jpg');
  assert.equal(tile.key, '122646_net-ball-187-214-lost-thunder_homepage.webp');
  assert.equal(leftoverHit.key, '399416_silvally.jpg');
  fs.rmSync(root, { recursive: true, force: true });
});

test('even leftover that is another card public id still serves its own dump (Juniper vs Pikachu V-UNION)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pokoin-cdn-'));
  fs.writeFileSync(path.join(root, '342356_professor-s-research-professor-juniper.jpg'), 'juniper-jpeg');
  fs.writeFileSync(path.join(root, '342356_professor-s-research-professor-juniper_homepage.webp'), 'juniper-webp');
  fs.writeFileSync(path.join(root, '171178_pikachu-v-union-139-promo-celebrations.jpg'), 'pikachu-jpeg');
  fs.writeFileSync(path.join(root, '171178_pikachu-v-union-139-promo-celebrations_homepage.webp'), 'pikachu-webp');
  const index = buildLeftoverIndex(root);
  const desk = resolveFile('342356_professor-s-research-professor-juniper.jpg', { root, index });
  const tile = resolveFile('342356_professor-s-research-professor-juniper_homepage.webp', { root, index });
  const publicId = resolveFile('684712_professor-s-research-professor-juniper.jpg', { root, index });
  const pikachu = resolveFile('342356_pikachu-v-union-139-promo-celebrations.jpg', { root, index });
  assert.equal(desk.key, '342356_professor-s-research-professor-juniper.jpg');
  assert.equal(tile.key, '342356_professor-s-research-professor-juniper_homepage.webp');
  assert.equal(publicId.key, '342356_professor-s-research-professor-juniper.jpg');
  assert.equal(pikachu.key, '171178_pikachu-v-union-139-promo-celebrations.jpg');
  fs.rmSync(root, { recursive: true, force: true });
});

test('even leftover ct_id is not halved again to leftover/4 (Meloetta 122490 vs 61245)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pokoin-cdn-'));
  fs.writeFileSync(path.join(root, '61245_meloetta-104-214-lost-thunder.jpg'), 'stale-quarter');
  fs.writeFileSync(path.join(root, '61245_meloetta-104-214-lost-thunder_homepage.webp'), 'stale-tile');
  fs.writeFileSync(path.join(root, '122490_meloetta-104-214-lost-thunder.jpg'), 'true-leftover');
  fs.writeFileSync(path.join(root, '122490_meloetta-104-214-lost-thunder_homepage.webp'), 'true-tile');
  const index = buildLeftoverIndex(root);
  const jpeg = resolveFile('122490_meloetta.jpg', { root, index });
  const long = resolveFile('122490_meloetta-104-214-lost-thunder.jpg', { root, index });
  const tile = resolveFile('122490_meloetta_homepage.webp', { root, index });
  const publicId = resolveFile('244980_meloetta.jpg', { root, index });
  assert.equal(jpeg.key, '122490_meloetta-104-214-lost-thunder.jpg');
  assert.equal(long.key, '122490_meloetta-104-214-lost-thunder.jpg');
  assert.equal(tile.key, '122490_meloetta-104-214-lost-thunder_homepage.webp');
  assert.equal(publicId.key, '122490_meloetta-104-214-lost-thunder.jpg');
  fs.rmSync(root, { recursive: true, force: true });
});

test('leftover dump named for another row still serves that leftover id (Metang vs Great Tusk filename)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pokoin-cdn-'));
  fs.writeFileSync(path.join(root, '321834_great-tusk-cosmos-holo-tef-114-play-pokemon-prize-pack-series-six.jpg'), 'metang-jpeg');
  fs.writeFileSync(path.join(root, '321834_great-tusk-cosmos-holo-tef-114-play-pokemon-prize-pack-series-six_homepage.webp'), 'metang-webp');
  const index = buildLeftoverIndex(root);
  const jpeg = resolveFile('321834_metang.jpg', { root, index });
  const tile = resolveFile('321834_metang_homepage.webp', { root, index });
  const publicId = resolveFile('643668_metang-cosmos-holo-114-162.jpg', { root, index });
  assert.equal(jpeg.key, '321834_great-tusk-cosmos-holo-tef-114-play-pokemon-prize-pack-series-six.jpg');
  assert.equal(tile.key, '321834_great-tusk-cosmos-holo-tef-114-play-pokemon-prize-pack-series-six_homepage.webp');
  assert.equal(publicId.key, '321834_great-tusk-cosmos-holo-tef-114-play-pokemon-prize-pack-series-six.jpg');
  fs.rmSync(root, { recursive: true, force: true });
});
