#!/usr/bin/env node
/** _redirects and _headers for Workers Static Assets. No Worker on these paths. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAMES } from '../market/src/game.js';
import {
  GAME_PRIVATE_CHILD_SEGMENTS,
  GAME_PRIVATE_SEGMENTS,
} from '../market/src/game-private-path.js';

const games = Object.values(GAMES).map((game) => game.slug).filter(Boolean);

const spa = [
  'about', 'admin', 'ambassador', 'ambassadorprogram', 'artwork', 'associate', 'auth',
  'bought', 'buy', 'cardscan', 'careers', 'cart', 'checkout', 'collection', 'contact',
  'dashboard', 'docs', 'earn', 'email-preferences', 'espurr', 'exchange', 'extension',
  'favorites', 'flex', 'forum', 'health', 'inventory', 'invite', 'join', 'jumbos',
  'marketplace', 'messages', 'mypokoin', 'nft', 'ocr', 'orders', 'poko', 'privacy', 'product',
  'profile', 'protection', 'sales', 'sanitize', 'scan', 'scancard', 'shipping', 'sitemap', 'stock',
  'swap', 'tests', 'wallet', 'whitepaper',
  ...games,
];

const testBoards = ['tests', 'sanitize', 'espurr', 'ocr', 'artwork', 'jumbos', 'poko'];

/** SPA prefixes that have child routes. Everything else is two static rewrites. */
const SPA_WILDCARD = new Set([
  'marketplace', 'product', 'extension', 'messages', 'forum', 'mypokoin',
  'inventory', 'join', 'dashboard',
  ...games,
]);

// The extension zip (~31 MB) is over the 25 MiB static-asset file limit and the
// download Worker has no routes, so pokoin.com redirects to the Pi CDN copy at
// objects/downloads/. Bump with each extension release after uploading the zip.
const EXTENSION_ZIP = 'https://cdn.pokoin.com/downloads/pokemon-card-extension-12.0.36.zip';

export function redirectLines() {
  const lines = [
    '# Workers Static Assets allow 2,000 static and 100 dynamic redirects.',
    '# parseRedirects flips canCreateStaticRule off at the first source with * or',
    '# a :placeholder, then counts every later rule as dynamic — even exact paths.',
    '# Exact 301s/200s must all come before the first splat, or the game-private',
    '# 301s blow the 100 dynamic cap (wrangler versions upload rejects the file).',
    '# /news* is served by the separate assets-only pokoin-news Worker route; the SPA must never catch it.',
    '# External hosts (www, /card-images) are zone Redirect Rules, not _redirects.',
    '# Game-prefixed account/marketing URLs are static 301s (one per game).',
    '# Child paths share one /:game/{seg}/* splat, which stays ahead of /{game}*.',
    '# Not edge-redirected (budget): bare /{game}, /{game}/product/*, and',
    '# /{game}/careers|contact|privacy|sitemap. The SPA client-navigates those.',
    `# Game private segments: ${GAME_PRIVATE_SEGMENTS.join(', ')}`,
    '# Static exact paths.',
    `/download/extension.zip ${EXTENSION_ZIP} 302`,
    `/download/extention.zip ${EXTENSION_ZIP} 302`,
  ];
  // Exact /{game}/{private} before any wildcard so they stay static and still
  // win over the later /{game}* SPA catch-all (first match in this file).
  lines.push('# /{game}/{private} and /{game}/{private}/ → unprefixed.');
  for (const game of games) {
    for (const segment of GAME_PRIVATE_SEGMENTS) {
      lines.push(`/${game}/${segment} /${segment} 301`);
      lines.push(`/${game}/${segment}/ /${segment} 301`);
    }
  }
  // /sitemap is the human graph. /sitemap.xml and /sitemap-cards-001.xml are files.
  // Leaf prefixes are two exact rewrites. A rewrite to index.html loops in the assets router.
  lines.push('# Leaf SPA prefixes. Two exact rewrites; no splat.');
  for (const prefix of spa) {
    if (testBoards.includes(prefix) || SPA_WILDCARD.has(prefix)) continue;
    lines.push(`/${prefix} /market/app 200`);
    lines.push(`/${prefix}/ /market/app 200`);
  }

  lines.push('# Dynamic rules. The first * or :placeholder makes every following rule dynamic.');
  lines.push('/pokemon* /marketplace/en/pokemon/:splat 301');
  lines.push('/sets* /marketplace/sets/:splat 301');
  lines.push('/eras* /marketplace/eras/:splat 301');
  lines.push('/artists* /marketplace/en/artists/:splat 301');
  lines.push('/rarities* /marketplace/en/rarities/:splat 301');
  lines.push('/languages* /marketplace/en/languages/:splat 301');
  lines.push('/guides* /marketplace/en/guides/:splat 301');
  lines.push('/marketplace/pokemon* /marketplace/en/pokemon/:splat 301');
  lines.push('/marketplace/rarities* /marketplace/en/rarities/:splat 301');
  lines.push('/marketplace/languages* /marketplace/en/languages/:splat 301');
  lines.push('/marketplace/guides* /marketplace/en/guides/:splat 301');
  lines.push('/brand* /market/brand/:splat 200');
  lines.push('/working* /working.html 200');
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
  // Child splats before /{game}* so /{game}/messages/ada still 301s.
  lines.push('# /:game/{private}/* before /{game}* so child 301s win over the SPA catch-all.');
  for (const segment of GAME_PRIVATE_CHILD_SEGMENTS) {
    lines.push(`/:game/${segment}/* /${segment}/:splat 301`);
  }
  lines.push('# SPA shell is /market/app.html. One wildcard per prefix that has child routes.');
  for (const prefix of spa) {
    if (testBoards.includes(prefix) || !SPA_WILDCARD.has(prefix)) continue;
    lines.push(`/${prefix}* /market/app 200`);
  }
  return lines;
}

