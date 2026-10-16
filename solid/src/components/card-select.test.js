import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const band = read('../lib/select-band.js');
const gestures = read('../lib/select-band-gestures.js');
const chrome = read('./Chrome.jsx');
const grid = read('./CardSelectGrid.jsx');
const shop = read('./desk/ShopListing.jsx');
const frame = read('./desk/DeskArtFrame.jsx');
const card = read('../pages/Card.jsx');
const seller = read('../pages/Seller.jsx');

test('the held card leads the multi-select drag pile across every registered rail', () => {
  assert.match(gestures, /cardsForDragFromCatalog/);
  assert.match(grid, /registerGridCards\(gridKey, cards\)/);
  assert.match(band, /for \(const list of gridCards\.values\(\)\)/);
});

test('select band stays mounted under Chrome so navigation does not rewarm it', () => {
  assert.match(chrome, /installSelectBand\(/);
  assert.match(chrome, /<SelectBandBox \/>/);
  assert.match(band, /App-lifetime card selection/);
  assert.doesNotMatch(grid, /addEventListener\('pointerdown'/);
  assert.doesNotMatch(shop, /addEventListener\('pointerdown'/);
});

test('bands start on empty background, touch desk + related tiles and listings, and stay off where not allowed', () => {
  assert.match(gestures, /selectBandAllowed\(event\)/);
  assert.match(gestures, /marqueeStartAllowed\(target\)/);
  assert.match(gestures, /\[data-card-id\]/);
  assert.match(gestures, /function listingRects/);
  assert.match(gestures, /shop-row\[data-listing-id\]/);
  assert.match(gestures, /mixedDeskDragReference/);
});

test('the desk scan joins the selection and drags the pile it is part of', () => {
  assert.match(card, /<CardSelectGrid class="card-desk-select" contents>/);
  assert.match(card, /<DeskArtFrame card=\{card\(\)\} art=\{art\(\)\} offers=\{shop\.offers\} onZoom=\{openZoom\} \/>/);
  assert.doesNotMatch(card, /<button[\s\S]*class="art-frame"/);
  assert.match(frame, /data-card-id=\{id\(\) \|\| undefined\}/);
  assert.match(frame, /'is-selected': picked\(\)/);
  assert.match(frame, /deskDragReference\(\{ heldCard: props\.card \}\)/);
  assert.match(frame, /group\?\.kind === 'cards' \? group : dragThisCard\(props\.card, props\.offers \|\| \[\]\)/);
  // The open chat peer's listing when dropping one card (chat-dock-store).
  assert.match(frame, /import \{ getChatDock \} from '@market\/chat-dock-store\.js'/);
  assert.match(frame, /const dock = getChatDock\(\)/);
});

test('desk and seller shop lists register their offers and read the listing selection', () => {
  assert.match(shop, /registerShop\(shop\)/);
  assert.match(shop, /unregisterShop\(\)/);
  // The desk splits its offers into the Vault and the Shop list; both register and drag.
  for (const list of ['vault', 'shop']) {
    assert.match(card, new RegExp(`<ShopList offers=\\{split\\(\\)\\.${list}\\} deskCard=\\{card\\(\\)\\}>`));
    assert.match(card, new RegExp(`dragOffers=\\{shopDragOffers\\(split\\(\\)\\.${list}, listingSelected\\(\\), offer\\)\\}`));
  }
  assert.match(card, /selected=\{listingSelected\(\)\.has\(listingSelectId\(offer\)\)\}/);
  assert.match(seller, /<ShopList class="seller-shop-list" offers=\{shownOffers\(\)\}>/);
  assert.match(seller, /selected=\{listingSelected\(\)\.has\(listingSelectId\(row\(\)\.enriched\)\)\}/);
});

test('every browsing card grid can select tiles', () => {
  for (const file of [
    '../pages/Home.jsx',
    '../pages/Search.jsx',
    '../pages/Expansion.jsx',
    '../pages/Artist.jsx',
    '../pages/Products.jsx',
    '../pages/Watchlist.jsx',
    '../pages/PokemonHub.jsx',
    '../pages/RarityHub.jsx',
    '../pages/Versions.jsx',
    './desk/RelatedCards.jsx',
    './Carousel.jsx',
  ]) {
    assert.match(read(file), /CardSelectGrid/, file);
  }
  const tile = read('./CardTile.jsx');
  assert.match(tile, /'is-selected': picked\(\)/);
  assert.match(tile, /select\?\.dragPayload\(card\(\)\)/);
});
