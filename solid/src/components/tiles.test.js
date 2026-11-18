import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const tile = read('./CardTile.jsx');
const cardArt = read('./CardArt.jsx');

test('unpriced CardTile copy is Out of stock, not an em dash', () => {
  assert.match(tile, /price\(\) \? <PriceStack[^;]*: 'Out of stock'/);
  assert.doesNotMatch(tile, /price\(\) \|\| '—'/);
  const related = read('./desk/RelatedCards.jsx');
  assert.match(related, /overlayCatalogTilePrices/);
  assert.match(related, /\.slice\(0, 12\)/);
});

test('grid tiles cover the tile art frame: flush slot, 63:88 box, cover fit', () => {
  assert.match(tile, /<span class="tile-art">\s*<Show when=\{art\(\)\} fallback=\{<span class="tile-ph" \/>}/);
  const css = read('../../../market/src/styles.css');
  const frames = css.match(/\.tile-art \{[^}]*\}/g) || [];
  const flush = frames.find((block) => /border-radius:\s*16px 16px 0 0/.test(block));
  assert.ok(flush, '.tile-art frame flush with the tile');
  assert.match(flush, /padding:\s*0;/);
  assert.match(flush, /overflow:\s*hidden;/);
  assert.equal(frames.filter((block) => /padding:\s*0\.[45]rem/.test(block)).length, 0, 'inset art padding left');
  // The aspect-ratio box reserves the slot height, so the grid does not shift on load.
  assert.match(css, /\.tile-art img,\s*\.tile-art \.tile-ph \{[^}]*aspect-ratio:\s*63 \/ 88/);
  assert.match(css, /\.tile-art img \{[^}]*object-fit:\s*cover;[^}]*object-position:\s*center/);
  assert.match(css, /\.tile-meta \{[^}]*padding:\s*0\.55rem 0\.55rem 0\.75rem/);
  // The grid scan reaches the frame as a direct img, never the album crop wrapper.
  assert.match(cardArt, /<Show when=\{props\.cut\} fallback=\{image\(\)\}>/);
  // Hover and keyboard focus still pop the preview out of the frame; the shimmer fills it.
  assert.match(
    css,
    /\.tile:not\(\.tile-album\):hover > \.tile-art,\s*\.tile:not\(\.tile-album\):focus-visible > \.tile-art \{[^}]*overflow:\s*visible/,
  );
  assert.match(
    css,
    /\.tile:not\(\.tile-album\):not\(\.tile-row\) \.tile-art > \.tile-ph \{[^}]*border-radius:\s*16px 16px 0 0/,
  );
  // List rows and album cells keep their own frames.
  assert.match(css, /\.tile-row \.tile-art \{[^}]*border-radius:\s*0;[^}]*overflow:\s*visible/);
  assert.match(css, /\.tile-album \.tile-art \{[^}]*padding:\s*0;[^}]*overflow:\s*hidden;[^}]*border-radius:\s*0/);
});

