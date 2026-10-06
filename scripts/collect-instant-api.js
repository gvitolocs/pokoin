'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REQUIRE_RE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function repoRoot() {
  return path.resolve(__dirname, '..');
}

function loadManifest(root = repoRoot()) {
  const manifestPath = path.join(root, 'scripts/instant-api-manifest.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = spec.endsWith('.js')
    ? [base]
    : [base + '.js', path.join(base, 'index.js')];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function inShipRoots(root, file) {
  const rel = path.relative(root, file);
  return rel.startsWith(`server${path.sep}pokoin-api${path.sep}`)
    || rel.startsWith(`server${path.sep}api${path.sep}`);
}

function walk(root, entries) {
  const files = new Map();
  const external = new Set();
  const missing = [];
  const queue = entries.map((entry) => path.join(root, entry));

  while (queue.length) {
    const file = queue.pop();
    const rel = path.relative(root, file);
    if (files.has(rel)) continue;
    if (!fs.existsSync(file)) {
      missing.push(rel);
      continue;
    }
    files.set(rel, file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(REQUIRE_RE)) {
      const resolved = resolveRelative(file, match[1]);
      const baseName = path.basename(match[1]).endsWith('.js')
        ? path.basename(match[1])
        : `${path.basename(match[1])}.js`;
      if (!resolved || !inShipRoots(root, resolved)) {
        external.add(baseName);
        continue;
      }
      queue.push(resolved);
    }
  }

  const byBase = new Map();
  for (const rel of files.keys()) {
    const base = path.basename(rel);
    const group = byBase.get(base) || [];
    group.push(rel);
    byBase.set(base, group);
  }

  const shipped = [];
  for (const [base, group] of byBase) {
    if (group.length === 1) {
      shipped.push(group[0]);
      continue;
    }
    const bodies = group.map((rel) => fs.readFileSync(path.join(root, rel), 'utf8'));
    const same = bodies.every((body) => body === bodies[0]);
    if (same) {
      shipped.push(group.find((rel) => rel.includes('pokoin-api')) || group[0]);
      continue;
    }
    const entry = group.find((rel) => entries.includes(rel));
    if (entry) shipped.push(entry);
    external.add(base);
  }

  return {
    files: shipped.sort(),
    external: [...external].sort(),
    missing,
  };
}

function validate(root = repoRoot()) {
  const manifest = loadManifest(root);
  const walked = walk(root, manifest.entries);
  const errors = [...walked.missing];
  const shipNames = new Set(manifest.ship || []);
  const reached = new Map();
  for (const rel of walked.files) reached.set(path.basename(rel), rel);
  for (const name of walked.external) {
    if (!reached.has(name)) reached.set(name, null);
  }

  const files = [];
  for (const name of shipNames) {
    const rel = [...walked.files].find((file) => path.basename(file) === name);
    if (rel) {
      files.push(rel);
      continue;
    }
    // Compatibility shims (server/pokoin-api/_valkey.js re-exports Redis) are
    // listed in ship so a deploy still overlays them for require() calls that
    // live outside this closure. They are not handler entries.
    const shim = ['server/pokoin-api', 'server/api']
      .map((dir) => path.join(dir, name))
      .find((candidate) => {
        const full = path.join(root, candidate);
        return fs.existsSync(full) && fs.statSync(full).isFile();
      });
    if (!shim) errors.push(`ship module ${name} is not in the require closure`);
    else files.push(shim);
  }
  files.sort();

  const external = new Set(walked.external);
  for (const rel of walked.files) {
    const base = path.basename(rel);
    if (!shipNames.has(base)) external.add(base);
  }

  for (const migration of manifest.migrations) {
    if (!fs.existsSync(path.join(root, migration))) errors.push(`missing migration ${migration}`);
  }

  const routes = JSON.parse(fs.readFileSync(path.join(root, manifest.routes), 'utf8'));
  const basenames = new Set(files.map((file) => path.basename(file)));
  for (const route of routes) {
    if (!basenames.has(route.file)) errors.push(`route ${route.path} references missing handler ${route.file}`);
  }

  for (const file of files) {
    const full = path.join(root, file);
    try {
      new Function(fs.readFileSync(full, 'utf8'));
    } catch (error) {
      errors.push(`syntax ${file}: ${error.message}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    files,
    external: [...external].sort(),
    routes,
    migrations: manifest.migrations,
    requiredTables: manifest.requiredTables,
  };
}

if (require.main === module) {
  const result = validate();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`files ${result.files.length}\nexternal ${result.external.length}\n`);
    for (const file of result.files) process.stdout.write(`  ${file}\n`);
  }
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`${error}\n`);
    process.exit(1);
  }
}

module.exports = { validate, walk, loadManifest };
