import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  reactDependencies,
  reactImports,
  reactLegacyReport,
} from '../../scripts/react-legacy-report.mjs';

// Built at runtime: a literal import in this file would be a hit itself.
const R = ['re', 'act'].join('');

test('every way of importing a React package is a hit, Solid and lookalikes are not', () => {
  const source = [
    `import { useState } from '${R}';`,
    `import { createRoot } from "${R}-dom/client";`,
    `export { Link } from '${R}-router-dom';`,
    `import '${R}/jsx-runtime';`,
    `const lazy = () => import('${R}-easy-crop');`,
    `const legacy = require('${R}-dom');`,
    `const html = \`import x from '${R}'\`;`,
    `import ${R} from '@vitejs/plugin-${R}';`,
    "import { createSignal } from 'solid-js';",
    `const css = '${R}EasyCrop_Container';`,
    `// solid comments may say ${R} without importing it`,
  ].join('\n');
  assert.deepEqual(reactImports(source), [
    { line: 1, spec: R },
    { line: 2, spec: `${R}-dom/client` },
    { line: 3, spec: `${R}-router-dom` },
    { line: 4, spec: `${R}/jsx-runtime` },
    { line: 5, spec: `${R}-easy-crop` },
    { line: 6, spec: `${R}-dom` },
    { line: 7, spec: R },
    { line: 8, spec: `@vitejs/plugin-${R}` },
  ]);
});

test('React packages in a package.json are hits', () => {
  assert.deepEqual(reactDependencies({
    dependencies: { [R]: '19', firebase: '12', 'solid-js': '2' },
    devDependencies: { [`@vitejs/plugin-${R}`]: '4', vite: '8' },
  }), ['dependencies react', `devDependencies @vitejs/plugin-${R}`]);
});

test('the report names file:line for imports, market/src .jsx files and dependencies', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'react-legacy-'));
  try {
    fs.mkdirSync(path.join(repo, 'market/src/pages'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'solid/src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'market/src/pages/Old.jsx'), `\nimport { memo } from '${R}';\n`);
    fs.writeFileSync(path.join(repo, 'solid/src/ok.js'), "import { createMemo } from 'solid-js';\n");
    fs.writeFileSync(path.join(repo, 'market/package.json'), JSON.stringify({ dependencies: { [`${R}-dom`]: '19' } }, null, 2));
    assert.deepEqual(reactLegacyReport(repo), [
      '[react-legacy] market/src/pages/Old.jsx:1 React component file (.jsx under market/src)',
      `[react-legacy] market/src/pages/Old.jsx:2 imports ${R}`,
      `[react-legacy] market/package.json:3 dependencies ${R}-dom`,
    ]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
