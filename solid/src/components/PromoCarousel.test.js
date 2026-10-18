import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const promo = read('./PromoCarousel.jsx');
const css = read('../../../market/src/styles.css');

test('a satellite hero paints its stored slides in the first frame', () => {
  // Waiting on the expansions read painted Recently seen too high on BSS / One Piece,
  // then pushed it down 8px (desktop) or a whole slide (phone) when the slides landed.
  assert.match(promo, /createSignal\(initialPokemon \? PROMO_BANNERS : readStoredPromoBanners\(initialId\)\)/);
  // A TCG switch in place paints that game's stored slides too.
  assert.match(promo, /const stored = readStoredPromoBanners\(id\);\n {4}setBanners\(stored\);/);
});

test('the expansions read keeps the painted slide when nothing changed', () => {
  const show = promo.slice(promo.indexOf('function showSlides('), promo.indexOf('onSettled(() => {'));
  assert.match(show, /rememberPromoBanners\(id, slides\);/);
  // The slide is keyed: a new but equal list would remount it and replay its rise.
  assert.match(show, /if \(!samePromoBanners\(untrack\(banners\), slides\)\) setBanners\(slides\);/);
  const loaders = promo.slice(promo.indexOf('onSettled(() => {'), promo.indexOf('// The current slide and its neighbours'));
  assert.doesNotMatch(loaders, /\bsetBanners\(slides\)/, 'reads paint through showSlides');
  assert.equal((loaders.match(/showSlides\(/g) || []).length, 2);
});

test('the stage reserves the dots row and, on a first visit, a slide box', () => {
  assert.match(promo, /class=\{\['promo-stage', \{ 'is-loading': loadingSlides\(\) && !banners\(\)\.length \}\]\}/);
  const dots = css.slice(css.indexOf('.promo-dots {'), css.indexOf('}', css.indexOf('.promo-dots {')));
  assert.match(dots, /min-height: 0\.5rem;/);
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]{0,400}\.promo-stage\.is-loading \.promo \{ min-height: 32rem; \}/);
  assert.match(css, /\.promo \{\n {4}min-height: 0;\n {4}border-radius: 14px;\n {2}\}\n\n[\s\S]{0,80}\.promo-stage\.is-loading \.promo \{ min-height: 28rem; \}/);
});
