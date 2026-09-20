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
const viteSrc = fs.readFileSync(path.join(root, '../vite.config.js'), 'utf8');
const vercel = JSON.parse(fs.readFileSync(path.join(root, '../../vercel.json'), 'utf8'));
const landing = fs.readFileSync(path.join(root, '../../index.html'), 'utf8');

test('APP.careers stays on this host', () => {
  assert.equal(APP.careers, '/careers');
  assert.equal(APP.careers.includes('://'), false);
});

test('open roles start empty — no invented postings', () => {
  assert.deepEqual(OPEN_ROLES, []);
  assert.deepEqual(groupRolesByDepartment(OPEN_ROLES), []);
});

test('groupRolesByDepartment preserves department order and counts', () => {
  const groups = groupRolesByDepartment([
    {
      id: '1',
      title: 'Frontend Engineer',
      department: 'Engineering',
      location: 'Remote',
      employmentType: 'FullTime',
      applyUrl: 'https://example.com/a',
    },
    {
      id: '2',
      title: 'Brand Designer',
      department: 'Product & Design',
      location: 'Remote',
      employmentType: 'FullTime',
      jobUrl: 'https://example.com/b',
    },
    {
      id: '3',
      title: 'Platform Engineer',
      department: 'Engineering',
      location: 'Remote-EU',
      employmentType: 'FullTime',
    },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].department, 'Engineering');
  assert.equal(groups[0].roles.length, 2);
  assert.equal(groups[1].department, 'Product & Design');
  assert.equal(groups[1].roles.length, 1);
});

test('roleHref prefers applyUrl then jobUrl then contact mail', () => {
  assert.equal(
    roleHref({ applyUrl: 'https://example.com/apply', jobUrl: 'https://example.com/job' }),
    'https://example.com/apply',
  );
  assert.equal(roleHref({ jobUrl: 'https://example.com/job' }), 'https://example.com/job');
  assert.equal(roleHref({}), CAREERS_CONTACT);
  assert.equal(roleHref(null), CAREERS_CONTACT);
});

test('roleMeta formats location and employment type', () => {
  assert.equal(
    roleMeta({ location: 'Remote', employmentType: 'FullTime' }),
    'Remote · Full-time',
  );
  assert.equal(roleMeta({ location: 'Remote-US' }), 'Remote-US');
  assert.equal(roleMeta({}), '');
});

test('App routes /careers to Careers page', () => {
  assert.match(appSrc, /import Careers from '\.\/pages\/Careers\.jsx'/);
  assert.match(appSrc, /both\('\/careers',\s*<Careers \/>\)/);
});

test('Careers page keeps Phantom module structure without fake openings', () => {
  assert.match(careersSrc, /id="open-positions"/);
  assert.match(careersSrc, /Browse open roles/);
  assert.match(careersSrc, /No open roles right now/);
  assert.match(careersSrc, /EmptyDesk/);
  assert.match(careersSrc, /DepartmentAccordion|aria-expanded/);
  assert.match(careersSrc, /OPEN_ROLES/);
  assert.doesNotMatch(careersSrc, /Ashby|phantom\.com|millions of people/i);
});

test('Chrome footer and landing link to /careers', () => {
  assert.match(chromeSrc, /to=\{APP\.careers\}/);
  assert.match(chromeSrc, />Careers</);
  assert.match(landing, /href="\/careers"/);
});

test('vercel and vite serve /careers as the market SPA', () => {
  const rewrites = vercel.rewrites || [];
  assert.ok(rewrites.some((r) => r.source === '/careers' && r.destination === '/market/index.html'));
  assert.ok(rewrites.some((r) => r.source === '/careers/' && r.destination === '/market/index.html'));
  assert.match(viteSrc, /url === '\/careers'/);
});
