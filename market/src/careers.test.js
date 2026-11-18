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
import { applyRedirect } from '../../scripts/write-cloudflare-web-routing.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const cssSrc = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
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
  assert.match(artSrc, /LIFE_STRIP/);
  assert.match(artSrc, /397269_charizard/);
  assert.match(artSrc, /401454_elesa/);
  assert.match(artSrc, /612658_pikachu/);
  assert.match(artSrc, /55576_clefairy/);
  assert.match(artSrc, /110847_smeargle-123-162-breakthrough/);
  assert.match(artSrc, /mode: 'art-cut'/);
  assert.match(artSrc, /pose: 'sit-low'/);
  assert.match(artSrc, /470296_mewtwo/);
  assert.match(artSrc, /LIFE_BUBBLES/);
  assert.match(artSrc, /502874_snorlax/);
  assert.match(artSrc, /241014_komala/);
  assert.match(artSrc, /484062_slowpoke/);
  assert.match(artSrc, /483642_greavard/);
  assert.match(artSrc, /612618_spheal/);
  assert.match(artSrc, /550636_snom/);
  assert.match(artSrc, /502862_psyduck/);
  assert.match(cssSrc, /\.careers-life-art\.is-physical-card/);
  assert.match(cssSrc, /\.careers-life-tile[\s\S]*width:\s*min\(23\.75rem/);
  assert.match(cssSrc, /\.careers-life-tile[\s\S]*height:\s*29\.5rem/);
  assert.match(cssSrc, /\.careers-life-strip::-webkit-scrollbar/);
  assert.match(cssSrc, /scrollbar-width:\s*none/);
  assert.match(cssSrc, /\.careers-strip-note[\s\S]*margin:\s*3\.5rem/);
  assert.match(cssSrc, /\.careers-principle-art\.is-full-art/);
  assert.match(cssSrc, /\.careers-principle-art\.is-physical-card/);
  assert.match(cssSrc, /\.careers-perk-art\.is-full-art/);
  assert.match(cssSrc, /\.careers-perk-art\.is-physical-card/);
  assert.match(cssSrc, /\.careers-media-art/);
  assert.match(cssSrc, /\.careers-media-art\.slot-b/);
  assert.match(cssSrc, /\.careers-media-art\.slot-c/);
  assert.match(cssSrc, /\.careers-media-art\.slot-d/);
  assert.match(cssSrc, /\.careers-media-art\.slot-e/);
  assert.match(cssSrc, /\.careers-media-art\.slot-h/);
  assert.match(cssSrc, /careers-cozy-float/);
  assert.match(cssSrc, /careers-media-glow/);
  assert.match(cssSrc, /object-position:\s*62%\s*18%/);
  assert.match(cssSrc, /\.careers-principle-art\.is-full-art\.pose-bleed-low[\s\S]*height:\s*56%/);
  assert.match(cssSrc, /\.careers-title-mark\s*\{[\s\S]*width:\s*1\.15em/);
});

test('the landing links to /careers', () => {
  assert.match(landing, /href="\/careers"/);
});

test('Cloudflare and vercel serve /careers as the SPA shell', () => {
  const rewrites = vercel.rewrites || [];
  assert.ok(rewrites.some((r) => r.source === '/careers' && r.destination === '/market/index.html'));
  assert.ok(rewrites.some((r) => r.source === '/careers/' && r.destination === '/market/index.html'));
  for (const url of ['/careers', '/careers/']) {
    assert.deepEqual(applyRedirect(url), { source: url, code: 200, location: '/market/app' });
  }
});
