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

test('game picker on a seller desk keeps the handle under the new TCG path', () => {
  assert.equal(
    gameSiteHref('one_piece', '/marketplace/en/users/redshakkio'),
    'https://pokoin.com/one-piece/marketplace/en/users/redshakkio',
  );
  assert.equal(
    gameSiteHref('pokemon', '/one-piece/marketplace/en/users/redshakkio'),
    'https://pokoin.com/marketplace/en/users/redshakkio',
  );
  assert.equal(
    gameSiteHref('yugioh', '/marketplace/en/cards/123/card-foo'),
    'https://pokoin.com/yugioh/marketplace',
  );
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

test('satellite search ignores the Pokémon print chip (blank nationality)', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const search = fs.readFileSync(path.join(root, 'pages/Search.jsx'), 'utf8');
  const chrome = fs.readFileSync(path.join(root, 'components/Chrome.jsx'), 'utf8');
  assert.match(search, /activePrintLang = \(!isPokemonGame\(\) \|\| tab === 'users'\) \? 'all' : printLang/);
  assert.match(search, /showPrint=\{isPokemonGame\(\)\}/);
  assert.match(chrome, /fetchSuggest\(term, \{[^}]*printLang: 'all'/s);
});
