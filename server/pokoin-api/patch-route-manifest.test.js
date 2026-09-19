const test = require('node:test');
const assert = require('node:assert/strict');
const { addRoutes } = require('./patch-route-manifest');

test('route patch is additive and idempotent', () => {
  const base = 'const routeDefinitions = [\n];\n\nmodule.exports = { routeDefinitions };\n';
  const routes = [{ path: '/api/chat', file: 'chat.js', methods: ['GET'] }];
  const once = addRoutes(base, routes);
  assert.match(once, /\/api\/chat/);
  assert.equal(addRoutes(once, routes), once);
});