/**
 * `scriptHashes`: CSP hashes of inline scripts the build emitted (the React/Solid
 * switch, scripts/build-ui-shell.mjs). Without them the policy is unchanged.
 */
export function headerLines({ scriptHashes = [] } = {}) {
  const inline = scriptHashes.map((hash) => ` '${hash}'`).join('');
  return `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Strict-Transport-Security: max-age=31536000
  Content-Security-Policy: base-uri 'self'; object-src 'none'; frame-ancestors 'self' chrome-extension:; script-src 'self' https://apis.google.com https://www.gstatic.com https://www.google.com https://accounts.google.com https://pokoin.firebaseapp.com${inline}

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

/market/s/*
  Cache-Control: public, max-age=31536000, immutable

/auth
  X-Robots-Tag: noindex, nofollow

/auth/*
  X-Robots-Tag: noindex, nofollow
`;
}

export function ruleRows(lines = redirectLines()) {
  return lines.filter((line) => line && !line.startsWith('#'));
}

/**
 * Source path is dynamic when it contains a splat or a `:placeholder`.
 * Matches workers-shared `parseRedirects` (`SPLAT_REGEX` / `PLACEHOLDER_REGEX` on `from` only).
 * A colon in the destination (`https://`, `:splat`) does not count.
 */
export function redirectSourceIsDynamic(source) {
  return String(source || '').includes('*') || /:[A-Za-z]\w*/.test(source);
}

/**
 * Cloudflare counts a `_redirects` file in order. `canCreateStaticRule` starts
 * true and flips off permanently at the first dynamic source; every rule after
 * that counts against the 100 dynamic cap, including exact paths.
 */
export function countRedirectRules(lines = redirectLines()) {
  const rules = ruleRows(lines);
  let dynamic = 0;
  let fixed = 0;
  let canCreateStaticRule = true;
  for (const line of rules) {
    const source = line.split(/\s+/)[0] || '';
    if (canCreateStaticRule && !redirectSourceIsDynamic(source)) {
      fixed += 1;
    } else {
      dynamic += 1;
      canCreateStaticRule = false;
    }
  }
  return { total: rules.length, dynamic, fixed };
}

/** First matching `_redirects` line. Mirrors Workers Static Assets file order. */
export function applyRedirect(pathname, lines = redirectLines()) {
  const pathOnly = String(pathname || '').split(/[?#]/)[0] || '/';
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const [source, dest, code = '200'] = line.trim().split(/\s+/);
    const splat = matchSource(source, pathOnly);
    if (splat == null) continue;
    return {
      source,
      code: Number(code),
      location: dest.includes(':splat') ? dest.replaceAll(':splat', splat) : dest,
    };
  }
  return null;
}

function matchSource(source, pathOnly) {
  if (source.includes(':')) {
    let pattern = '';
    let last = 0;
    let group = 0;
    let splatGroup = 0;
    const token = /:([A-Za-z]+)|\*/g;
    let found;
    while ((found = token.exec(source))) {
      pattern += source.slice(last, found.index).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      if (found[0] === '*') {
        group += 1;
        splatGroup = group;
        pattern += '(.*)';
      } else {
        pattern += '[^/]+';
      }
      last = found.index + found[0].length;
    }
    pattern += source.slice(last).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const match = pathOnly.match(new RegExp(`^${pattern}$`));
    if (!match) return null;
    return splatGroup ? (match[splatGroup] || '') : '';
  }
  if (source.endsWith('*')) {
    const prefix = source.slice(0, -1);
    if (pathOnly === prefix || pathOnly.startsWith(prefix)) {
      return pathOnly.slice(prefix.length);
    }
    return null;
  }
  return pathOnly === source ? '' : null;
}

export function assertRedirectBudget(lines = redirectLines()) {
  const counts = countRedirectRules(lines);
  if (counts.dynamic > 100) {
    throw new Error(`_redirects has ${counts.dynamic} dynamic rules; Workers Static Assets allow 100`);
  }
  if (counts.fixed > 2000) {
    throw new Error(`_redirects has ${counts.fixed} static rules; Workers Static Assets allow 2,000`);
  }
  return counts;
}

export function writeCloudflareRouting(root) {
  const lines = redirectLines();
  const counts = assertRedirectBudget(lines);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '_redirects'), `${lines.join('\n')}\n`);
  // The React/Solid switch (scripts/build-ui-shell.mjs) is an inline script: allow its hash.
  const switchFile = path.join(root, 'market', 'ui-switch.json');
  const scriptHashes = fs.existsSync(switchFile) ? [JSON.parse(fs.readFileSync(switchFile, 'utf8')).hash] : [];
  fs.writeFileSync(path.join(root, '_headers'), headerLines({ scriptHashes }));
  fs.writeFileSync(path.join(root, '.assetsignore'), 'download/*.zip\ndownload/*.ZIP\n');

  const landing = path.join(root, 'landing.html');
  if (fs.existsSync(landing)) {
    fs.copyFileSync(landing, path.join(root, 'index.html'));
  }
  const spaShell = path.join(root, 'market', 'index.html');
  if (fs.existsSync(spaShell)) {
    fs.copyFileSync(spaShell, path.join(root, 'market', 'app.html'));
  }
  return counts;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(process.argv[2] || 'dist-web');
  const counts = writeCloudflareRouting(root);
  console.log(
    'cloudflare routing',
    root,
    'spa',
    spa.length,
    'dynamic',
    counts.dynamic,
    'static',
    counts.fixed,
  );
}
