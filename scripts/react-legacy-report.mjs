#!/usr/bin/env node
/**
 * React legacy report. The site is Solid 2 only; every React reference left in
 * the repo is an error that names where it is:
 *
 *   node scripts/react-legacy-report.mjs        # prints nothing and exits 0 when clean
 *
 * Scans market/src, solid/src, scripts, bench and home (plus the top-level
 * files of market/ and solid/) for imports of react, react-dom,
 * react-router(-dom), react/jsx-runtime, any other react-* package and
 * @vitejs/plugin-react (static, dynamic, require, or inside a source string),
 * any *.jsx file under market/src, and React packages in the package.json
 * files. One `[react-legacy] file:line …` line per hit on stderr, exit 1 when any.
 * market/src/react-legacy-report.test.js runs it in the market suite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

/** react and every react-* package (react-dom, react-router-dom, react-easy-crop, …) with
 * their subpaths (react/jsx-runtime, react-dom/client), and @vitejs/plugin-react. */
const PACKAGE = String.raw`(?:react(?:-[\w-]+)?(?:\/[\w./-]*)?|@vitejs\/plugin-react)`;
const IMPORT = new RegExp(
  String.raw`(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"\`](${PACKAGE})['"\`]`,
  'g',
);
const PACKAGE_NAME = new RegExp(`^${PACKAGE}$`);

const ROOTS = ['market/src', 'solid/src', 'scripts', 'bench', 'home'];
const TOP_LEVEL = ['market', 'solid'];
const MANIFESTS = ['package.json', 'market/package.json', 'solid/package.json', 'bench/package.json'];
const CODE = /\.(?:[cm]?js|jsx|tsx?|html)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'results', '.git']);

/** Every React import in one source text: [{ line, spec }]. */
export function reactImports(text) {
  const hits = [];
  const lines = String(text).split('\n');
  lines.forEach((line, index) => {
    for (const match of line.matchAll(IMPORT)) hits.push({ line: index + 1, spec: match[1] });
  });
  return hits;
}

/** React packages a package.json depends on. */
export function reactDependencies(manifest) {
  const out = [];
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest?.[field] || {})) {
      if (PACKAGE_NAME.test(name)) out.push(`${field} ${name}`);
    }
  }
  return out;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (CODE.test(entry.name)) out.push(file);
  }
  return out;
}

/** Every React reference under `repo`, as `[react-legacy] file:line …` lines. */
export function reactLegacyReport(repo = REPO) {
  const files = new Set();
  for (const root of ROOTS) for (const file of walk(path.join(repo, root))) files.add(file);
  for (const dir of TOP_LEVEL) {
    const full = path.join(repo, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      const file = path.join(full, name);
      if (CODE.test(name) && fs.statSync(file).isFile()) files.add(file);
    }
  }
  const lines = [];
  for (const file of [...files].sort()) {
    if (file === SELF) continue;
    const rel = path.relative(repo, file);
    if (rel.startsWith(`market${path.sep}src${path.sep}`) && file.endsWith('.jsx')) {
      lines.push(`[react-legacy] ${rel}:1 React component file (.jsx under market/src)`);
    }
    for (const hit of reactImports(fs.readFileSync(file, 'utf8'))) {
      lines.push(`[react-legacy] ${rel}:${hit.line} imports ${hit.spec}`);
    }
  }
  for (const rel of MANIFESTS) {
    const file = path.join(repo, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const dep of reactDependencies(JSON.parse(text))) {
      const name = dep.split(' ')[1];
      const line = text.split('\n').findIndex((row) => row.includes(`"${name}"`)) + 1;
      lines.push(`[react-legacy] ${rel}:${line || 1} ${dep}`);
    }
  }
  return lines;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (isMain) {
  const lines = reactLegacyReport(process.argv[2] ? path.resolve(process.argv[2]) : REPO);
  for (const line of lines) console.error(line);
  process.exitCode = lines.length ? 1 : 0;
}
