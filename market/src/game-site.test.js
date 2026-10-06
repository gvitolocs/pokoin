import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { GAMES, gameIconSrc, gameSiteHref, publicGamePath, tcgBrandName } from './game.js';

test('structured-data brand and public path follow the game', () => {
  assert.equal(tcgBrandName('pokemon'), 'Pokémon TCG');
  assert.equal(tcgBrandName(''), 'Pokémon TCG');
  assert.equal(tcgBrandName('one_piece'), 'One Piece');
  assert.equal(tcgBrandName('one-piece'), 'One Piece');
  assert.equal(tcgBrandName('star_wars'), 'Star Wars');
  assert.equal(tcgBrandName('star-wars-destiny'), 'Star Wars Destiny');
  for (const row of Object.values(GAMES)) {
    const brand = tcgBrandName(row.id);
    if (row.id === 'pokemon') {
      assert.equal(brand, 'Pokémon TCG');
    } else {
      assert.equal(brand, row.name);
      assert.notEqual(brand, 'Pokémon TCG');
    }
  }
  assert.equal(
    publicGamePath('/marketplace/en/cards/812446/luffy', 'one_piece'),
    '/one-piece/marketplace/en/cards/812446/luffy',
  );
  assert.equal(
    publicGamePath('/one-piece/marketplace/en/cards/812446/luffy', 'one_piece'),
    '/one-piece/marketplace/en/cards/812446/luffy',
  );
  assert.equal(publicGamePath('/marketplace/en/cards/1/x', 'pokemon'), '/marketplace/en/cards/1/x');
  assert.equal(
    publicGamePath('/marketplace/en/cards/795832/student', 'star_wars'),
    '/star-wars/marketplace/en/cards/795832/student',
  );
});

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
  const slugs = 'one-piece|riftbound|magic|yugioh|lorcana|flesh-and-blood|digimon|dragon-ball-super|vanguard|star-wars|union-arena|gundam|sorcery|palworld|cyberpunk|weiss-schwarz|final-fantasy|force-of-will|world-of-warcraft|battle-spirits-saga|star-wars-destiny|dragon-born|my-little-pony|the-spoils';
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

test('satellite eras and set icons stay off the Pokémon catalogs', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const era = fs.readFileSync(path.join(root, 'pages/Era.jsx'), 'utf8');
  const logos = fs.readFileSync(path.join(root, 'set-logos.js'), 'utf8');
  const sets = fs.readFileSync(path.join(root, 'pages/Sets.jsx'), 'utf8');
  assert.match(era, /SatelliteEras/);
  assert.match(era, /isPokemonGame/);
  assert.match(era, /does not use Pokémon TCG blocks/);
  assert.match(logos, /satelliteExpansionPrefix/);
  assert.match(logos, /if \(!isPokemonGame\(hostname\)\) return ''/);
  assert.match(logos, /\/card-images\/\$\{slug\}\/expansions/);
  assert.match(sets, /satelliteGroups/);
  assert.match(sets, /pokemon \? \(/);
});

test('each marketplace game has a CardTrader-matching icon SVG', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const gamesDir = path.join(root, '../public/games');
  for (const item of Object.values(GAMES)) {
    const src = gameIconSrc(item);
    assert.match(src, /(?:^|\/)games\/[a-z0-9-]+\.svg$/);
    const file = path.join(gamesDir, path.basename(src));
    assert.ok(fs.existsSync(file), `missing ${src}`);
    const svg = fs.readFileSync(file, 'utf8');
    assert.match(svg, /<svg[\s\S]*<path[\s\S]*d="/);
  }
  assert.match(gameIconSrc('pokemon'), /(?:^|\/)games\/pokemon\.svg$/);
  assert.match(gameIconSrc('riftbound'), /(?:^|\/)games\/riftbound\.svg$/);
  const chrome = fs.readFileSync(path.join(root, 'components/Chrome.jsx'), 'utf8');
  assert.match(chrome, /gameIconSrc/);
  assert.match(chrome, /className="game-icon"/);
});
