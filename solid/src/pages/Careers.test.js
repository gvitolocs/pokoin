import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const careersSrc = fs.readFileSync(new URL('./Careers.jsx', import.meta.url), 'utf8');
const chromeSrc = fs.readFileSync(new URL('../components/Chrome.jsx', import.meta.url), 'utf8');

test('Careers mirrors Phantom module order and rejects About-style invent', () => {
  // Phantom module sequence markers
  assert.match(careersSrc, /careers-intro/);
  assert.match(careersSrc, /careers-media-bleed/);
  assert.match(careersSrc, /careers-prose/);
  assert.match(careersSrc, /PrinciplesSlider|careers-principle-track/);
  assert.match(careersSrc, /careers-perk-grid/);
  assert.match(careersSrc, /id="open-positions"/);
  assert.match(careersSrc, /careers-life-strip/);
  assert.match(careersSrc, /Browse open roles/);
  assert.match(careersSrc, /No open roles right now/);
  // Must not revive the discarded About-clone layout
  assert.doesNotMatch(careersSrc, /careers-facts|Mission<\/strong>|How we work<\/strong>|Where<\/strong>/);
  assert.doesNotMatch(careersSrc, /about-hero|floating mascot|careers-mark/);
  assert.doesNotMatch(careersSrc, /Ashby|phantom\.com|millions of people|Unlimited PTO/i);
});

test('Careers paints the shared principle, benefit and life art', () => {
  assert.match(careersSrc, /from '@market\/careers-art\.js'/);
  assert.match(careersSrc, /LIFE_BUBBLES/);
  assert.match(careersSrc, /LIFE_STRIP/);
  assert.match(careersSrc, /SurfacesSlider/);
  assert.match(careersSrc, /careers-media-bubbles/);
  assert.match(careersSrc, /careers-life-title|careers-life-body/);
  assert.match(careersSrc, /CareersCardArt|is-full-art|is-physical-card|is-art-cut/);
});

test('Chrome footer links to /careers', () => {
  assert.match(chromeSrc, /to=\{APP\.careers\}/);
});
