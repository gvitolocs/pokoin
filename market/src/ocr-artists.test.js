import assert from 'node:assert/strict';
import test from 'node:test';
import {
  artistIndexFromOcrRows,
  isPlausibleArtist,
  matchOcrArtist,
  normalizeArtistName,
  parseOcrArtists,
  rowsFromArtistSummaries,
  slugArtist,
} from './ocr-artists.js';

test('Illus. line cuts collector numbers and turn rules', () => {
  assert.equal(parseOcrArtists('Illus. Midori Harada While it is quiet')[0], 'Midori Harada');
  assert.equal(
    parseOcrArtists('Illus. Ken Sugimori/Yusuke Ohmura\n189/236\n©2019')[0],
    'Ken Sugimori',
  );
  assert.equal(
    parseOcrArtists('Illus. Ken Sugimori/Yusuke Ohmura\n189/236')[1],
    'Yusuke Ohmura',
  );
  assert.equal(
    parseOcrArtists('Illus. Toyste Beach during your turn. 180/163')[0],
    'Toyste Beach',
  );
  assert.equal(parseOcrArtists('Illus. 5ban Graphics Pokémon-ex rule')[0], '5ban Graphics');
  assert.equal(parseOcrArtists('Illus. Sban Graphics Vrule')[0], '5ban Graphics');
  assert.equal(parseOcrArtists('ithus. PLANETA')[0], 'PLANETA');
  assert.equal(parseOcrArtists('Wus. Mitsuhiro Arita 58/102')[0], 'Mitsuhiro Arita');
  assert.equal(parseOcrArtists('Illus. Kazuki Minami\nWh')[0], 'Kazuki Minami');
  assert.equal(parseOcrArtists('Ilus. Studio Bora Inc. your turn')[0], 'Studio Bora Inc.');
  assert.equal(parseOcrArtists('Mllus. Susumu Maeya your turn')[0], 'Susumu Maeya');
  assert.equal(parseOcrArtists('Illus.Ken Sugimori')[0], 'Ken Sugimori');
  assert.equal(parseOcrArtists('Illus.5ban Graphics Pokémon-ex rule')[0], '5ban Graphics');
  assert.equal(parseOcrArtists('IlIus. AYUMI ODASHIMA 104/103 AR')[0], 'AYUMI ODASHIMA');
  assert.equal(parseOcrArtists('illustration rare window').length, 0);
  assert.equal(parseOcrArtists('Illus. Mékayu')[0], 'Mékayu');
  assert.equal(parseOcrArtists('Illus. You Iribi')[0], 'You Iribi');
  assert.equal(parseOcrArtists('Illus. DOM')[0], 'DOM');
  assert.equal(parseOcrArtists('Illus. svlt')[0], 'svlt');
  assert.equal(parseOcrArtists('illus.0313')[0], '0313');
  assert.equal(matchOcrArtist('Mékayu', []), 'Mékayu');
  assert.equal(matchOcrArtist('You Iribi', []), 'You Iribi');
  assert.equal(matchOcrArtist('DOM', []), 'DOM');
  assert.equal(matchOcrArtist('svlt', []), 'svlt');
  assert.equal(matchOcrArtist('0313', []), '0313');
  assert.equal(parseOcrArtists('Illus. DOM ThESS3 M6a 024/103')[0], 'DOM');
  assert.equal(parseOcrArtists('Illus. svlt ThESS3')[0], 'svlt');
  assert.equal(matchOcrArtist('but', []), '');
  assert.equal(matchOcrArtist('hnd', []), '');
});

test('junk OCR tails are not artists', () => {
  assert.equal(isPlausibleArtist('match'), false);
  assert.equal(isPlausibleArtist('during your turn'), false);
  assert.equal(normalizeArtistName('Yoshinobu Saito146a/162 A'), 'Yoshinobu Saito');
  assert.equal(parseOcrArtists('Draw 3 cards.').length, 0);
  assert.equal(parseOcrArtists('Illus. Ken Sugimori turn')[0], 'Ken Sugimori');
  assert.equal(
    matchOcrArtist('198 your turn', ['Ken Sugimori', 'Mitsuhiro Arita']),
    '',
  );
});

test('artist index dedupes leftover ct_id and counts unique names', () => {
  const index = artistIndexFromOcrRows([
    { ct_id: 1, card_id: 2, name: 'Pikachu', expansion: 'Base Set', num: '58/102', ok: true, text: 'Illus. Mitsuhiro Arita' },
    { ct_id: 1, card_id: 2, name: 'Pikachu', expansion: 'Base Set', num: '58/102', ok: true, text: 'Illus. Mitsuhiro Arita 58/102' },
    { ct_id: 3, card_id: 6, name: 'Bill', expansion: 'Base Set', num: '91/102', ok: true, text: 'Illus. Ken Sugimori' },
    { ct_id: 4, card_id: 8, name: 'Hop', expansion: 'SSH', num: '165/202', ok: true, text: 'Draw 3 cards.' },
  ]);
  assert.equal(index.cards, 3);
  assert.equal(index.withArtist, 2);
  assert.equal(index.missing, 1);
  assert.equal(index.artists[0].name, 'Ken Sugimori');
  assert.equal(index.artists[1].name, 'Mitsuhiro Arita');
  assert.equal(index.artists[1].count, 1);
  assert.equal(slugArtist('5ban Graphics'), '5ban-graphics');
});

