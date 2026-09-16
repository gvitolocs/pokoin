import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
const cardArt = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'components/CardArt.jsx'), 'utf8');

test('home rail arrows sit in a reserved gutter beside the track', () => {
  assert.match(css, /grid-template-columns:\s*var\(--rail-gutter\) minmax\(0, 1fr\) var\(--rail-gutter\)/);
  assert.match(css, /\.rail-next:disabled,\s*\.rail-prev:disabled \{[^}]*opacity:\s*0/);
  assert.match(css, /\.rail-scroll > \.carousel-track \{[^}]*overflow:\s*visible/);
  assert.match(css, /\.rail-scroll \{[^}]*margin-top:\s*calc\(-1 \* var\(--rail-hover-bleed\)\)/);
  assert.match(css, /\.rail-scroll \{[^}]*padding-top:\s*var\(--rail-hover-bleed\)/);
  assert.match(css, /\.rail-wrap > \.rail-scroll \{[^}]*padding-inline:\s*calc\(var\(--rail-gutter\) \+ var\(--rail-gutter-gap\)\)/);
  assert.match(css, /\.rail-wrap \{[^}]*--rail-tile:\s*13\.5rem/);
  assert.match(css, /\.carousel-track \{[^}]*grid-auto-columns:\s*var\(--rail-tile\)/);
  assert.match(css, /\.carousel-track \{[^}]*gap:\s*0\.4rem/);
  assert.match(css, /\.rail-next,\s*\.rail-prev \{[^}]*var\(--rail-tile\) \* 88 \/ 63/);
  assert.doesNotMatch(css, /\.tile\.rail-end:hover img/);
  assert.doesNotMatch(css, /\.rail-prev \{ left: 0; \}/);
});

