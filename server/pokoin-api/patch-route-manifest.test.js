const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { addRoutes, manifestProblems } = require('./patch-route-manifest');

function evaluate(source) {
  const module = { exports: {} };
  new Function('module', 'exports', source)(module, module.exports);
  return module.exports.routeDefinitions;
}

test('route patch is additive and idempotent', () => {
  const base = 'const routeDefinitions = [\n];\n\nmodule.exports = { routeDefinitions };\n';
  const routes = [{ path: '/api/chat', file: 'chat.js', methods: ['GET'] }];
  const once = addRoutes(base, routes);
  assert.match(once, /\/api\/chat/);
  assert.equal(addRoutes(once, routes), once);
});

test('a trailing comma left by an earlier patch never becomes an array hole', () => {
  const base = 'module.exports = {\n  routeDefinitions: [\n  {\n    "path": "/api/a",\n    "file": "a.js"\n  },\n]\n};\n';
  const first = addRoutes(base, [{ path: '/api/b', file: 'b.js' }]);
  const second = addRoutes(first, [{ path: '/api/c', file: 'c.js' }]);
  const routes = evaluate(second);
  assert.deepEqual(routes.map((route) => route.path), ['/api/a', '/api/b', '/api/c']);
  assert.deepEqual(manifestProblems(routes), []);
});

test('manifestProblems reports holes and entries without path/file', () => {
  // eslint-disable-next-line no-sparse-arrays
  assert.deepEqual(manifestProblems([{ path: '/a', file: 'a.js' }, , { path: '/c' }]), ['hole at index 1', 'entry 2 lacks path/file']);
});

test('the CLI restores the original manifest and exits 1 when the result is broken', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-manifest-'));
  const manifest = path.join(dir, 'manifest.js');
  const routes = path.join(dir, 'routes.json');
  const original = 'module.exports = {\n  routeDefinitions: [\n  {\n    "path": "/api/a",\n    "file": "a.js"\n  },,\n]\n};\n';
  fs.writeFileSync(manifest, original);
  fs.writeFileSync(routes, JSON.stringify([{ path: '/api/b', file: 'b.js' }]));
  assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, 'patch-route-manifest.js'), manifest, routes], { stdio: 'pipe' }));
  assert.equal(fs.readFileSync(manifest, 'utf8'), original);
});

test('the CLI writes a clean manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-manifest-'));
  const manifest = path.join(dir, 'manifest.js');
  const routes = path.join(dir, 'routes.json');
  fs.writeFileSync(manifest, 'module.exports = {\n  routeDefinitions: [\n  {\n    "path": "/api/a",\n    "file": "a.js"\n  },\n]\n};\n');
  fs.writeFileSync(routes, JSON.stringify([{ path: '/api/b', file: 'b.js' }]));
  execFileSync(process.execPath, [path.join(__dirname, 'patch-route-manifest.js'), manifest, routes], { stdio: 'pipe' });
  const loaded = require(manifest).routeDefinitions;
  assert.deepEqual(loaded.map((route) => route.path), ['/api/a', '/api/b']);
});
