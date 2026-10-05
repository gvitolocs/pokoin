'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { importCsvText } = require('./_stock_csv');

const POWERTOOLS = `cardmarketId,quantity,name,set,setCode,cn,condition,language,finishType,price,location
1,1,Abra,Base Set,BS,43,NM,English,Regular,2.00,FUOCOBOMBA 006 - 16
2,1,Kadabra,Base Set,BS,32,NM,English,Regular,3.00,FUOCOBOMBA 006 - 16
`;

const TCGPLAYER = `TCGplayer Id,Product Line,Set Name,Product Name,Number,Condition,Total Quantity,TCG Marketplace Price,Printing,Location
55,Pokemon,Base Set,Pikachu,58,Near Mint,2,1.25,Holofoil,Bin 3
`;

test('spreadsheet import keeps the Power Tools location string', () => {
  const imported = importCsvText(POWERTOOLS, { preserveLocation: true });
  assert.equal(imported.format, 'powertools');
  assert.equal(imported.results[0].row.location, 'FUOCOBOMBA 006 - 16');
  assert.equal(imported.results[1].row.location, 'FUOCOBOMBA 006 - 16');
});

test('TCGPlayer export is recognized and keeps an optional location', () => {
  const imported = importCsvText(TCGPLAYER, { preserveLocation: true });
  assert.equal(imported.format, 'tcgplayer');
  const row = imported.results[0].row;
  assert.equal(row.name, 'Pikachu');
  assert.equal(row.collectorNumber, '58');
  assert.equal(row.quantity, 2);
  assert.equal(row.foilState, 'holo');
  assert.equal(row.location, 'Bin 3');
  assert.equal(row.pricePkn, 250);
});
