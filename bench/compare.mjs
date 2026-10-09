#!/usr/bin/env node
// A/B comparison of two run.mjs result files as a markdown report.
//   node compare.mjs a.json b.json [--threshold 10] [--all] [--journeys search,card] [--fail-on-regression]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_JOURNEYS, AUTH_JOURNEYS, REGRESSION_METRICS } from './config.mjs';

const USAGE = 'usage: node compare.mjs <a.json> <b.json> [--threshold <pct>] [--all] [--journeys a,b] [--fail-on-regression]';

function parseArgs(argv) {
  const opts = { files: [], threshold: 10, all: false, journeys: null, failOnRegression: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') opts.all = true;
    else if (arg === '--fail-on-regression') opts.failOnRegression = true;
    else if (arg === '--threshold') opts.threshold = Number(argv[++i]);
    else if (arg.startsWith('--threshold=')) opts.threshold = Number(arg.slice(12));
    else if (arg === '--journeys') opts.journeys = argv[++i].split(',');
    else if (arg.startsWith('--journeys=')) opts.journeys = arg.slice(11).split(',');
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else opts.files.push(arg);
  }
  if (opts.files.length !== 2) throw new Error(USAGE);
  if (!Number.isFinite(opts.threshold)) throw new Error('--threshold must be a number');
  return opts;
}

function fmt(value) {
  if (value == null || !Number.isFinite(value)) return '–';
  if (Number.isInteger(value)) return String(value);
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(1);
  return value.toFixed(3);
}

/** Percent change of b relative to a; null when undefined. */
export function deltaPct(a, b) {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a === 0) return b === 0 ? 0 : null;
  return ((b - a) / Math.abs(a)) * 100;
}

const fmtN = (s) => (s.n == null ? '–' : `${s.n}${s.nulls ? ` (+${s.nulls} null)` : ''}`);

const fmtDelta = (d) => (d == null ? 'n/a' : `${d > 0 ? '+' : ''}${d.toFixed(1)}%`);

function journeyOrder(a, b) {
  const known = [...PUBLIC_JOURNEYS, ...AUTH_JOURNEYS];
  const names = new Set([...Object.keys(a.summary || {}), ...Object.keys(b.summary || {})]);
  return [...known.filter((n) => names.has(n)), ...[...names].filter((n) => !known.includes(n)).sort()];
}

function runStatus(data, journey) {
  const runs = (data.runs && data.runs[journey]) || [];
  if (!runs.length) return 'absent';
  const skipped = runs.find((r) => r.skipped);
  if (skipped) return `skipped (${skipped.skipped})`;
  return `${runs.filter((r) => r.ok).length}/${runs.length} ok`;
}

function envTable(a, b) {
  const ea = a.environment || {};
  const eb = b.environment || {};
  const rows = [
    ['label', ea.label, eb.label],
    ['profile / net', `${ea.profile} / ${ea.net}`, `${eb.profile} / ${eb.net}`],
    ['base', ea.base, eb.base],
    ['runs', ea.runs, eb.runs],
    ['timestamp', ea.timestamp, eb.timestamp],
    ['host', `${ea.hostname || '?'} · ${ea.cpuModel || '?'} ×${ea.cpuCount || '?'}`, `${eb.hostname || '?'} · ${eb.cpuModel || '?'} ×${eb.cpuCount || '?'}`],
    ['loadavg start → end', `${(ea.loadavgStart || []).join(' ')} → ${(ea.loadavgEnd || []).join(' ')}`, `${(eb.loadavgStart || []).join(' ')} → ${(eb.loadavgEnd || []).join(' ')}`],
    ['browser', `${ea.browserVersion} (${ea.channel || 'chromium'})`, `${eb.browserVersion} (${eb.channel || 'chromium'})`],
  ];
  const lines = ['| | A | B |', '|---|---|---|'];
  for (const [name, va, vb] of rows) lines.push(`| ${name} | ${va ?? '–'} | ${vb ?? '–'} |`);
  return lines;
}