test('garbled OCR illustrators resolve to pokemontcg.io names', () => {
  const io = ['Ken Sugimori', 'Mitsuhiro Arita', '5ban Graphics', 'kawayoo'];
  assert.equal(matchOcrArtist('Ken Sugimorl', io), 'Ken Sugimori');
  assert.equal(matchOcrArtist('Mitsuhirs Arlta', io), 'Mitsuhiro Arita');
  assert.equal(matchOcrArtist('Sban Graphics', io), '5ban Graphics');
  assert.equal(matchOcrArtist('Sban Grophics Vrule', io), '5ban Graphics');
  assert.equal(matchOcrArtist('Ken Sugimori resistance', io), 'Ken Sugimori');
  assert.equal(matchOcrArtist('kawayoo', io), 'kawayoo');
  assert.equal(matchOcrArtist('Zyxq Madeup', io), 'Zyxq Madeup');
  assert.equal(matchOcrArtist('Ken Sugimorl 01995. 96, 96 Nit', io), 'Ken Sugimori');
  assert.equal(matchOcrArtist('Ken Sugimari Bite 10 XX Flame Tail', io), 'Ken Sugimori');
  assert.equal(matchOcrArtist('Ken Sugima', io), 'Ken Sugimori');
  assert.equal(matchOcrArtist('Ken Sugi', io), 'Ken Sugimori');
  assert.equal(matchOcrArtist('Sban Grephics BW75 0201 Pokemon', io), '5ban Graphics');
  assert.equal(matchOcrArtist('Miltsuhiro Arita When Pok', io), 'Mitsuhiro Arita');
  assert.equal(matchOcrArtist('Ryo Ueda This Pok', [...io, 'Ryo Ueda']), 'Ryo Ueda');
  assert.equal(matchOcrArtist('Ken lkuji When Pok', [...io, 'Ken Ikuji']), 'Ken Ikuji');
  assert.equal(matchOcrArtist('Shin Nogosowa', [...io, 'Shin Nagasawa', 'sui', 'take']), 'Shin Nagasawa');
  assert.equal(matchOcrArtist('Kyake Umemato', [...io, 'Kyoko Umemoto', 'take']), 'Kyoko Umemoto');
  assert.equal(matchOcrArtist('Hasuno Melemele', [...io, 'Hasuno']), 'Hasuno');
  assert.equal(matchOcrArtist('Nakaoka Evolves', [...io, 'Nakaoka']), 'Nakaoka');
  assert.equal(
    matchOcrArtist('Hiromichi Sugiyama, CR CG gangs', [...io, 'Hiromichi Sugiyama', 'CR CG gangs']),
    'Hiromichi Sugiyama',
  );
  assert.equal(matchOcrArtist('discard it if another Stadium comes into play', io), '');
  assert.equal(matchOcrArtist('as a result', io), '');
  assert.equal(matchOcrArtist('Pok', io), '');
  assert.equal(matchOcrArtist('Knocked Out', io), '');
  assert.equal(matchOcrArtist('Reverberates', io), '');
  assert.equal(matchOcrArtist('nests', io), '');
  assert.equal(matchOcrArtist('regardless', io), '');
  assert.equal(matchOcrArtist('match', [...io, 'match']), '');
  assert.equal(matchOcrArtist('continuous attacks', io), '');
  assert.equal(matchOcrArtist('draw card', io), '');
});

test('card identity plus OCR picks the io illustrator and keeps singletons', () => {
  const io = {
    names: ['Mitsuhiro Arita', 'Ken Sugimori'],
    pokemon: new Set(['bisharp']),
    byCard: new Map([['pikachu#58', ['Mitsuhiro Arita']]]),
  };
  const index = artistIndexFromOcrRows([
    {
      ct_id: 1,
      card_id: 2,
      name: 'Pikachu',
      num: '58/102',
      ok: true,
      text: 'Wus. Mitsuhirs Arlta C1995',
    },
    {
      ct_id: 9,
      card_id: 18,
      name: 'Oddish',
      num: '1/1',
      ok: true,
      text: 'Illus. Zyxq Madeup',
    },
    {
      ct_id: 10,
      card_id: 20,
      name: 'Bisharp',
      num: '9/99',
      ok: true,
      text: 'Illus. Bisharp',
    },
  ], { io });
  assert.equal(index.artists.find((row) => row.name === 'Mitsuhiro Arita').count, 1);
  assert.equal(index.artists.find((row) => row.name === 'Zyxq Madeup').count, 1);
  assert.equal(index.artists.find((row) => row.name === 'Bisharp'), undefined);
});

test('catalog artist table uses cardCount from marketplace summaries', () => {
  const rows = rowsFromArtistSummaries({
    artists: [
      { name: 'Ken Sugimori', slug: 'ken-sugimori', cardCount: 1149 },
      { name: '5ban Graphics', slug: '5ban-graphics', cardCount: 1589 },
    ],
  });
  assert.equal(rows[0].name, '5ban Graphics');
  assert.equal(rows[0].count, 1589);
  assert.equal(rows[1].count, 1149);
});
