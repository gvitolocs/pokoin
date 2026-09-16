import assert from 'node:assert/strict';
import test from 'node:test';
import {
  artistPageUrl,
  collectorNumber,
  foldMatchKey,
  matchPkmncardsPrinting,
  parseArtistPage,
  printingKey,
  shouldWriteArtist,
} from './pkmncards-artists.js';

const FUKUYAMA_HTML = `
<a href="https://pkmncards.com/card/abra-skyridge-sk-46/" title="Abra · Skyridge (SK) #46"><img alt=""></a>
<a href="https://pkmncards.com/card/ledyba-southern-islands-si-7/" title="Ledyba · Southern Islands (SI) #7"><img alt=""></a>
<a href="https://pkmncards.com/card/nidoran-male-aquapolis-aq-96/" title="Nidoran Male · Aquapolis (AQ) #96"><img alt=""></a>
<a href="https://pkmncards.com/nav">Skip</a>
`;

test('pkmncards artist page parses name, set, and collector', () => {
  const cards = parseArtistPage(FUKUYAMA_HTML, { artist: 'Keiko Fukuyama' });
  assert.equal(cards.length, 3);
  assert.equal(cards[1].name, 'Ledyba');
  assert.equal(cards[1].set, 'Southern Islands');
  assert.equal(cards[1].number, '7');
  assert.equal(artistPageUrl('Keiko Fukuyama'), 'https://pkmncards.com/artist/keiko-fukuyama/');
});

test('Southern Islands Ledyba matches leftover 7/18 and not Skyridge 72/144', () => {
  const [ledyba] = parseArtistPage(FUKUYAMA_HTML).filter((row) => row.name === 'Ledyba');
  const rows = [
    { name: 'Ledyba', set_name: 'Southern Islands', card_number: '7/18', ct_id: 127862 },
    { name: 'Ledyba', set_name: 'Skyridge', card_number: '72/144', ct_id: 127704 },
    { name: 'Ledyba', set_name: 'Southern Islands JP', card_number: 'Reverse Holo', ct_id: 253685 },
  ];
  const hits = matchPkmncardsPrinting(ledyba, rows);
  assert.deepEqual(hits.map((row) => row.ct_id), [127862]);
  assert.equal(printingKey('Ledyba', 'Southern Islands JP', '7/18'), printingKey('Ledyba', 'Southern Islands', '7'));
  assert.equal(collectorNumber('7/18'), '7');
});

test('Nidoran Male matches leftover Nidoran ♂', () => {
  assert.equal(foldMatchKey('Nidoran Male'), foldMatchKey('Nidoran ♂'));
});

test('CLIP same_artwork may be corrected; OCR and io may not', () => {
  assert.equal(shouldWriteArtist('', '', 'Keiko Fukuyama'), true);
  assert.equal(shouldWriteArtist('same_artwork', 'Masako Yamashita', 'Keiko Fukuyama'), true);
  assert.equal(shouldWriteArtist('ocr_illus', 'Keiko Fukuyama', 'Keiko Fukuyama'), false);
  assert.equal(shouldWriteArtist('pokemon_tcg_data', 'Masako Yamashita', 'Keiko Fukuyama'), false);
});
