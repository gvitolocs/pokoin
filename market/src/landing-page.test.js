import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const landing = read('index.html');

test('the landing hero search works without JavaScript (marketplace search page)', () => {
  const form = landing.match(/<form[^>]*class="hero-search"[\s\S]*?<\/form>/)?.[0] || '';
  assert.match(form, /action="\/marketplace\/search"/);
  assert.match(form, /method="get"/);
  assert.match(form, /role="search"/);
  assert.match(form, /<input[^>]*name="q"/);
  assert.match(form, /<button type="submit">Search<\/button>/);
  assert.match(form, /data-landing-suggest/);
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

test('the island search reuses the header typeahead engine', () => {
  const search = read('solid/src/landing/LandingSearch.jsx');
  assert.match(search, /createLiveSuggest\(query/);
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
