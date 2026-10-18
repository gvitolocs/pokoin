import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const landing = read('index.html');

test('the landing hero search works without JavaScript (marketplace search page)', () => {
  const form = landing.match(/<form[^>]*class="search search-hero"[\s\S]*?<\/form>/)?.[0] || '';
  assert.match(form, /action="\/marketplace\/search"/);
  assert.match(form, /method="get"/);
  assert.match(form, /role="search"/);
  assert.match(form, /data-landing-search/);
  assert.match(form, /<input[^>]*id="hero-q"/);
  assert.match(form, /<input[^>]*name="q"/);
  assert.match(form, /<button class="search-go" type="submit">Search<\/button>/);
});

test('the hero first paint is the header SearchBox markup with its three pickers', () => {
  const form = landing.match(/<form[^>]*class="search search-hero"[\s\S]*?<\/form>/)?.[0] || '';
  assert.match(form, /<div class="search-pill">/);
  assert.match(form, /<div class="search-lead">/);
  for (const picker of ['game-select', 'lang-toggle', 'print-lang-toggle']) {
    assert.match(form, new RegExp(`<div class="${picker}" data-landing-picker="${picker}">`));
  }
});

test('the landing offers Shop cards and Sell your collection', () => {
  assert.match(landing, /href="\/marketplace"[^>]*>Shop cards/);
  assert.match(landing, />Sell your collection</);
  assert.match(landing, /id="sell"/);
});

test('the Best sellers rail is the island over the Rust best-sellers rail', () => {
  assert.match(landing, /data-landing-rail="bestSellers"/);
  assert.match(landing, /<script type="module" src="\/market\/landing-island\.js"><\/script>/);
  const rail = read('solid/src/landing/LandingRail.jsx');
  assert.match(rail, /fetchHomeRail\(props\.kind \|\| 'bestSellers'\)/);
  assert.match(rail, /<Carousel/);
});

test('the island search is the header SearchBox', () => {
  const search = read('solid/src/landing/LandingSearch.jsx');
  assert.match(search, /import SearchBox from '\.\.\/components\/SearchBox\.jsx';/);
  assert.match(search, /<SearchBox\s+hero/);
});

test('the build points the landing at the hashed island entry', () => {
  assert.match(read('solid/package.json'), /vite build --config vite\.landing\.config\.js/);
  const build = read('scripts/build-web.sh');
  assert.match(build, /landing-manifest\.json/);
  assert.match(build, /src\/landing\/island\.jsx/);
});

test('homepage styles do not underline text', () => {
  assert.doesNotMatch(read('home/home.css'), /text-decoration:\s*underline/);
});
