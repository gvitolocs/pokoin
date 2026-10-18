import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const card = read('./pages/Card.jsx');
const art = read('./components/CardArt.jsx');
const shop = read('./components/desk/ShopListing.jsx');
const guide = read('./components/SetGuideGrid.jsx');
const mark = read('./components/ExpansionMark.jsx');
const silver = read('./components/desk/SilverHead.jsx');
const form = read('./components/desk/ListingForm.jsx');
const seller = read('./pages/Seller.jsx');
const artist = read('./pages/Artist.jsx');
const rails = read('./lib/cart-rails.js');
const styles = read('../../market/src/styles.css');

test('a desk reload paints its last listings, print language and version select, then reconciles', () => {
  assert.match(card, /readDeskListings\(deskGame, cardId\)/);
  assert.match(card, /createSignal\(peekHasListingRows\(listed\) \|\| Boolean\(stored\)\)/);
  assert.match(card, /if \(seq === listingsSeq\) writeDeskListings\(deskGame, cardId, rows\)/);
  assert.match(card, /peekPrintNationality\(setSlug\(/);
  assert.match(card, /readDeskVersions\(deskGame, cardId\)/);
  // Equal rows from a revalidation keep their nodes.
  assert.match(card, /<For each=\{versionRows\(\)\} keyed=\{\(row\) => String\(row\.id\)\}>/);
  assert.match(card, /<For each=\{setShortcuts\(\)\} keyed=\{\(row\) => String\(row\.id\)\}>/);
});

test('signed-in desk panels paint on the cached session, not after Firebase', () => {
  assert.match(card, /signedIn\(\) \? String\(authUid\(\) \|\| authSession\(\)\?\.uid \|\| ''\) : ''/);
  assert.doesNotMatch(silver, /!authReady\(\)/);
  assert.match(form, /const ready = \(\) => authReady\(\) \|\| signedIn\(\);/);
});

test('an image that failed on this browser paints its working sibling at once', () => {
  assert.match(art, /firstIndex\(urls\(\)\)/);
  assert.match(art, /rememberImageFallback\(urls\(\)\[0\], current\(\)\)/);
  assert.match(art, /workingImage\(urls\(\)\[0\]\) === DEAD_IMAGE/);
  assert.match(shop, /const thumb = \(\) => workingImage\(listedThumb\(\)\);/);
  assert.match(guide, /workingImage\(logo\(\)\) === DEAD_IMAGE/);
  assert.match(mark, /workingImage\(src\(\)\) === DEAD_IMAGE/);
});

test('shop, artist and cart paint their last answer instead of a placeholder', () => {
  assert.match(seller, /knownCounts\?\.copies \?\? '…'/);
  assert.match(seller, /rememberSellerIdentity\(handle, header\)/);
  assert.match(artist, /if \(artistAlbumStored\(slug\)\) firstTimer = window\.setTimeout\(firstPage, 300\);/);
  assert.match(rails, /const stored = readStoredRecs\(firstKey\);/);
  assert.match(rails, /JSON\.stringify\(current\.rails\) === JSON\.stringify\(rails\)\) return;/);
});

test('skeletons and loading text stay invisible for 250 ms', () => {
  assert.match(styles, /@keyframes skel-appear/);
  const rule = styles.slice(styles.indexOf('.tile-skel,\n.shop-row-skel'), styles.indexOf('@keyframes skel-shimmer'));
  for (const name of ['.tile-skel', '.shop-row-skel', '.skeleton-line', '.wait-text']) assert.ok(rule.includes(name), name);
  assert.match(rule, /animation-delay: 250ms;/);
});