test('phone card info header stays a fixed height so printings do not jump the scan', () => {
  assert.match(css, /@media \(max-width: 480px\) \{[\s\S]*?\.asset-header \{[^}]*height:\s*5\.75rem/);
  assert.match(css, /@media \(max-width: 480px\) \{[\s\S]*?\.asset-title-row h1 \{[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /@media \(max-width: 480px\) \{[\s\S]*?\.asset-sub \{[^}]*white-space:\s*nowrap/);
});

test('CardTile art is a fixed 63:88 slot so missing or oddly sized scans do not shrink the tile', () => {
  assert.match(css, /\.tile-art img,\s*\.tile-art \.tile-ph \{[^}]*aspect-ratio:\s*63 \/ 88/);
  assert.match(css, /\.tile-ph \{[^}]*width:\s*100%/);
  assert.match(css, /\.tile-ph \{[^}]*aspect-ratio:\s*63 \/ 88/);
  assert.match(css, /\.art-frame img\.missing-card[^}]*border-radius:\s*var\(--tcg-corner\)/);
});

test('desk scan is a fixed 63:88 poker slot that does not flex with the panel', () => {
  assert.match(css, /\.art-frame \{[^}]*aspect-ratio:\s*63 \/ 88/);
  assert.match(css, /\.hero-art-col \.art-frame \{[^}]*flex:\s*none/);
  assert.match(css, /\.hero-art-col \.art-frame \{[^}]*aspect-ratio:\s*63 \/ 88/);
  assert.doesNotMatch(css, /\.hero-art-col \.art-frame \{[^}]*flex:\s*1/);
});

test('sold graph tile is a fixed 12rem whether empty or plotted', () => {
  assert.match(css, /\.sold-graph \{[^}]*height:\s*12rem/);
  assert.match(css, /\.sold-graph \{[^}]*max-height:\s*12rem/);
  assert.match(css, /\.sold-graph-empty \{[^}]*position:\s*absolute/);
  assert.match(css, /\.sold-graph-filters \{[^}]*position:\s*absolute/);
  assert.match(css, /\.sold-graph-filters \{[^}]*flex-wrap:\s*nowrap/);
  assert.match(css, /\.sold-graph-filters \{[^}]*align-items:\s*center/);
  assert.doesNotMatch(css, /\.sold-graph-filter-row \{/);
  assert.match(css, /\.sold-graph-units \{[^}]*height:\s*1\.7rem/);
  assert.match(css, /\.sold-graph-units \{[^}]*align-items:\s*center/);
  assert.match(css, /\.sold-graph-tip \{[^}]*z-index:\s*5/);
  assert.match(css, /\.sold-graph-filters select \{[^}]*min-width:\s*0/);
  assert.match(css, /\.sold-graph-filters select \{[^}]*flex:\s*0 1 9\.4rem/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.sold-graph-filters \{[^}]*gap:\s*0\.12rem/);
  assert.match(css, /\.sold-graph-filters select\.is-solo \{[^}]*appearance:\s*none/);
  assert.match(css, /\.sold-graph\.is-all \{[^}]*--sold-line:\s*#f3f4f7/);
  assert.match(css, /\.sold-graph\.is-nm \{[^}]*--sold-line:\s*#147a3f/);
  assert.match(css, /\.sold-graph\.is-sp \{[^}]*--sold-line:\s*#3dcf74/);
  assert.match(css, /\.sold-graph\.is-mp \{[^}]*--sold-line:\s*var\(--yellow\)/);
  assert.match(css, /\.sold-graph\.is-pl \{[^}]*--sold-line:\s*#b87333/);
  assert.match(css, /\.sold-graph\.is-poor \{[^}]*--sold-line:\s*#e44545/);
  assert.doesNotMatch(css, /\.analytics-empty \{/);
});

test('CardTile pads the full scan on every side so the label cannot sit on the bottom border', () => {
  const desktop = css.slice(0, css.indexOf('@media (max-width: 480px)'));
  const phone = css.slice(css.indexOf('@media (max-width: 480px)'));
  const art = desktop.match(/\.tile-art \{\s*padding:[^}]+\}/g)?.find((block) => /padding:\s*0\./.test(block));
  assert.ok(art, 'desktop .tile-art padding');
  assert.match(art, /padding:\s*0\.5rem;/);
  assert.doesNotMatch(art, /0\.5rem 0\.5rem 0/);
  const phoneArt = phone.match(/\.tile-art \{\s*padding:[^}]+\}/);
  assert.ok(phoneArt, 'phone .tile-art padding');
  assert.match(phoneArt[0], /padding:\s*0\.45rem;/);
  assert.doesNotMatch(phoneArt[0], /0\.45rem 0\.45rem 0/);
});

test('More versions sits on a gold halo so the link is visible without set circles', () => {
  assert.match(css, /\.more-versions \{[^}]*box-shadow:/);
  assert.match(css, /\.more-versions \{[^}]*color:\s*var\(--yellow\)/);
  assert.match(css, /\.more-versions\.is-solo \{[^}]*box-shadow:/);
});

test('era names are gold links to the era setlist', () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const versions = readFileSync(join(root, 'pages/Versions.jsx'), 'utf8');
  const sets = readFileSync(join(root, 'pages/Sets.jsx'), 'utf8');
  assert.match(css, /\.era-link \{[^}]*color:\s*var\(--yellow\)/);
  assert.match(versions, /className="era-link"/);
  assert.match(versions, /eraHref\(group\.label\)/);
  assert.match(versions, /<h2>Rarity Lineup<\/h2>/);
  assert.match(sets, /headingHref\(era\)/);
});

test('set browse list view is one column with compact row tiles', () => {
  assert.match(css, /\.grid\.is-list \{[^}]*grid-template-columns:\s*1fr/);
  assert.match(css, /\.tile-row \{[^}]*flex-direction:\s*row/);
  assert.match(css, /\.tile-row \.tile-art \{[^}]*flex:\s*0 0 3\.35rem/);
});

test('unpriced CardTile copy is Out of stock, not an em dash', () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const tile = readFileSync(join(root, 'components/CardTile.jsx'), 'utf8');
  assert.match(tile, /price \|\| 'Out of stock'/);
  assert.doesNotMatch(tile, /price \|\| '—'/);
  assert.match(css, /\.tile-meta \.oos \{[^}]*font-size:\s*0\.72rem/);
  const related = readFileSync(join(root, 'components/RelatedCards.jsx'), 'utf8');
  assert.match(related, /overlayCatalogTilePrices/);
  assert.match(related, /priced\.slice\(0, 12\)/);
});

test('artist tiles are still album photos of the leftover illustration, not hover-scaled cards', () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const tile = readFileSync(join(root, 'components/CardTile.jsx'), 'utf8');
  const artist = readFileSync(join(root, 'pages/Artist.jsx'), 'utf8');
  const carousel = readFileSync(join(root, 'components/Carousel.jsx'), 'utf8');
  assert.match(tile, /cut = false/);
  assert.match(tile, /imageSrc\(card, 'hero'\)/);
  assert.match(tile, /full=\{cut\}/);
  assert.match(tile, /card=\{cut \? card : undefined\}/);
  assert.match(tile, /albumShadeStyle\(card\)/);
  assert.match(tile, /cut \? \(/);
  assert.match(tile, /identity\.tileLine/);
  assert.doesNotMatch(tile, /cut \? displayName/);
  assert.match(artist, /albumShadeStyle\(row\)/);
  assert.match(artist, /<CardTile key=\{albumTileKey\(card\)\} card=\{card\} rank=\{index\} cut \/>/);
  assert.match(artist, /fetchArtist\(artistSlug, \{ limit: 5000 \}\)/);
  assert.match(artist, /peekArtist\(artistSlug, 5000\)/);
  assert.match(artist, /restoredPageView/);
  assert.match(artist, /'singles'/);
  assert.match(artist, /sort !== 'pokedex'/);
  assert.match(readFileSync(join(root, 'components/SearchToolbar.jsx'), 'utf8'), /value="pokedex"/);
  assert.match(artist, /className="tile artist-tile tile-cut tile-album"/);
  assert.match(artist, /className="grid album-grid/);
  assert.match(artist, /<SkeletonTile key=\{index\} album \/>/);
  assert.match(artist, /cut\s*\n\s*full/);
  assert.match(carousel, /album = false/);
  assert.match(css, /\.grid\.album-grid \{[^}]*grid-template-columns:\s*repeat\(4/);
  assert.match(css, /\.grid\.album-grid \{[^}]*grid-auto-flow:\s*dense/);
  assert.doesNotMatch(css, /html, body \{\s*overflow-x:\s*clip/);
  assert.doesNotMatch(css, /\.page, \.card-page \{[^}]*overflow-x:\s*clip/);
  assert.doesNotMatch(css, /\.tile-album \{[^}]*overscroll-behavior:\s*none/);
  assert.match(css, /\.tile-album \{[^}]*contain:\s*paint/);
  assert.match(css, /\.shell \{[^}]*max-width:\s*100%/);
  assert.match(css, /html \{\s*overscroll-behavior-x:\s*none/);
  assert.match(css, /\.page\.home \{\s*overflow:\s*clip/);
  assert.match(css, /html:has\(\.page\.home\) \{\s*overflow-x:\s*clip/);
  assert.match(
    css,
    /@supports \(object-view-box: none\) \{[\s\S]*?left:\s*0;[\s\S]*?object-view-box:\s*xywh\(/,
  );
  assert.match(readFileSync(join(root, 'pages/Home.jsx'), 'utf8'), /className="page home"/);
  assert.match(css, /\.tile-album \{/);
  assert.match(css, /\.tile-album\.tile-tall \{[^}]*grid-row:\s*span 2/);
  assert.match(css, /\.tile-album\.tile-tall \{[^}]*width:\s*100%/);
  assert.match(css, /\.tile-album\.tile-tall \{[^}]*align-self:\s*stretch/);
  assert.match(css, /\.tile-album\.tile-tall::before \{[^}]*88 \/ \(2 \* 63\)/);
  assert.match(
    css,
    /\.tile-album:not\(\.tile-tall\):not\(\.is-landscape\):not\(\.tile-item\) \.art-cut,[\s\S]*?aspect-ratio:\s*88 \/ 63/,
  );
  assert.match(css, /\.tile-album\.tile-tall \.art-cut \{[^}]*aspect-ratio:\s*auto/);
  assert.match(css, /\.tile\.tile-album\.tile-tall \.tile-art \.art-cut img,[^}]*width:\s*calc\(100% \/ var\(--art-width\)\)/);
  assert.match(css, /\.tile\.tile-album\.tile-tall \.tile-art \.art-cut img,[^}]*margin-top:\s*calc\(-100% \* var\(--art-top\)/);
  assert.doesNotMatch(css, /\.tile\.tile-album\.tile-tall \.tile-art \.art-cut img,[^}]*height:\s*calc\(100% \/ var\(--art-height\)\)/);
  assert.match(css, /\.tile-album\.tile-item \.tile-art img \{[^}]*object-fit:\s*contain/);
  assert.doesNotMatch(css, /\.tile-album\.tile-tall \.tile-art img \{[^}]*object-fit:\s*contain/);
  assert.doesNotMatch(css, /\.tile-album\.tile-wide \{/);
  assert.match(css, /\.tile-album \.tile-art \{[^}]*padding:\s*0/);
  assert.match(css, /\.tile-album \.tile-meta \{[^}]*position:\s*absolute/);
  assert.match(css, /\.tile-album \.tile-meta \{[^}]*text-align:\s*center/);
  assert.match(css, /\.tile-album \.tile-meta \{[^}]*background:\s*none/);
  assert.doesNotMatch(
    css,
    /\.tile-album:not\(\.tile-tall\):not\(\.is-landscape\):not\(\.tile-item\) \.art-cut img \{[^}]*var\(--art-top\) \* 0\.42/,
  );
  assert.match(
    css,
    /\.tile\.tile-album:not\(\.tile-tall\):not\(\.is-landscape\):not\(\.tile-item\) \.tile-art \.art-cut img,[^}]*width:\s*calc\(100% \/ var\(--art-width\)\)/,
  );
  assert.match(
    css,
    /\.tile\.tile-album:not\(\.tile-tall\):not\(\.is-landscape\):not\(\.tile-item\) \.tile-art \.art-cut img,[^}]*50% - 100%/,
  );
  assert.doesNotMatch(css, /--art-view-y:/);
  assert.doesNotMatch(css, /--art-view-h:/);
  assert.match(
    css,
    /@supports \(object-view-box: none\) \{[\s\S]*?\.tile-album:not\(\.tile-tall\)[\s\S]*?object-fit:\s*contain;[\s\S]*?object-position:\s*center;[\s\S]*?var\(--art-top\)/,
  );
  assert.match(
    css,
    /@supports \(object-view-box: none\) \{[\s\S]*?\.tile-album\.tile-tall[\s\S]*?object-fit:\s*contain;[\s\S]*?var\(--art-height\)/,
  );
  assert.doesNotMatch(
    css,
    /object-view-box:\s*xywh\([\s\S]*?\(1 - var\(--art-top\)\)/,
  );
  assert.match(
    css,
    /\.tile-album:not\(\.is-landscape\):not\(\.tile-item\) \.art-cut \{[^}]*mask-image:\s*linear-gradient\(to bottom, transparent/,
  );
  assert.match(css, /\.tile-album \.tile-art::before \{[^}]*z-index:\s*1/);
  assert.match(
    css,
    /\.tile-album \.tile-art::before \{[^}]*color-mix\(in srgb, var\(--album-shade/,
  );
  assert.match(
    css,
    /\.tile-album \.tile-art::after \{[^}]*color-mix\(in srgb, var\(--album-shade/,
  );
  assert.doesNotMatch(css, /\.tile-album \.tile-art::before \{[^}]*rgb\(8 10 16/);
  assert.match(css, /\.tile-album \.tile-art::before \{[^}]*mask-image:\s*linear-gradient\(to bottom/);
  assert.match(css, /\.tile-album \.tile-art::after \{[^}]*mask-image:\s*linear-gradient\(to top/);
  assert.doesNotMatch(css, /\.tile-album \.tile-meta \{[^}]*backdrop-filter:/);
  assert.doesNotMatch(css, /\.tile-album \.tile-meta::before/);
  assert.match(tile, /tall \? 'tile-tall'/);
  assert.match(tile, /item \? 'tile-item'/);
  assert.match(tile, /isLandscapePrintName\(card\.name\)/);
  assert.match(tile, /landscape \? 'is-landscape'/);
  assert.match(tile, /cut=\{cut && !landscape && !item\}/);
  assert.match(tile, /cutSurface="album"/);
  assert.match(css, /\.tile\.tile-album:hover img,/);
  assert.match(css, /transform:\s*none !important/);
  assert.match(cardArt, /className="art-figure-layer art-figure-hover"/);
  assert.match(cardArt, /className="art-figure-layer art-figure-shadow"/);
  assert.match(cardArt, /--art-figure-mask/);
  assert.match(css, /\.tile\.tile-album:hover \.art-cut img\.art-figure-hover \{[^}]*transform:\s*scale\(1\.12\) !important/);
  assert.match(css, /mask-image:\s*var\(--art-figure-mask\)/);
  assert.match(css, /img\.art-figure-shadow \{[^}]*brightness\(0\) blur\(9px\)/);
  assert.match(css, /img:not\(\.art-figure-layer\)/);
  assert.match(css, /\.tile-cut \.tile-art \.art-cut img \{/);
  assert.match(css, /\.tile-album\.is-landscape \.tile-art \{[^}]*aspect-ratio:\s*88 \/ 63/);
  assert.match(css, /\.tile-album\.is-landscape \.tile-art \{[^}]*container-type:\s*size/);
  assert.match(css, /\.tile\.tile-album\.is-landscape img,[^}]*rotate\(90deg\)/);
  assert.doesNotMatch(
    readFileSync(join(root, 'pages/Home.jsx'), 'utf8'),
    /<CardTile[^>]*\scut/,
  );
});

test('list-form selects use a transparent chevron so Standard is not covered', () => {
  assert.match(css, /\.sell-field select \{[^}]*appearance:\s*none/);
  assert.match(css, /\.sell-field select \{[^}]*background-image:\s*url\("data:image\/svg\+xml/);
  assert.match(css, /\.sell-options-row \.foil-pick \{[^}]*width:\s*7\.4rem/);
});
