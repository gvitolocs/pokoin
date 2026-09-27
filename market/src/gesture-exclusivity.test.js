import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const market = path.join(root, 'market/src');

test('shop listing line never adds to cart — drag or desk buy-btn only', () => {
  const row = fs.readFileSync(path.join(market, 'components/ShopListing.jsx'), 'utf8');
  assert.equal(row.includes('onBuy'), false);
  assert.equal(row.includes('onCart'), false);
  assert.equal(row.includes('onClick={buy}'), false);
  assert.equal(row.includes('is-buy'), false);
  assert.equal(row.includes('Add to cart'), false);
  assert.equal(row.includes('CartIcon'), false);
  assert.match(row, /Message this seller about this listing/);
  assert.match(row, /writeListingDrag/);

  const card = fs.readFileSync(path.join(market, 'pages/Card.jsx'), 'utf8');
  assert.match(card, /className="btn buy-btn"/);
  assert.match(card, /Add to cart/);
  assert.equal(/ShopListingRow[\s\S]*?onBuy=/.test(card), false);
  assert.equal(/ShopListingRow[\s\S]*?onCart=/.test(card), false);

  const seller = fs.readFileSync(path.join(market, 'pages/Seller.jsx'), 'utf8');
  assert.equal(seller.includes('onBuy'), false);
  assert.equal(seller.includes('onCart'), false);
  assert.equal(seller.includes('addItem'), false);

  const shopList = fs.readFileSync(path.join(market, 'components/ShopList.jsx'), 'utf8');
  assert.equal(shopList.includes("replay it"), false);
  assert.equal(/closest\('\.shop-row'\)\.dispatchEvent/.test(shopList), false);
});

test('CardSelectGrid keeps art-frame and shop-panel out of tile banding', () => {
  const source = fs.readFileSync(path.join(market, 'components/CardSelectGrid.jsx'), 'utf8');
  assert.match(source, /\.art-frame/);
  assert.match(source, /\.shop-panel/);
  assert.match(source, /\.cart-drop/);
  assert.match(source, /\.desktop-drop/);
});

test('PlusCal GestureExclusivity model + TLC invariants', () => {
  const spec = fs.readFileSync(path.join(root, 'specs/GestureExclusivity.tla'), 'utf8');
  assert.match(spec, /InvMutualExclusion/);
  assert.match(spec, /InvArtNeverBands/);
  assert.match(spec, /InvArtNeverSelected/);
  assert.match(spec, /InvEmptyBandCanSelectShop/);
  assert.match(spec, /InvListingGhostIsCardArt/);
  assert.match(spec, /InvListingRicherThanCard/);
  assert.match(spec, /BandEmpty/);
  assert.match(spec, /clickShopRow/);
  const cfg = fs.readFileSync(path.join(root, 'specs/GestureExclusivity.cfg'), 'utf8');
  assert.match(cfg, /InvArtNeverSelected/);
  assert.match(cfg, /InvListingGhostIsCardArt/);
  assert.match(cfg, /RelatedTile/);

  const script = path.join(root, 'scripts/check-gesture-tlc.sh');
  assert.ok(fs.existsSync(script));
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
