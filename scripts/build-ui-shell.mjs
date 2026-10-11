#!/usr/bin/env node
/**
 * Solid shell (docs/frontend-perf/PLAN.md). The site is Solid only: React is
 * never served.
 *
 *   node scripts/build-ui-shell.mjs dist-web            # after build-web.sh built market/ and solid/
 *
 * Copies solid/dist/s into <out>/market/s and rewrites <out>/market/index.html so a
 * small inline boot script writes Solid's entry tags (module script, modulepreloads,
 * stylesheet, prefetches) with document.write. The tags stay parser-inserted, exactly
 * as Vite emitted them. Every page boots Solid, framed or not.
 *
 * React legacy tripwire: whatever used to pick the React UI (a ?ui=react link, a
 * stored pokoin.ui React preference, a pokoin.ui.once handoff, a path outside
 * solid/owned-routes.json) now only sets window.__POKOIN_REACT_LEGACY__ to the
 * reason. Solid's App reports it as a `[react-legacy]` client error (console +
 * POST /api/client-error), so tests and the API journal show where React is still
 * referenced. Stored preferences are cleared, so a visitor reports once.
 *
 * Writes <out>/market/ui-switch.json with the inline script's CSP hash; the routing
 * writer (scripts/write-cloudflare-web-routing.mjs) adds it to script-src.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Vite's entry tags: module script, modulepreload / stylesheet / prefetch links. */
const ENTRY_TAG = /<script\b[^>]*\btype="module"[^>]*><\/script>|<link\b[^>]*\brel="(?:modulepreload|stylesheet|prefetch)"[^>]*>/g;

export function entryTags(html) {
  const tags = [];
  let at = -1;
  const rest = String(html).replace(ENTRY_TAG, (tag, offset) => {
    if (at < 0) at = offset;
    tags.push(tag);
    return '';
  });
  return { tags, rest, at };
}

/**
 * The path an owned-route pattern is tested against: other games' sites live
 * under a basename (/one-piece/marketplace), where both UIs route the rest.
 * Mirrors the boot script below.
 */
export function routePath(pathname, games = []) {
  const path = String(pathname || '');
  const slug = path.split('/')[1] || '';
  return slug && games.includes(slug) ? path.slice(slug.length + 1) || '/' : path;
}

/** The inline boot script. Kept small and ES5-safe: it runs before any bundle. */
export function bootScript({ owned = [], tags, games = [] }) {
  // `</` would end the inline <script> early (the tags contain </script>).
  const config = JSON.stringify({ owned, games, solid: tags.solid }).replace(/<\//g, '<\\/');
  return `(function(){var c=${config},w=window,k="pokoin.ui",why="";try{`
    + 'var p=location.pathname,g=p.split("/")[1]||"";if(g&&c.games.indexOf(g)>=0)p=p.slice(g.length+1)||"/";'
    + 'if(new URLSearchParams(location.search).get("ui")==="react")why="ui=react";'
    + 'var once=sessionStorage.getItem(k+".once");if(once){sessionStorage.removeItem(k+".once");why=why||"handoff:"+once}'
    + 'var pref=localStorage.getItem(k);if(pref){localStorage.removeItem(k);if(pref.indexOf("react")===0)why=why||"pref:"+pref}'
    + 'if(!c.owned.some(function(r){return new RegExp(r).test(p)}))why=why||"unowned"'
    + '}catch(e){}w.__POKOIN_UI__="solid";w.__POKOIN_UI_SWITCH__=1;if(why)w.__POKOIN_REACT_LEGACY__=why;document.write(c.solid)})();';
}

export function cspHash(script) {
  return `sha256-${crypto.createHash('sha256').update(script, 'utf8').digest('base64')}`;
}

/** Basename slugs of the other games' sites (market/src/game.js). */
export async function gameSlugs(repo) {
  const { GAMES } = await import(pathToFileURL(path.join(repo, 'market', 'src', 'game.js')).href);
  return Object.values(GAMES).map((row) => row.slug).filter(Boolean);
}

/** The shell page with its entry tags replaced by the boot script that writes Solid's tags. */
export function buildShell(reactHtml, solidHtml, { owned, games = [] } = {}) {
  const react = entryTags(reactHtml);
  const solid = entryTags(solidHtml);
  if (!react.tags.length || !solid.tags.some((tag) => tag.includes('type="module"'))) {
    throw new Error('build-ui-shell: entry tags not found in the React or Solid index.html');
  }
  const script = bootScript({ owned, games, tags: { solid: solid.tags.join('') } });
  const html = `${react.rest.slice(0, react.at)}<script>${script}</script>${react.rest.slice(react.at)}`;
  return { html, script, hash: cspHash(script) };
}

async function main(outRoot) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = path.resolve(outRoot || path.join(repo, 'dist-web'));
  const marketIndex = path.join(out, 'market', 'index.html');
  const solidDist = path.join(repo, 'solid', 'dist');
  const config = JSON.parse(fs.readFileSync(path.join(repo, 'solid', 'owned-routes.json'), 'utf8'));
  const owned = config.patterns;
  const games = await gameSlugs(repo);
  const shell = buildShell(
    fs.readFileSync(marketIndex, 'utf8'),
    fs.readFileSync(path.join(solidDist, 'index.html'), 'utf8'),
    { owned, games },
  );
  fs.cpSync(path.join(solidDist, 's'), path.join(out, 'market', 's'), { recursive: true });
  fs.writeFileSync(marketIndex, shell.html);
  fs.writeFileSync(
    path.join(out, 'market', 'ui-switch.json'),
    `${JSON.stringify({ hash: shell.hash, owned, games }, null, 2)}\n`,
  );
  console.log(`solid shell: ${owned.length} owned routes, ${games.length} game basenames, ${shell.hash}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main(process.argv[2]);
