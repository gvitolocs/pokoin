import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAREERS_CONTACT,
  OPEN_ROLES,
  groupRolesByDepartment,
  roleHref,
  roleMeta,
} from './careers-jobs.js';
import { APP } from './punchouts.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const appSrc = fs.readFileSync(path.join(root, 'App.jsx'), 'utf8');
const careersSrc = fs.readFileSync(path.join(root, 'pages/Careers.jsx'), 'utf8');
const chromeSrc = fs.readFileSync(path.join(root, 'components/Chrome.jsx'), 'utf8');
const cssSrc = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const viteSrc = fs.readFileSync(path.join(root, '../vite.config.js'), 'utf8');
const vercel = JSON.parse(fs.readFileSync(path.join(root, '../../vercel.json'), 'utf8'));
const landing = fs.readFileSync(path.join(root, '../../index.html'), 'utf8');

test('APP.careers stays on this host', () => {
  assert.equal(APP.careers, '/careers');
});

test('open roles start empty — no invented postings', () => {
  assert.deepEqual(OPEN_ROLES, []);
  assert.deepEqual(groupRolesByDepartment(OPEN_ROLES), []);
});

test('groupRolesByDepartment preserves department order', () => {
  const groups = groupRolesByDepartment([
    { id: '1', title: 'A', department: 'Engineering', location: 'Remote', employmentType: 'FullTime' },
    { id: '2', title: 'B', department: 'Design', location: 'Remote', employmentType: 'FullTime' },
    { id: '3', title: 'C', department: 'Engineering', location: 'Remote', employmentType: 'FullTime' },
  ]);
  assert.equal(groups[0].department, 'Engineering');
  assert.equal(groups[0].roles.length, 2);
  assert.equal(groups[1].department, 'Design');
});

test('roleHref and roleMeta follow Ashby-shaped fields', () => {
  assert.equal(roleHref({ applyUrl: 'https://x.test/a' }), 'https://x.test/a');
  assert.equal(roleHref({}), CAREERS_CONTACT);
  assert.equal(roleMeta({ location: 'Remote', employmentType: 'FullTime' }), 'Remote · Full-time');
});

test('App routes /careers to Careers', () => {
  assert.match(appSrc, /import Careers from '\.\/pages\/Careers\.jsx'/);
  assert.match(appSrc, /both\('\/careers',\s*<Careers \/>\)/);
});

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

test('Careers CSS encodes Phantom geometry tokens', () => {
  assert.match(cssSrc, /--careers-prose:\s*60\.3rem/);
  assert.match(cssSrc, /--careers-display:\s*clamp\(2rem,\s*5\.5vw,\s*6rem\)/);
  assert.match(cssSrc, /\.careers-intro\s*\{[\s\S]*min-height:\s*min\(72vh/);
  assert.match(cssSrc, /\.careers-intro-lede[\s\S]*max-width:\s*50rem/);
  assert.match(cssSrc, /\.careers-intro-cta[\s\S]*margin-top:\s*3rem/);
  assert.match(cssSrc, /\.careers-perk-grid[\s\S]*grid-template-columns:\s*repeat\(3/);
  assert.match(cssSrc, /\.careers-principle-track[\s\S]*overflow-x:\s*auto/);
  assert.doesNotMatch(cssSrc, /\.careers-hero\s*\{/);
  assert.doesNotMatch(cssSrc, /\.careers-facts\s*\{/);
});

test('Careers principle and benefit art is art-dependent with deliberate leftovers', () => {
  const artSrc = fs.readFileSync(path.join(root, 'careers-art.js'), 'utf8');
  assert.match(artSrc, /mode:\s*'full-art'/);
  assert.match(artSrc, /mode:\s*'physical-card'/);
  assert.match(artSrc, /322202_dragonite/);
  assert.match(artSrc, /332906_umbreon/);
  assert.match(artSrc, /222470_professor-oak/);
  assert.match(artSrc, /55591_magikarp/);
  assert.match(artSrc, /332912_rayquaza/);
  assert.match(artSrc, /470360_giratina/);
  assert.match(artSrc, /55609_computer-search/);
  assert.match(artSrc, /111151_charizard/);
  assert.match(artSrc, /455774_serena/);
  assert.match(artSrc, /502844_bulbasaur/);
  assert.match(artSrc, /55619_bill/);
  assert.match(careersSrc, /from '\.\.\/careers-art\.js'/);
  assert.match(careersSrc, /LIFE_MEDIA/);
  assert.match(careersSrc, /CareersCardArt|is-full-art|is-physical-card/);
  assert.match(cssSrc, /\.careers-principle-art\.is-full-art/);
  assert.match(cssSrc, /\.careers-principle-art\.is-physical-card/);
  assert.match(cssSrc, /\.careers-perk-art\.is-full-art/);
  assert.match(cssSrc, /\.careers-perk-art\.is-physical-card/);
  assert.match(cssSrc, /\.careers-media-art/);
  assert.match(cssSrc, /careers-cozy-float/);
  assert.match(cssSrc, /\.careers-title-mark\s*\{[\s\S]*width:\s*1\.15em/);
});

test('Chrome footer and landing link to /careers', () => {
  assert.match(chromeSrc, /to=\{APP\.careers\}/);
  assert.match(landing, /href="\/careers"/);
});

test('vercel and vite serve /careers as market SPA', () => {
  const rewrites = vercel.rewrites || [];
  assert.ok(rewrites.some((r) => r.source === '/careers' && r.destination === '/market/index.html'));
  assert.ok(rewrites.some((r) => r.source === '/careers/' && r.destination === '/market/index.html'));
  assert.match(viteSrc, /url === '\/careers'/);
});