test('album tiles are photos of the leftover illustration, not hover-scaled cards', () => {
  assert.match(tile, /const cut = \(\) => Boolean\(props\.cut\)/);
  assert.match(tile, /imageSrc\(card\(\), 'hero'\)/);
  assert.match(tile, /full=\{cut\(\)\}/);
  assert.match(tile, /card=\{cut\(\) \? card\(\) : undefined\}/);
  assert.match(tile, /albumShadeStyle\(card\(\)\)/);
  assert.match(tile, /identity\(\)\.tileLine/);
  // The album caption is the printing line only, never the card name.
  const albumMeta = tile.slice(tile.indexOf('when={!cut()}'), tile.indexOf('<div class="tile-meta">\n            <strong>'));
  assert.match(albumMeta, /fallback=/);
  assert.doesNotMatch(albumMeta, /displayName/);
  assert.match(tile, /'tile-tall': tall\(\)/);
  assert.match(tile, /'tile-item': item\(\)/);
  assert.match(tile, /isLandscapePrintName\(card\(\)\.name\)/);
  assert.match(tile, /'is-landscape': landscape\(\)/);
  assert.match(tile, /cut=\{cut\(\) && !landscape\(\) && !item\(\)\}/);
  assert.match(tile, /cutSurface="album"/);
  assert.match(cardArt, /figureMask\(\) && showFigure\(\)/);
  assert.match(cardArt, /class="art-figure-layer art-figure-hover"/);
  assert.match(cardArt, /class="art-figure-layer art-figure-shadow"/);
  assert.match(cardArt, /--art-figure-mask/);
  assert.match(cardArt, /loadFigureBox/);
  assert.match(cardArt, /--figure-cx/);
  assert.match(cardArt, /data-figure/);
  assert.match(cardArt, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
});

test('artwork piles span two rows when tall and extend the selection on modified clicks', () => {
  const pile = read('./ArtworkPile.jsx');
  assert.match(pile, /class=\{\['tile-pile-wrap', \{ 'tile-pile-tall': tall\(\) \}\]\}/);
  assert.match(pile, /event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey/);
  assert.match(pile, /select\.click\(rep\(\)\.id, event\)/);
  assert.match(read('./Carousel.jsx'), /props\.album/);
});

test('the artist album grid, its loading and its filters', () => {
  const artist = read('../pages/Artist.jsx');
  assert.match(artist, /albumShadeStyle\(row\)/);
  assert.match(artist, /<CardTile card=\{group\(\)\.cards\[0\]\} rank=\{index\(\)\} cut \/>/);
  assert.match(artist, /<ArtistPileTile group=\{group\(\)\} rank=\{index\(\)\} onOpen=/);
  // Fast flings that skip past the sentinel must still load more tiles.
  assert.match(artist, /rect\.bottom >= 0 && rect\.top <= window\.innerHeight \+ 800/);
  assert.doesNotMatch(artist, /if \(upward\) return/);
  assert.match(artist, /album-other-prints/);
  assert.match(artist, /fetchArtist\(slug, \{ limit: ARTIST_FIRST \}\)/);
  // A stored album paints at once; the revalidated one replaces it in place.
  assert.match(artist, /fetchArtist\(slug, \{ limit: 5000, onUpdate: \(data\) => paintArtist\(data, \{ replace: true \}\) \}\)/);
  assert.match(artist, /peekArtist\(slug, 5000\)/);
  assert.match(artist, /restoredView/);
  assert.match(artist, /'singles'/);
  assert.match(artist, /sort\(\) !== 'pokedex'/);
  assert.match(read('./SearchToolbar.jsx'), /value="pokedex"/);
  assert.match(artist, /class="tile artist-tile tile-cut tile-album"/);
  assert.match(artist, /class="grid album-grid/);
  assert.match(artist, /<SkeletonTile album \/>/);
  // Filtered printings go to the cart in one click.
  assert.match(artist, /addCatalogCards\(list, addCartItem\)/);
  assert.match(artist, /Add all to cart/);
});

test('the homepage is an unclipped page of plain tiles; era names link the setlist', () => {
  const home = read('../pages/Home.jsx');
  assert.match(home, /class="page home"/);
  assert.doesNotMatch(home, /<CardTile[^>]*\scut/);
  assert.match(read('../pages/Sets.jsx'), /headingHref\(/);
});

test('the opened pile prices a card the way the tiles behind it do', () => {
  const pile = read('./ArtworkPile.jsx');
  // buyerFormat is the tiles' own rule: PKN while the balance covers it, local
  // first when it does not, nothing at all until the buyer is known.
  assert.match(pile, /const price = \(\) => buyerFormat\(tilePricePkn\(card\)\);/);
  assert.match(pile, /import \{ buyerFormat \} from '\.\.\/stores\/buyer\.js';/);
  assert.doesNotMatch(pile, /formatPkn\(/);
});
