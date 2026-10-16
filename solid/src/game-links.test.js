import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));

// Pages that only render on the Pokémon apex: their routes are game-private
// (market/src/game-private-path.js), or the feature is off on game sites
// (Competitive). A raw /marketplace href there is the Pokémon page on purpose.
const APEX_ONLY = new Set([
  'components/inventory/CollectionHoldings.jsx',
  'pages/About.jsx',
  'pages/Associate.jsx',
  'pages/Bought.jsx',
  'pages/Careers.jsx',
  'pages/Cart.jsx',
  'pages/Checkout.jsx',
  'pages/Competitive.jsx',
  'pages/Inventory.jsx',
  'pages/Join.jsx',
  'pages/Messages.jsx',
  'pages/OcrArtists.jsx',
  'pages/Orders.jsx',
  'pages/Profile.jsx',
  'pages/Protection.jsx',
  'pages/Scan.jsx',
  'pages/Site.jsx',
  'pages/Stock.jsx',
  'pages/SyncReview.jsx',
]);

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(file, out);
    else if (entry.name.endsWith('.jsx')) out.push(file);
  }
  return out;
}

// href="/marketplace…", href={`/marketplace…`}, href={'/product…'}: a literal router path.
const RAW_HREF = /href=(?:"|\{\s*[`'"])\/(?:marketplace|product)\b/g;

test('game-site pages give marketplace links the game slug (gameHref)', () => {
  // On /one-piece a raw /marketplace/sets/treasure-cup href rendered a blank page
  // in-app (outside the router base) and the Pokémon "Expansion failed" page on reload.
  const offenders = [];
  for (const file of sources(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (APEX_ONLY.has(rel)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(RAW_HREF)) {
      const line = text.slice(0, match.index).split('\n').length;
      offenders.push(`${rel}:${line}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('set tiles, the promo carousel and see-more links go through gameHref', () => {
  const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
  assert.match(read('components/SetGuideGrid.jsx'), /href=\{gameHref\(`\/marketplace\/sets\//);
  assert.match(read('components/PromoCarousel.jsx'), /href=\{gameHref\(`\/marketplace\/sets\//);
  assert.match(read('components/Carousel.jsx'), /href=\{gameHref\(props\.href\)\}/);
  assert.match(read('components/desk/SeoCrumbs.jsx'), /href=\{gameHref\(item\.href\)\}/);
});

test('claimed link clicks navigate through gameHref', () => {
  // The yield-nav navigator is the safety net for an href that missed gameHref:
  // the router base only applies to resolved navigations, not to claimed paths.
  assert.match(fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8'), /setLinkNavigator\(\(path, options\) => navigate\(gameHref\(path\), options\)\)/);
});
