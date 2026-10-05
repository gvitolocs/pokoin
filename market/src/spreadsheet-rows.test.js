import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { detectSpreadsheetFormat, importPayload, previewSpreadsheet } from './spreadsheet-rows.js';

const POWERTOOLS = `cardmarketId,quantity,name,set,setCode,cn,condition,language,isFirstEd,isReverseHolo,isSigned,finishType,price,comment,location
805496,1,Bug Catching Set,Prismatic Evolutions,PRE,102,NM,Italian,,true,,ReverseHolo,4.5,,FUOCOBOMBA 006 - 16
805497,1,Carmine,Prismatic Evolutions,PRE,103,EX,Italian,,,,Regular,3.2,,FUOCOBOMBA 006 - 16
`;

const CARDMARKET = `idProduct,quantity,name,expansion,number,language,condition,isFoil,price,location
123,2,Abra,Base Set,43,English,NM,,1.10,Binder A
`;

const CARDTRADER = `blueprint_id,quantity,price_cents,name,expansion,number,condition,language,location
999,1,250,Pikachu,Base Set,58,Near Mint,en,Shelf 2
`;

const TCGPLAYER = `TCGplayer Id,Product Line,Set Name,Product Name,Number,Rarity,Condition,Total Quantity,TCG Marketplace Price,Printing
632917,Pokemon,Scarlet & Violet,Pikachu,001,Common,Near Mint,4,1.25,Normal
`;

test('detects Power Tools, Cardmarket, CardTrader, and TCGPlayer', () => {
  assert.equal(previewSpreadsheet(POWERTOOLS).format, 'powertools');
  assert.equal(previewSpreadsheet(CARDMARKET).format, 'cardmarket');
  assert.equal(previewSpreadsheet(CARDTRADER).format, 'cardtrader');
  assert.equal(previewSpreadsheet(TCGPLAYER).format, 'tcgplayer');
  assert.equal(detectSpreadsheetFormat(['Name', 'Set']), '');
});

test('a small Power Tools sheet keeps the location on every card', () => {
  const preview = previewSpreadsheet(POWERTOOLS);
  assert.equal(preview.rows.length, 2);
  assert.equal(preview.hasLocation, true);
  assert.equal(preview.rows[0].name, 'Bug Catching Set');
  assert.equal(preview.rows[0].number, '102');
  assert.equal(preview.rows[0].location, 'FUOCOBOMBA 006 - 16');
  assert.equal(preview.rows[1].location, 'FUOCOBOMBA 006 - 16');
  assert.equal(previewSpreadsheet(CARDTRADER).rows[0].price, '2.50');
  assert.equal(previewSpreadsheet(TCGPLAYER).rows[0].name, 'Pikachu');
  assert.equal(previewSpreadsheet(TCGPLAYER).rows[0].quantity, '4');
});

test('a seller spreadsheet is guessed from name, set, and number columns', () => {
  const csv = `Card,Expansion,Collector Number,Qty,Condition,Lang,Cost,Bin
Pikachu,Base Set,58,2,NM,English,1.25,Drawer 4
`;
  const preview = previewSpreadsheet(csv);
  assert.equal(preview.format, 'custom');
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0].name, 'Pikachu');
  assert.equal(preview.rows[0].setName, 'Base Set');
  assert.equal(preview.rows[0].number, '58');
  assert.equal(preview.rows[0].quantity, '2');
  assert.equal(preview.rows[0].location, 'Drawer 4');
  assert.equal(preview.hasLocation, true);
  const payload = importPayload(preview);
  assert.equal(payload.format, 'powertools');
  assert.match(payload.csv, /^name,set,cn,quantity,condition,language,price,location/);
  assert.match(payload.csv, /Pikachu,Base Set,58,2,NM,English,1.25,Drawer 4/);
});

test('a name-only sheet is not guessed', () => {
  assert.equal(previewSpreadsheet('Card,Qty\nPikachu,1\n').format, '');
});

test('CardTrader links ask for a choice and a comma in the name stays quoted', () => {
  const linked = previewSpreadsheet('Card,Set,Number,CardTrader URL\nPikachu,Base Set,58,https://www.cardtrader.com/cards/1\n');
  assert.equal(linked.format, 'custom');
  assert.equal(linked.cardtraderLinks, true);
  assert.equal(previewSpreadsheet(CARDTRADER).cardtraderLinks, true);
  assert.equal(previewSpreadsheet(POWERTOOLS).cardtraderLinks, false);
  const named = previewSpreadsheet('Card,Set,Number\n"Pikachu, Promo",Base Set,58\n');
  const payload = importPayload(named);
  assert.match(payload.csv, /"Pikachu, Promo",Base Set,58/);
});

test('the desktop Power Tools sample keeps FUOCOBOMBA locations', () => {
  const path = '/home/nez/Desktop/F. 006 - 16.csv';
  if (!fs.existsSync(path)) return;
  const preview = previewSpreadsheet(fs.readFileSync(path, 'utf8'));
  assert.equal(preview.format, 'powertools');
  assert.ok(preview.rows.length >= 40);
  assert.ok(preview.rows.every((row) => row.location === 'FUOCOBOMBA 006 - 16'));
});

test('a Chatios-sized Power Tools sheet parses quickly and keeps locations', () => {
  const count = 40000;
  const lines = ['cardmarketId,quantity,name,set,setCode,cn,condition,language,finishType,price,location'];
  for (let i = 0; i < count; i += 1) {
    const box = i % 2 === 0 ? 'CHATIOS 012 - 4' : 'CHATIOS 018 - 9';
    lines.push(`${800000 + i},1,Card ${i},Prismatic Evolutions,PRE,${(i % 180) + 1},NM,English,Regular,1.5,${box}`);
  }
  const started = performance.now();
  const preview = previewSpreadsheet(lines.join('\n'));
  const elapsed = performance.now() - started;
  assert.equal(preview.format, 'powertools');
  assert.equal(preview.rows.length, count);
  assert.equal(preview.hasLocation, true);
  assert.equal(preview.rows[0].location, 'CHATIOS 012 - 4');
  assert.equal(preview.rows[1].location, 'CHATIOS 018 - 9');
  assert.ok(elapsed < 1500, `parse took ${elapsed.toFixed(0)}ms`);
});
