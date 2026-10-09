import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeBytes, decodeMappings, normalizeSource, originalPosition, packageOf, parseHtml, staticImports, trimCommonPrefix,
} from '../bundle.mjs';
import { compare, deltaPct } from '../compare.mjs';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reference VLQ encoder (independent of the decoder under test). */
function vlq(value) {
  let x = value < 0 ? (-value * 2) + 1 : value * 2;
  let out = '';
  do {
    let digit = x % 32;
    x = Math.floor(x / 32);
    if (x > 0) digit += 32;
    out += B64[digit];
  } while (x > 0);
  return out;
}
const seg = (...fields) => fields.map(vlq).join('');

test('decodeMappings handles multi-digit, negative and source-less segments', () => {
  assert.deepEqual(decodeMappings('gBAAA'), [[[16, 0]]]);
  const mappings = `${seg(0, 0, 0, 0)},${seg(1000, 2, 5, 3)},${seg(7)};;${seg(3, -1, 1, 0)}`;
  assert.deepEqual(decodeMappings(mappings), [
    [[0, 0], [1000, 2], [1007, -1]],
    [],
    [[3, 1]],
  ]);
});

test('attributeBytes covers every byte of the chunk exactly once', () => {
  const code = 'abc;def\nxyz\néé';
  const map = { mappings: `${seg(0, 0, 0, 0)},${seg(4, 1, 0, 0)};${seg(0, -1, 1, 0)};${seg(1, 1, 0, 0)}` };
  const bytes = attributeBytes(code, map);
  assert.equal(bytes.get(0), 4 + 3);
  assert.equal(bytes.get(1), 3 + 2); // 'def' + second 'é' (2 UTF-8 bytes)
  assert.equal(bytes.get(-1), 2 + 2); // two newlines + unmapped first 'é'
  const total = [...bytes.values()].reduce((a, b) => a + b, 0);
  assert.equal(total, Buffer.byteLength(code));
});

test('source normalisation and package attribution', () => {
  assert.equal(normalizeSource('../../node_modules/react-dom/cjs/react-dom.js'), 'node_modules/react-dom/cjs/react-dom.js');
  assert.equal(packageOf('node_modules/react-dom/cjs/react-dom.js'), 'react-dom');
  assert.equal(packageOf('node_modules/.pnpm/x@1/node_modules/@tanstack/query/build/index.js'), '@tanstack/query');
  assert.equal(packageOf(normalizeSource('../../src/components/Chrome.jsx')), 'app:src/components');
  assert.equal(packageOf(normalizeSource('\u0000vite/preload-helper.js')), '(bundler runtime)');
  assert.equal(normalizeSource('../../../home/nez/p/market/node_modules/re2js/build/index.js'), 'node_modules/re2js/build/index.js');
  const names = trimCommonPrefix(['home/nez/p/market/src/a.js', 'home/nez/p/market/src/data/b.js', 'node_modules/x/i.js']);
  assert.equal(names.get('home/nez/p/market/src/a.js'), 'src/a.js');
  assert.equal(names.get('home/nez/p/market/src/data/b.js'), 'src/data/b.js');
  assert.equal(names.get('node_modules/x/i.js'), 'node_modules/x/i.js');
});

test('parseHtml and staticImports', () => {
  const html = `<script src="/market/card-url-boot.js"></script>
    <script type="module" crossorigin src="/market/assets/index-AB.js"></script>
    <link rel="modulepreload" crossorigin href="/market/assets/react-CD.js">
    <link rel="stylesheet" crossorigin href="/market/assets/index-EF.css">`;
  assert.deepEqual(parseHtml(html), {
    entries: ['/market/assets/index-AB.js'],
    preloads: ['/market/assets/react-CD.js'],
    styles: ['/market/assets/index-EF.css'],
  });
  const code = 'import{a as b}from"./react-CD.js";import"./side.js";export{c}from"./re.js";const l=()=>import("./lazy.js");';
  assert.deepEqual(staticImports(code), ['./react-CD.js', './side.js', './re.js']);
});

test('compare flags only watched p50 regressions above the threshold', () => {
  const env = { label: 'x', profile: 'desktop', net: 'none' };
  const a = { environment: env, runs: { search: [{ ok: true }] }, summary: { search: { inp: { n: 1, p50: 100, p95: 100 }, 'cpu.scriptMs': { n: 1, p50: 100, p95: 100 } } } };
  const b = { environment: env, runs: { search: [{ ok: true }] }, summary: { search: { inp: { n: 1, p50: 115, p95: 120 }, 'cpu.scriptMs': { n: 1, p50: 200, p95: 200 } } } };
  const { regressions, markdown } = compare(a, b, { threshold: 10 });
  assert.equal(regressions.length, 1);
  assert.equal(regressions[0].metric, 'inp');
  assert.match(markdown, /\+15\.0%/);
  assert.equal(deltaPct(0, 0), 0);
  assert.equal(deltaPct(0, 5), null);
});

test('analyzeProfile attributes each sample interval to its node', async () => {
  const { analyzeProfile } = await import('../profile.mjs');
  const prof = {
    startTime: 0,
    endTime: 1000,
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 } },
      { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: -1, columnNumber: -1 } },
      { id: 3, callFrame: { functionName: 'rank', url: 'https://pokoin.com/market/assets/index.js', lineNumber: 0, columnNumber: 9 } },
      { id: 4, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: -1, columnNumber: -1 } },
    ],
    samples: [2, 3, 3, 4],
    timeDeltas: [100, 100, 300, 200],
  };
  const a = analyzeProfile(prof);
  assert.equal(a.idleUs, 100); // sample at t=100 runs until the next one at t=200
  assert.equal(a.functions[0].name, 'rank');
  assert.equal(a.functions[0].selfUs, 300 + 200); // t=200..500 and t=500..700
  assert.equal(a.functions[0].col, 10);
  assert.equal(a.gcUs, 300); // t=700..1000 (endTime)
  assert.equal(a.busyUs, 1000 - a.idleUs);
});

test('originalPosition finds the covering segment with its name', () => {
  const map = { sources: ['../../src/suggest-rank.js'], names: ['rankNamePool'], mappings: `${seg(0, 0, 9, 0)},${seg(12, 0, 2, 4, 0)}` };
  const decoded = decodeMappings(map.mappings, { full: true });
  assert.deepEqual(decoded[0][1], [12, 0, 11, 4, 0]);
  assert.deepEqual(originalPosition(map, decoded, 0, 20), { source: 'src/suggest-rank.js', line: 12, column: 5, name: 'rankNamePool' });
  assert.equal(originalPosition(map, decoded, 0, 3).name, null);
  assert.equal(originalPosition(map, decoded, 5, 0), null);
});
