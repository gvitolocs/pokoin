import assert from 'node:assert/strict';
import test from 'node:test';
import { publicIdFromScanHit, scanCatalogId } from './scan-id.js';

test('pokemon_western hit uses public_id, never doubles it', () => {
  assert.equal(publicIdFromScanHit({
    id: '316458',
    ct_id: '158229',
    public_id: '316458',
    identity: 'public_id',
    pokoin_url: 'https://pokoin.com/316458',
    name: 'Larvesta',
  }), '316458');
});

test('tcgplayer hit uses public_id, not product id 632917', () => {
  assert.equal(publicIdFromScanHit({
    id: '632917',
    identity: 'tcgplayer',
    name: 'Some printing',
  }), '');
  assert.equal(publicIdFromScanHit({
    id: '241675',
    ct_id: '158229',
    public_id: '316458',
    identity: 'tcgplayer',
    pokoin_url: 'https://pokoin.com/316458',
  }), '316458');
});

test('explicit public_id wins over leftover id', () => {
  assert.equal(publicIdFromScanHit({
    id: '399354',
    public_id: '798708',
  }), '798708');
});

test('ct_id still doubles when public_id is missing', () => {
  assert.equal(publicIdFromScanHit({
    ct_id: '158229',
    name: 'Larvesta',
  }), '316458');
});

test('legacy Milo id-only leftover still doubles', () => {
  assert.equal(publicIdFromScanHit({
    id: '110481',
    name: 'Espurr',
  }), '220962');
});

test('scan catalog follows host and print region, not tcgplayer', () => {
  assert.equal(scanCatalogId('pokoin.com', 'all'), 'pokemon_generic');
  assert.equal(scanCatalogId('pokoin.com', 'japanese'), 'pokemon_japanese');
  assert.equal(scanCatalogId('pokoin.com', 'chinese'), 'pokemon_chinese');
  assert.equal(scanCatalogId('onepiece.pokoin.com', 'all'), 'one_piece_singles');
  assert.equal(scanCatalogId('riftbound.pokoin.com', 'all'), 'riftbound_western');
});
