import assert from 'node:assert/strict';
import test from 'node:test';
import { FLAG, FORMAT, SPRITE, scanUrl } from './competitive-assets.js';

test('competitive assets stay on Pokoin Oracle, not Limitless', () => {
  assert.equal(SPRITE('dragapult'), '/card-images/competitive/sprites/dragapult.png');
  assert.equal(FORMAT('standard'), '/card-images/competitive/formats/standard.png');
  assert.equal(FLAG('US'), '/card-images/competitive/flags/us.svg');
  assert.equal(scanUrl('TWM', '130'), '/card-images/competitive/scans/TWM_130_R_EN.png');
  assert.equal(scanUrl('dri', '12'), '/card-images/competitive/scans/DRI_012_R_EN.png');
  assert.equal(SPRITE(''), '');
  assert.equal(FLAG(''), '');
});
