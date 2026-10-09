#!/usr/bin/env node
/**
 * Merge result files of the same build (e.g. interleaved one-run invocations)
 * into one file: runs concatenated per journey, summaries recomputed.
 *
 *   node merge.mjs --out results/solid-mobile.json results/solid-mobile-r*.json
 */
import fs from 'node:fs';
import { summarizeJourney } from './lib/stats.mjs';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
if (outAt < 0 || !args[outAt + 1]) {
  console.error('usage: node merge.mjs --out merged.json a.json b.json …');
  process.exit(2);
}
const out = args[outAt + 1];
const inputs = args.filter((_, index) => index !== outAt && index !== outAt + 1);
const merged = { schema: null, environment: null, sources: [], runs: {}, summary: {} };
for (const file of inputs) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  merged.schema ??= data.schema;
  merged.environment ??= data.environment;
  merged.sources.push({ file, environment: data.environment });
  for (const [journey, runs] of Object.entries(data.runs || {})) {
    merged.runs[journey] = [...(merged.runs[journey] || []), ...runs];
  }
}
for (const [journey, runs] of Object.entries(merged.runs)) {
  runs.forEach((run, index) => { run.run = index + 1; });
  merged.summary[journey] = summarizeJourney(runs);
}
fs.writeFileSync(out, `${JSON.stringify(merged, null, 1)}\n`);
console.log(`merged ${inputs.length} files → ${out}`);
