'use strict';

const fs = require('node:fs');
const path = require('node:path');

function addRoutes(source, routes) {
  const missing = routes.filter((route) => !source.includes(`path: '${route.path}'`) && !source.includes(`"path": "${route.path}"`));
  if (!missing.length) return source;
  const marker = '];\n\nmodule.exports = { routeDefinitions };';
  if (!source.includes(marker)) throw new Error('API route manifest layout changed.');
  const entries = missing.map((route) => `  ${JSON.stringify(route, null, 2).replace(/\n/g, '\n  ')},`).join('\n');
  return source.replace(marker, `${entries}\n];\n\nmodule.exports = { routeDefinitions };`);
}

if (require.main === module) {
  const manifestPath = process.argv[2];
  const routesPath = process.argv[3] || path.join(__dirname, 'route-definitions.json');
  if (!manifestPath) throw new Error('Usage: patch-route-manifest.js <manifest> [routes.json]');
  const source = fs.readFileSync(manifestPath, 'utf8');
  const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
  fs.writeFileSync(manifestPath, addRoutes(source, routes));
}

module.exports = { addRoutes };
