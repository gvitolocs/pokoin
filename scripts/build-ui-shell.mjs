#!/usr/bin/env node
/**
 * React ↔ Solid switch at the same URLs (docs/frontend-perf/PLAN.md, "Coexistence").
 *
 *   node scripts/build-ui-shell.mjs dist-web            # after build-web.sh built market/ and solid/
 *
 * Copies solid/dist/s into <out>/market/s and rewrites <out>/market/index.html so a
 * small inline boot script writes ONE UI's entry tags (module script, modulepreloads,
 * stylesheet, prefetches) with document.write. The tags stay parser-inserted, exactly
 * as Vite emitted them. React is the default. Solid is chosen only for routes listed
 * in solid/owned-routes.json, in a top-level window, when the visitor opted in
 * (?ui=solid, sticky; ?ui=react opts out) or was sampled into the canary percentage
 * (POKOIN_UI_CANARY, default 0). With the canary back at 0, sampled visitors return
 * to React (kill switch); explicit opt-ins stay. Solid hands routes it does not own
 * back with sessionStorage pokoin.ui.once=react (solid/src/lib/ui-switch.js).
 *
 * Writes <out>/market/ui-switch.json with the inline script's CSP hash; the routing
 * writer (scripts/write-cloudflare-web-routing.mjs) adds it to script-src.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** The inline boot script. Kept small and ES5-safe: it runs before any bundle. */
export function bootScript({ owned = [], canary = 0, tags }) {
  // `</` would end the inline <script> early (the tags contain </script>).
  const config = JSON.stringify({ owned, canary: Number(canary) || 0, tags }).replace(/<\//g, '<\\/');
  return `(function(){var c=${config},w=window,ui="react",k="pokoin.ui";try{`
    + 'var q=new URLSearchParams(location.search).get("ui");'
    + 'if(q==="solid"||q==="react")localStorage.setItem(k,q);'
    + 'var once=sessionStorage.getItem(k+".once");if(once)sessionStorage.removeItem(k+".once");'
    + 'var pref=localStorage.getItem(k)||"";'
    + 'if(!pref&&c.canary>0){pref=Math.random()*100<c.canary?"solid-auto":"react-auto";localStorage.setItem(k,pref)}'
    + 'if(pref==="solid-auto"&&c.canary<=0)pref="react";'
    + 'var owns=c.owned.some(function(r){return new RegExp(r).test(location.pathname)});'
    + 'if(pref.indexOf("solid")===0&&once!=="react"&&w.self===w.top&&owns)ui="solid"'
    + '}catch(e){}w.__POKOIN_UI__=ui;w.__POKOIN_UI_SWITCH__=1;document.write(c.tags[ui])})();';
}

export function cspHash(script) {
  return `sha256-${crypto.createHash('sha256').update(script, 'utf8').digest('base64')}`;
}

/** React shell with its entry tags replaced by the boot script that writes either UI's tags. */
export function buildShell(reactHtml, solidHtml, { owned, canary = 0 } = {}) {
  const react = entryTags(reactHtml);
  const solid = entryTags(solidHtml);
  if (!react.tags.length || !solid.tags.some((tag) => tag.includes('type="module"'))) {
    throw new Error('build-ui-shell: entry tags not found in the React or Solid index.html');
  }
  const script = bootScript({
    owned,
    canary,
    tags: { react: react.tags.join(''), solid: solid.tags.join('') },
  });
  const html = `${react.rest.slice(0, react.at)}<script>${script}</script>${react.rest.slice(react.at)}`;
  return { html, script, hash: cspHash(script) };
}

function main(outRoot) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = path.resolve(outRoot || path.join(repo, 'dist-web'));
  const marketIndex = path.join(out, 'market', 'index.html');
  const solidDist = path.join(repo, 'solid', 'dist');
  const { patterns: owned } = JSON.parse(fs.readFileSync(path.join(repo, 'solid', 'owned-routes.json'), 'utf8'));
  const canary = Math.min(100, Math.max(0, Number(process.env.POKOIN_UI_CANARY) || 0));
  const shell = buildShell(
    fs.readFileSync(marketIndex, 'utf8'),
    fs.readFileSync(path.join(solidDist, 'index.html'), 'utf8'),
    { owned, canary },
  );
  fs.cpSync(path.join(solidDist, 's'), path.join(out, 'market', 's'), { recursive: true });
  fs.writeFileSync(marketIndex, shell.html);
  fs.writeFileSync(
    path.join(out, 'market', 'ui-switch.json'),
    `${JSON.stringify({ hash: shell.hash, canary, owned }, null, 2)}\n`,
  );
  console.log(`ui switch: canary ${canary}%, ${owned.length} Solid routes, ${shell.hash}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv[2]);
