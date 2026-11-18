import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCEPT,
  catalogGroups,
  fitCardRect,
  initialScanCatalog,
  mapContain,
  pickCatalog,
  preferredCamera,
  readScanResult,
  scanHitHref,
  scanIdentifyUrl,
  uprightRoll,
} from './scan-live.js';

const CATALOGS = [
  { id: 'magic_all', game: 'magic', language: 'all', count: 113801 },
  { id: 'pokemon_generic', game: 'pokemon', language: 'generic', count: 63235 },
  { id: 'pokemon_western', game: 'pokemon', language: 'western', count: 26051 },
  { id: 'pokemon_japanese', game: 'pokemon', language: 'japanese', count: 25938 },
  { id: 'riftbound_western', game: 'riftbound', language: 'western', count: 1640 },
  { id: 'one_piece_singles', game: 'one_piece', language: 'singles', count: 5661 },
  { id: 'one_piece_english', game: 'one_piece', language: 'english', count: 7256 },
  { id: 'yugioh_all', game: 'yugioh', language: 'all', count: 46294 },
  { id: 'mystery_all', game: 'not_a_game', language: 'all', count: 9 },
];

const OMANYTE = {
  public_id: '246870',
  ct_id: '123435',
  name: 'Dark Omanyte',
  collector_number: '37/105',
  set: 'Neo Destiny',
  game: 'pokemon',
  image_url: 'https://cdn.pokoin.com/123435_dark-omanyte-37-105-neo-destiny.jpg',
  pokoin_url: 'https://pokoin.com/marketplace/en/cards/246870',
  score: 0.8739,
  printing: { language: 'en' },
};

test('identify URL matches scan.pokoin.com: live 3 hits, multi 8, photo 5', () => {
  assert.equal(
    scanIdentifyUrl({ catalog: 'pokemon_western', live: true }),
    'https://api.pokoin.com/api/scan/identify?catalog=pokemon_western&multi=0&live=1&top_k=3',
  );
  assert.equal(
    scanIdentifyUrl({ catalog: 'one_piece_english', live: true, multi: true }),
    'https://api.pokoin.com/api/scan/identify?catalog=one_piece_english&multi=1&live=1&top_k=8',
  );
  assert.equal(
    scanIdentifyUrl({ catalog: 'magic_all' }),
    'https://api.pokoin.com/api/scan/identify?catalog=magic_all&multi=0&top_k=5',
  );
});

test('catalog groups keep Pokémon, One Piece, Riftbound first and every other game after', () => {
  const groups = catalogGroups(CATALOGS);
  assert.deepEqual(groups.map((g) => g.game), ['pokemon', 'one_piece', 'riftbound', 'magic', 'yugioh']);
  assert.deepEqual(groups[0].catalogs.map((c) => c.code), ['EN', 'JP', 'ALL']);
  assert.deepEqual(groups[1].catalogs.map((c) => c.id), ['one_piece_english', 'one_piece_singles']);
  assert.equal(groups[2].catalogs[0].code, 'ALL');
  assert.equal(groups[3].name, 'Magic');
});

test('catalog pick: URL request, then site preference, then the game first catalog', () => {
  const groups = catalogGroups(CATALOGS);
  assert.equal(pickCatalog(groups, { requested: 'yugioh_all', preferred: 'pokemon_generic' }), 'yugioh_all');
  assert.equal(pickCatalog(groups, { requested: 'nope', preferred: 'pokemon_generic' }), 'pokemon_generic');
  assert.equal(pickCatalog(groups, { preferred: 'one_piece_japanese', gameId: 'one_piece' }), 'one_piece_english');
  assert.equal(pickCatalog(groups, { gameId: 'magic' }), 'magic_all');
  assert.equal(pickCatalog([], {}), '');
});

test('scanner starts on Western / English like scan.pokoin.com, other site choices stay', () => {
  assert.equal(initialScanCatalog('pokemon_generic'), 'pokemon_western');
  assert.equal(initialScanCatalog('one_piece_singles'), 'one_piece_english');
  assert.equal(initialScanCatalog('pokemon_japanese'), 'pokemon_japanese');
  assert.equal(initialScanCatalog('magic_all'), 'magic_all');
});

