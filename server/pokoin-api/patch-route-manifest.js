'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Two manifest layouts exist on the Pi:
//   const routeDefinitions = [ ... ];\n\nmodule.exports = { routeDefinitions };
//   module.exports = {\n  routeDefinitions: [ ... ]\n};
const OLD_MARKER = '];\n\nmodule.exports = { routeDefinitions };';
// A previous patch leaves a trailing comma after the last entry (`},\n]`).
// Swallow it, or the appended `,\n{…}` makes `},,` — an array hole that
// crashes the Pi router (`route.regexp` of undefined) for every later route
// and every unknown path (2026-10-08, poko-market-04e88dcb277d).
const NEW_END = /,?\s*\n\]\s*\n\};\s*$/;

function hasRoute(source, route) {
  return source.includes(`path: '${route.path}'`) || source.includes(`"path": "${route.path}"`);
}

function addRoutes(source, routes) {
  const missing = routes.filter((route) => !hasRoute(source, route));
  if (!missing.length) return source;
  const entries = missing.map((route) => `  ${JSON.stringify(route, null, 2).replace(/\n/g, '\n  ')},`).join('\n');
  if (source.includes(OLD_MARKER)) {
    return source.replace(OLD_MARKER, `${entries}\n];\n\nmodule.exports = { routeDefinitions };`);
  }
  if (NEW_END.test(source)) {
    return source.replace(NEW_END, `,\n${entries}\n]\n};\n`);
  }
  throw new Error('API route manifest layout changed.');
}

/** Split routes into those whose handler file exists in apiDir and those that do not. */
function routesWithHandlers(routes, apiDir) {
  const kept = [];
  const skipped = [];
  for (const route of routes) {
    (fs.existsSync(path.join(apiDir, route.file)) ? kept : skipped).push(route);
  }
  return { kept, skipped };
}

/** Problems that would break the Pi router: holes or entries without path/file. */
function manifestProblems(routeDefinitions) {
  if (!Array.isArray(routeDefinitions)) return ['routeDefinitions is not an array'];
  const problems = [];
  for (let index = 0; index < routeDefinitions.length; index += 1) {
    const route = routeDefinitions[index];
    if (!(index in routeDefinitions) || !route) problems.push(`hole at index ${index}`);
    else if (typeof route.path !== 'string' || typeof route.file !== 'string') problems.push(`entry ${index} lacks path/file`);
  }
  return problems;
}

function loadManifest(manifestPath) {
  const resolved = require.resolve(path.resolve(manifestPath));
  delete require.cache[resolved];
  return require(resolved).routeDefinitions;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const apiDirArg = args.find((arg) => arg.startsWith('--api-dir='));
  const positional = args.filter((arg) => !arg.startsWith('--api-dir='));
  const manifestPath = positional[0];
  const routesPath = positional[1] || path.join(__dirname, 'route-definitions.json');
  if (!manifestPath) throw new Error('Usage: patch-route-manifest.js <manifest> [routes.json] [--api-dir=<dir>]');
  const source = fs.readFileSync(manifestPath, 'utf8');
  const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
  let routesToAdd = routes;
  if (apiDirArg) {
    const apiDir = apiDirArg.slice('--api-dir='.length);
    const { kept, skipped } = routesWithHandlers(routes, apiDir);
    for (const route of skipped) {
      if (!hasRoute(source, route)) {
        console.error(`patch-route-manifest: skipped ${route.path} — ${route.file} is not in ${apiDir}`);
      }
    }
    routesToAdd = kept;
  }
  fs.writeFileSync(manifestPath, addRoutes(source, routesToAdd));
  // Never leave a manifest the router cannot load: restore and fail the deploy.
  let problems;
  try {
    problems = manifestProblems(loadManifest(manifestPath));
  } catch (error) {
    problems = [`manifest does not load: ${error.message}`];
  }
  if (problems.length) {
    fs.writeFileSync(manifestPath, source);
    console.error(`patch-route-manifest: refused, original restored (${problems.join('; ')})`);
    process.exit(1);
  }
}

module.exports = { addRoutes, manifestProblems, routesWithHandlers };