/** Builds the markdown report and the list of flagged regressions. */
export function compare(a, b, { threshold = 10, all = false, journeys = null } = {}) {
  const regressions = [];
  const sections = [];
  for (const journey of journeyOrder(a, b)) {
    if (journeys && !journeys.includes(journey)) continue;
    const sa = (a.summary && a.summary[journey]) || {};
    const sb = (b.summary && b.summary[journey]) || {};
    const keys = [...new Set([...Object.keys(sa), ...Object.keys(sb)])]
      .filter((k) => all || (sa[k] && sb[k] && (sa[k].n || sb[k].n)))
      .sort((x, y) => {
        const rx = REGRESSION_METRICS.includes(x) ? 0 : 1;
        const ry = REGRESSION_METRICS.includes(y) ? 0 : 1;
        return rx - ry || x.localeCompare(y);
      });
    const lines = [
      `### ${journey}`,
      '',
      `A: ${runStatus(a, journey)} · B: ${runStatus(b, journey)}`,
      '',
    ];
    if (!keys.length) {
      sections.push([...lines, '_no comparable metrics_', ''].join('\n'));
      continue;
    }
    lines.push('| metric | A n | A p50 | A p95 | B n | B p50 | B p95 | Δ p50 | Δ p95 |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const key of keys) {
      const x = sa[key] || {};
      const y = sb[key] || {};
      const d50 = deltaPct(x.p50, y.p50);
      const d95 = deltaPct(x.p95, y.p95);
      const watched = REGRESSION_METRICS.includes(key);
      const flagged = watched && d50 != null && d50 > threshold;
      if (flagged) regressions.push({ journey, metric: key, a: x.p50, b: y.p50, delta: d50 });
      const name = `${flagged ? '⚠️ ' : ''}${watched ? `**${key}**` : key}`;
      lines.push(`| ${name} | ${fmtN(x)} | ${fmt(x.p50)} | ${fmt(x.p95)} | ${fmtN(y)} | ${fmt(y.p50)} | ${fmt(y.p95)} | ${fmtDelta(d50)} | ${fmtDelta(d95)} |`);
    }
    lines.push('');
    sections.push(lines.join('\n'));
  }

  const head = [
    `# Pokoin bench: ${a.environment?.label ?? 'A'} → ${b.environment?.label ?? 'B'}`,
    '',
    ...envTable(a, b),
    '',
  ];
  if (regressions.length) {
    head.push(`**${regressions.length} regression(s): p50 up more than ${threshold}% on a watched metric**`, '');
    for (const r of regressions) {
      head.push(`- ⚠️ ${r.journey} · \`${r.metric}\`: ${fmt(r.a)} → ${fmt(r.b)} (${fmtDelta(r.delta)})`);
    }
    head.push('');
  } else {
    head.push(`No p50 regression above ${threshold}% on watched metrics (${REGRESSION_METRICS.join(', ')}).`, '');
  }
  head.push('Watched metrics are **bold**; lower is better for every ms/bytes/count metric. '
    + 'Arrays (keystrokes, navigations) are pooled across runs, so their n counts samples, not runs.', '');
  return { markdown: [...head, ...sections].join('\n'), regressions };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [a, b] = opts.files.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
  const ea = a.environment || {};
  const eb = b.environment || {};
  const { markdown, regressions } = compare(a, b, opts);
  if (ea.profile !== eb.profile || ea.net !== eb.net) {
    console.error(`warning: comparing different setups (${ea.profile}/${ea.net} vs ${eb.profile}/${eb.net})`);
  }
  if (ea.hostname && eb.hostname && ea.hostname !== eb.hostname) {
    console.error(`warning: results come from different hosts (${ea.hostname} vs ${eb.hostname})`);
  }
  console.log(markdown);
  if (opts.failOnRegression && regressions.length) process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
