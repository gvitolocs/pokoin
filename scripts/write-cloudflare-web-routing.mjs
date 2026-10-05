#!/usr/bin/env node
/** _redirects and _headers for Workers Static Assets. No Worker on these paths. */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'dist-web');
const games = [
  'one-piece', 'riftbound', 'magic', 'yugioh', 'lorcana', 'flesh-and-blood', 'digimon',
  'dragon-ball-super', 'vanguard', 'star-wars', 'union-arena', 'gundam', 'sorcery',
  'palworld', 'cyberpunk', 'weiss-schwarz', 'final-fantasy', 'force-of-will',
  'world-of-warcraft', 'battle-spirits-saga', 'star-wars-destiny', 'dragon-born',
  'my-little-pony', 'the-spoils',
];
const spa = [
  'about', 'admin', 'ambassador', 'ambassadorprogram', 'artwork', 'associate', 'auth',
  'bought', 'buy', 'cardscan', 'careers', 'cart', 'checkout', 'collection', 'contact',
  'dashboard', 'docs', 'earn', 'email-preferences', 'espurr', 'exchange', 'extension',
  'favorites', 'flex', 'forum', 'health', 'inventory', 'invite', 'join', 'jumbos',
  'marketplace', 'messages', 'mypokoin', 'nft', 'ocr', 'orders', 'privacy', 'product',
  'profile', 'protection', 'sales', 'sanitize', 'scan', 'scancard', 'shipping', 'sitemap', 'stock',
  'swap', 'tests', 'wallet', 'whitepaper',
  ...games,
];

const testBoards = ['tests', 'sanitize', 'espurr', 'ocr', 'artwork', 'jumbos'];
const lines = [
  '# One wildcard per prefix. Workers Static Assets allow 100 redirect rules.',
  '# /news* is served by the separate assets-only pokoin-news Worker route; the SPA must never catch it.',
  '# External hosts (www, /card-images) are zone Redirect Rules, not _redirects.',
  '/pokemon* /marketplace/en/pokemon/:splat 301',
  '/sets* /marketplace/sets/:splat 301',
  '/eras* /marketplace/eras/:splat 301',
  '/artists* /marketplace/en/artists/:splat 301',
  '/rarities* /marketplace/en/rarities/:splat 301',
  '/languages* /marketplace/en/languages/:splat 301',
  '/guides* /marketplace/en/guides/:splat 301',
  '/marketplace/pokemon* /marketplace/en/pokemon/:splat 301',
  '/marketplace/rarities* /marketplace/en/rarities/:splat 301',
  '/marketplace/languages* /marketplace/en/languages/:splat 301',
  '/marketplace/guides* /marketplace/en/guides/:splat 301',
  '/brand* /market/brand/:splat 200',
  '/working* /working.html 200',
];
// Numeric card short links (pokoin.com/239324, also /239324/slug): one rule per
// leading digit, because _redirects has no digit-only pattern. The old Pi origin and
// the pokoin-shortlink Worker served these; without them every shared or scanned
// short link was an empty 404 on this host. No real root path starts with a digit.
for (let digit = 0; digit <= 9; digit += 1) {
  lines.push(`/${digit}* /marketplace/en/cards/${digit}:splat 302`);
}
for (const board of testBoards) {
  lines.push(`/${board}* https://test.pokoin.com/${board}/:splat 301`);
}
lines.push('# SPA shell is /market/app.html. A rewrite to index.html loops in the assets router.');
for (const prefix of spa) {
  if (testBoards.includes(prefix)) continue;
  lines.push(`/${prefix}* /market/app 200`);
}
const rules = lines.filter((line) => line && !line.startsWith('#')).length;
if (rules > 100) throw new Error(`_redirects has ${rules} rules; Workers Static Assets allow 100`);
fs.writeFileSync(path.join(root, '_redirects'), `${lines.join('\n')}\n`);

const headers = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Strict-Transport-Security: max-age=31536000
  Content-Security-Policy: base-uri 'self'; object-src 'none'; frame-ancestors 'self' chrome-extension:; script-src 'self' https://apis.google.com https://www.gstatic.com https://www.google.com https://accounts.google.com https://pokoin.firebaseapp.com

/index.html
  Cache-Control: public, max-age=0, must-revalidate

/landing.html
  Cache-Control: public, max-age=0, must-revalidate

/market/index.html
  Cache-Control: public, max-age=0, must-revalidate

/market/app.html
  Cache-Control: public, max-age=0, must-revalidate

/working.html
  Cache-Control: public, max-age=0, must-revalidate

/market/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;
fs.writeFileSync(path.join(root, '_headers'), headers);
fs.writeFileSync(path.join(root, '.assetsignore'), 'download/*.zip\ndownload/*.ZIP\n');

const landing = path.join(root, 'landing.html');
if (fs.existsSync(landing)) {
  fs.copyFileSync(landing, path.join(root, 'index.html'));
}
const spaShell = path.join(root, 'market', 'index.html');
if (fs.existsSync(spaShell)) {
  fs.copyFileSync(spaShell, path.join(root, 'market', 'app.html'));
}
console.log('cloudflare routing', root, 'spa', spa.length);
