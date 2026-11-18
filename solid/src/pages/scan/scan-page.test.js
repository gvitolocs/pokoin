import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.join(here, '..', 'Scan.jsx'), 'utf8');
const camera = fs.readFileSync(path.join(here, 'live-camera.js'), 'utf8');

test('/scan shows no developer copy', () => {
  for (const text of ['api.pokoin.com', 'pokemon_generic', 'TCGPlayer', 'leftover', 'desk URLs']) {
    assert.ok(!page.includes(text), `Scan.jsx mentions ${text}`);
  }
});

test('/scan identifies through the shared scanner rules, not its own URLs', () => {
  assert.match(camera, /scanIdentifyUrl\(/);
  assert.match(camera, /readScanResult\(/);
  assert.ok(!/fetch\(`[^`]*\/identify/.test(camera), 'identify URL is built by @market/scan-live.js');
});

test('/scan releases the camera when the page goes away', () => {
  assert.match(page, /engine\?\.destroy\(\)/);
  assert.match(camera, /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
  assert.match(camera, /visibilitychange/);
});

test('/scan has a photo fallback for browsers without a camera', () => {
  assert.match(page, /type="file" accept="image\/\*"/);
  assert.match(page, /onDrop=\{onDrop\}/);
  assert.match(camera, /camera: 'unavailable'/);
});
