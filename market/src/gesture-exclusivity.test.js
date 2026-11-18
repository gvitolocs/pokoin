import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const market = path.join(root, 'market/src');

test('desk title / set / artist stay out of shop marquee', () => {
  const marquee = fs.readFileSync(path.join(market, 'shop-marquee.js'), 'utf8');
  assert.match(marquee, /\.species-drag/);
  assert.match(marquee, /\.asset-header/);
  assert.match(marquee, /\.asset-sub/);
});

// The UI side of these gestures (shop rows, header trays, desk drags, select
// band) is guarded in solid/src/components/{desk/ShopListing,trays,card-select}.test.js
// and solid/src/pages/Card.test.js.
test('desk title/set/artist drags open the trays through pokoin-card-drag; Desktop drops are shared', () => {
  const listing = fs.readFileSync(path.join(market, 'chat-listing.js'), 'utf8');
  assert.match(listing, /pokoin-card-drag/);
  const desk = fs.readFileSync(path.join(market, 'desktop-drop-add.js'), 'utf8');
  assert.match(desk, /bundle\.kind === 'expansion'/);
  assert.match(desk, /expansion:\$\{bundle\.slug\}/);
  assert.doesNotMatch(desk, /fetchExpansionCards/);
});
test('PlusCal GestureExclusivity model + TLC invariants', () => {
  const spec = fs.readFileSync(path.join(root, 'specs/GestureExclusivity.tla'), 'utf8');
  assert.match(spec, /InvArtNeverArms/);
  assert.match(spec, /InvTitleNeverArms/);
  assert.match(spec, /InvShopRowNeverArms/);
  assert.match(spec, /InvEmptyBandCanSelectArt/);
  assert.match(spec, /InvEmptyBandCanSelectShop/);
  assert.match(spec, /InvMultiDragPiles/);
  assert.match(spec, /InvRelatedOrDeskMultiPiles/);
  assert.match(spec, /SpeciesTitle/);
  assert.match(spec, /pileSize/);
  assert.match(spec, /CanBand\(t\)\s*==\s*t = BandEmpty/);
  const cfg = fs.readFileSync(path.join(root, 'specs/GestureExclusivity.cfg'), 'utf8');
  assert.match(cfg, /InvMultiDragPiles/);
  assert.match(cfg, /InvEmptyBandCanSelectArt/);
  assert.match(cfg, /InvShopRowNeverArms/);
  assert.match(cfg, /ArtistLink/);

  const script = path.join(root, 'scripts/check-gesture-tlc.sh');
  const javaHome = process.env.JAVA_HOME
    || (fs.existsSync('/home/nez/tools/jdk-21.0.12.1+1')
      ? '/home/nez/tools/jdk-21.0.12.1+1'
      : '');
  const env = { ...process.env };
  if (javaHome) env.JAVA_HOME = javaHome;
  const run = spawnSync('bash', [script], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (run.status !== 0) {
    assert.fail(`TLC failed:\n${run.stdout}\n${run.stderr}`);
  }
  assert.match(run.stdout + run.stderr, /Model checking completed\. No error/);
});