test('hit href stays on the scanned game and never opens a mismatched card', () => {
  assert.equal(scanHitHref(OMANYTE, 'pokemon'), '/marketplace/en/cards/246870');
  assert.equal(
    scanHitHref({ public_id: '900', game: 'magic', pokoin_url: 'https://pokoin.com/magic/marketplace/en/cards/900' }, 'magic'),
    '/magic/marketplace/en/cards/900',
  );
  assert.equal(scanHitHref({ ...OMANYTE, game: 'one_piece' }, 'pokemon'), '');
  assert.equal(scanHitHref({ ...OMANYTE, pokoin_url: 'https://pokoin.com/marketplace/en/cards/1' }, 'pokemon'), '');
  assert.equal(scanHitHref({ ...OMANYTE, public_id: 'abc' }, 'pokemon'), '');
});

test('single scan: accepted at ACCEPT, possible above 0.60 on a live frame', () => {
  const accepted = readScanResult({ top1: OMANYTE, hits: [OMANYTE], boxes: [{}] }, { live: true, gameId: 'pokemon' });
  assert.equal(accepted.state, 'accepted');
  assert.deepEqual(accepted.hits[0], {
    id: '246870',
    name: 'Dark Omanyte',
    set: 'Neo Destiny',
    number: '37/105',
    image: OMANYTE.image_url,
    score: 0.8739,
    language: 'en',
    href: '/marketplace/en/cards/246870',
  });
  const low = { ...OMANYTE, score: ACCEPT - 0.05 };
  assert.equal(readScanResult({ top1: low, boxes: [{}] }, { live: true, gameId: 'pokemon' }).state, 'possible');
  assert.equal(readScanResult({ top1: { ...low, score: 0.4 }, boxes: [{}] }, { live: true, gameId: 'pokemon' }).state, 'detected');
  assert.equal(readScanResult({ hits: [], boxes: [] }, { live: true, gameId: 'pokemon' }).state, 'searching');
  assert.equal(readScanResult({ busy: true }, { live: true }).state, 'busy');
});

test('photo scan lists up to 3 possible hits; rarity prefix is dropped from the number', () => {
  const hits = [0.7, 0.65, 0.61, 0.6].map((score, i) => ({ ...OMANYTE, public_id: String(10 + i), pokoin_url: '', score, collector_number: 'Rare | 19/64' }));
  const result = readScanResult({ hits, top1: hits[0] }, { gameId: 'pokemon' });
  assert.equal(result.state, 'possible');
  assert.equal(result.hits.length, 3);
  assert.equal(result.hits[0].number, '19/64');
  assert.equal(readScanResult({ hits: [{ ...OMANYTE, score: 0.3 }] }, { gameId: 'pokemon' }).state, 'none');
});

test('multi scan keeps every detected card at ACCEPT or above', () => {
  const data = { cards: [{ top1: OMANYTE }, { top1: { ...OMANYTE, public_id: '2', pokoin_url: '', score: 0.5 } }], boxes: [{}, {}] };
  const result = readScanResult(data, { mode: 'multi', live: true, gameId: 'pokemon' });
  assert.equal(result.state, 'multi');
  assert.deepEqual(result.hits.map((h) => h.id), ['246870']);
  assert.equal(readScanResult({ cards: [], boxes: [{}] }, { mode: 'multi', live: true }).state, 'detected');
});

test('overlay geometry: contain mapping and 63:88 card snap', () => {
  assert.deepEqual(mapContain([0, 0, 50, 100], 100, 200, 200, 200), { x: 50, y: 0, w: 50, h: 100 });
  const card = fitCardRect({ x: 0, y: 0, w: 63, h: 63 });
  assert.equal(Math.round(card.h), 88);
  assert.equal(card.w, 63);
});

test('tilt roll is null when flat and 0 when upright portrait', () => {
  assert.equal(uprightRoll(0, 0, 0), null);
  assert.equal(Math.abs(Math.round(uprightRoll(90, 0, 0).roll)), 0);
  assert.equal(uprightRoll(Number.NaN, 0, 0), null);
});

test('camera choice prefers the rear wide lens over ultra-wide and front', () => {
  const devices = [
    { kind: 'videoinput', deviceId: 'front', label: 'Front Camera' },
    { kind: 'videoinput', deviceId: 'ultra', label: 'Back Ultra Wide Camera' },
    { kind: 'videoinput', deviceId: 'main', label: 'Back Camera' },
    { kind: 'audioinput', deviceId: 'mic', label: 'Microphone' },
  ];
  assert.equal(preferredCamera(devices).deviceId, 'main');
  assert.equal(preferredCamera([{ kind: 'videoinput', deviceId: 'webcam', label: 'FaceTime HD Camera' }], 'webcam').deviceId, 'webcam');
  assert.equal(preferredCamera([]), null);
});
