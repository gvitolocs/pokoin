import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gameSiteHref } from './game.js';

test('the game picker sends each TCG to its own site', () => {
  assert.equal(gameSiteHref('pokemon'), 'https://pokoin.com/marketplace');
  assert.equal(gameSiteHref('one_piece'), 'https://pokoin.com/one-piece/marketplace');
  assert.equal(gameSiteHref('riftbound'), 'https://pokoin.com/riftbound/marketplace');
  assert.equal(gameSiteHref('magic'), 'https://pokoin.com/magic/marketplace');
  assert.equal(gameSiteHref(''), 'https://pokoin.com/marketplace');
});

test('game paths rewrite to the market SPA', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const config = JSON.parse(fs.readFileSync(path.join(root, '../../vercel.json'), 'utf8'));
  const slugs = 'one-piece|riftbound|magic|yugioh|lorcana|flesh-and-blood|digimon|dragon-ball-super|vanguard|star-wars|union-arena|gundam|sorcery';
  const hit = (config.rewrites || []).find(
    (rule) => rule.source === `/:game(${slugs})/:path*` && rule.destination === '/market/index.html',
  );
  assert.ok(hit, '/one-piece/marketplace must rewrite to the market SPA');
});
