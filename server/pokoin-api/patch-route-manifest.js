'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Two manifest layouts exist on the Pi:
//   const routeDefinitions = [ ... ];\n\nmodule.exports = { routeDefinitions };
//   module.exports = {\n  routeDefinitions: [ ... ]\n};
const OLD_MARKER = '];\n\nmodule.exports = { routeDefinitions };';
const NEW_END = /\n\]\s*\n\};\s*$/;

function addRoutes(source, routes) {
  const missing = routes.filter((route) => !source.includes(`path: '${route.path}'`) && !source.includes(`"path": "${route.path}"`));
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

if (require.main === module) {
  const manifestPath = process.argv[2];
  const routesPath = process.argv[3] || path.join(__dirname, 'route-definitions.json');
  if (!manifestPath) throw new Error('Usage: patch-route-manifest.js <manifest> [routes.json]');
  const source = fs.readFileSync(manifestPath, 'utf8');
  const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
  fs.writeFileSync(manifestPath, addRoutes(source, routes));
}

module.exports = { addRoutes };
