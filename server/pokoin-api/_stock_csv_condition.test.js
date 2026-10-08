const assert = require('node:assert/strict');
const test = require('node:test');

const { mapConditionFromCm, mapConditionToCm } = require('./_stock_csv');

// help.cardmarket.com/en/CardCondition: GD ≈ US Moderately Played,
// Light Played (LP) ≈ US Played, US "Lightly Played" ≈ EX.
test("Cardmarket / PowerTools conditions follow Cardmarket's own scale", () => {
  assert.equal(mapConditionFromCm('MT'), 'NM');
  assert.equal(mapConditionFromCm('EX'), 'SP');
  assert.equal(mapConditionFromCm('GD'), 'MP');
  assert.equal(mapConditionFromCm('LP'), 'PL');
  assert.equal(mapConditionFromCm('Light Played'), 'PL');
  assert.equal(mapConditionFromCm('PL'), 'PL');
  assert.equal(mapConditionFromCm('Lightly Played'), 'SP');
  assert.equal(mapConditionFromCm('PO'), 'Poor');
});

test('Pokoin grades export back to the Cardmarket scale', () => {
  assert.equal(mapConditionToCm('MP'), 'GD');
  assert.equal(mapConditionToCm('PL'), 'PL');
});
