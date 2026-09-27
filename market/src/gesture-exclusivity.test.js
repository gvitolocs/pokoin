import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const market = path.join(root, 'market/src');

test('shop listing line never adds to cart on row click — cart icon, buy-btn, or drag', () => {
  const row = fs.readFileSync(path.join(market, 'components/ShopListing.jsx'), 'utf8');
  assert.equal(row.includes('onBuy'), false);
  assert.match(row, /onCart/);
  assert.match(row, /Add to cart/);
  assert.equal(row.includes('onClick={buy}'), false);
  assert.match(row, /listingsReference/);
  assert.match(row, /writeListingDrag/);

  const shopList = fs.readFileSync(path.join(market, 'components/ShopList.jsx'), 'utf8');
  assert.match(shopList, /Only cancel HTML5 drag while a marquee is actively armed/);
  assert.match(shopList, /pointercancel/);
  assert.match(shopList, /!origin \|\| !armed/);

  const card = fs.readFileSync(path.join(market, 'pages/Card.jsx'), 'utf8');
  assert.match(card, /onCart=\{\(qty\) => addItem/);
  const seller = fs.readFileSync(path.join(market, 'pages/Seller.jsx'), 'utf8');
  assert.match(seller, /onCart=\{\(qty\) =>/);
});

test('desk title / set / artist stay out of shop marquee', () => {
  const marquee = fs.readFileSync(path.join(market, 'shop-marquee.js'), 'utf8');
  assert.match(marquee, /\.species-drag/);
  assert.match(marquee, /\.asset-header/);
  assert.match(marquee, /\.asset-sub/);
});

test('CardSelectGrid bands desk+related via main-scoped data-card-id', () => {
  const source = fs.readFileSync(path.join(market, 'components/CardSelectGrid.jsx'), 'utf8');
  assert.match(source, /\.art-frame/);
  assert.match(source, /\.shop-panel/);
  assert.match(source, /closest\?\.\('main'\)/);
  assert.match(source, /contents/);
  const page = fs.readFileSync(path.join(market, 'pages/Card.jsx'), 'utf8');
  assert.match(page, /DeskArtFrame/);
  assert.match(page, /embedded/);
});

test('PlusCal GestureExclusivity model + TLC invariants', () => {
  const spec = fs.readFileSync(path.join(root, 'specs/GestureExclusivity.tla'), 'utf8');
  assert.match(spec, /InvArtNeverArms/);
  assert.match(spec, /InvTitleNeverArms/);
  assert.match(spec, /InvEmptyBandCanSelectArt/);
  assert.match(spec, /InvMultiDragPiles/);
  assert.match(spec, /InvRelatedOrDeskMultiPiles/);
  assert.match(spec, /SpeciesTitle/);
  assert.match(spec, /pileSize/);
  const cfg = fs.readFileSync(path.join(root, 'specs/GestureExclusivity.cfg'), 'utf8');
  assert.match(cfg, /InvMultiDragPiles/);
  assert.match(cfg, /InvEmptyBandCanSelectArt/);
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
