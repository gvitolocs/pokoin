#!/usr/bin/env node
// Chrome trace (devtools.timeline) of one print-language switch with suggestions open:
// prints main-thread time by trace event (script, style, layout, paint, decode) and the
// longest tasks, which a CPU profile cannot split (it only sees JS self time).
//   node trace-switch.mjs --base http://127.0.0.1:28621 --profile desktop|mobile [--switch japanese] [--query pikachu] [--out trace.json]
import fs from 'node:fs';
import { PRINT_LANG_LABELS, PROFILES, QUERIES, ROUTES, SELECTORS, TIMING } from './config.mjs';
import { launch, openBenchPage, pressFor } from './lib/browser.mjs';
import { settle, sleep, waitRowsStable } from './lib/measure.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const base = arg('base', 'https://pokoin.com').replace(/\/+$/, '');
const profile = PROFILES[arg('profile', 'desktop')];
const code = arg('switch', 'japanese');
const query = arg('query', QUERIES.search);
const out = arg('out', '');
if (!profile || !PRINT_LANG_LABELS[code]) throw new Error('unknown --profile or --switch');

const browser = await launch({ channel: arg('channel', 'chromium') });
try {
  const { page, cdp } = await openBenchPage(browser, profile, {});
  await page.goto(`${base}${ROUTES.home}`, { waitUntil: 'load', timeout: TIMING.gotoTimeoutMs });
  const input = page.locator(SELECTORS.searchInput);
  await input.waitFor({ state: 'visible', timeout: TIMING.readyTimeoutMs });
  await settle(page, TIMING.settleMs);
  const press = pressFor(profile);
  await press(input);
  await page.keyboard.type(query, { delay: TIMING.keyIntervalMs });
  await waitRowsStable(page, TIMING.rowsStableMs, 10000);
  await press(page.locator(SELECTORS.printLangButton).first());
  const menu = page.locator(SELECTORS.printLangMenu).first();
  await menu.waitFor({ state: 'visible', timeout: 5000 });
  const option = menu.locator(SELECTORS.langOption, { hasText: PRINT_LANG_LABELS[code] }).first();
  const button = option.locator('button');
  const target = (await button.count()) ? button.first() : option;
  await sleep(500);

  const session = cdp.session;
  const events = [];
  session.on('Tracing.dataCollected', (chunk) => events.push(...chunk.value));
  const done = new Promise((resolve) => session.once('Tracing.tracingComplete', resolve));
  await session.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'blink.user_timing', 'loading'] },
  });
  await page.evaluate(() => {
    window.__sw = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__sw.push({ name: e.name, start: e.startTime, dur: e.duration, proc: e.processingEnd - e.processingStart, pres: e.startTime + e.duration - e.processingEnd });
      }
    }).observe({ type: 'event', durationThreshold: 16 });
  });
  await press(target);
  const rows = await waitRowsStable(page, 500, 5000);
  const timing = await page.evaluate(() => window.__sw);
  await session.send('Tracing.end');
  await done;
  if (out) fs.writeFileSync(out, JSON.stringify({ traceEvents: events }));

  // The page's main thread: the busiest thread named CrRendererMain.
  const renderers = new Set(events.filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`));
  const byThread = new Map();
  for (const e of events) {
    const key = `${e.pid}:${e.tid}`;
    if (e.ph !== 'X' || e.name !== 'RunTask' || !renderers.has(key)) continue;
    byThread.set(key, (byThread.get(key) || 0) + (e.dur || 0));
  }
  const main = [...byThread.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const mine = events.filter((e) => e.ph === 'X' && `${e.pid}:${e.tid}` === main).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  // Self time: an event's duration minus its direct children on the same thread.
  const self = new Map();
  const count = new Map();
  const stack = [];
  for (const e of mine) {
    while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts) stack.pop();
    if (stack.length) stack[stack.length - 1].child += e.dur || 0;
    e.child = 0;
    stack.push(e);
  }
  for (const e of mine) {
    self.set(e.name, (self.get(e.name) || 0) + Math.max(0, (e.dur || 0) - e.child));
    count.set(e.name, (count.get(e.name) || 0) + 1);
  }
  const msOf = (us) => (us / 1000).toFixed(1).padStart(8);
  console.log(`# trace: print language -> ${code} with "${query}" on ${base} (${arg('profile', 'desktop')}, CPU ×${profile.cpuThrottle}), final rows ${rows ? rows.count : 0}`);
  const worst = timing.filter((t) => /^(pointerdown|pointerup|click|mousedown|mouseup|touchstart|touchend)$/.test(t.name)).sort((a, b) => b.dur - a.dur)[0];
  console.log('worst event timing:', worst ? `${worst.name} duration ${worst.dur} ms (processing ${Math.round(worst.proc)}, presentation ${Math.round(worst.pres)})` : 'none >= 16 ms');
  console.log('\nMain-thread self time by trace event:');
  for (const [name, us] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)) {
    console.log(`${msOf(us)} ms  ×${String(count.get(name)).padStart(5)}  ${name}`);
  }
  const tasks = mine.filter((e) => e.name === 'RunTask' && e.dur >= 16000).sort((a, b) => b.dur - a.dur).slice(0, 6);
  const t0 = mine[0]?.ts || 0;
  console.log('\nLongest tasks (>= 16 ms):');
  for (const task of tasks) {
    const inside = mine.filter((e) => e !== task && e.ts >= task.ts && e.ts + e.dur <= task.ts + task.dur && e.dur >= 2000 && e.name !== 'RunTask');
    const parts = new Map();
    for (const e of inside) {
      const label = e.name === 'EventDispatch' ? `EventDispatch(${e.args?.data?.type})` : e.name;
      parts.set(label, (parts.get(label) || 0) + e.dur);
    }
    console.log(`${msOf(task.dur)} ms at +${((task.ts - t0) / 1000).toFixed(0)} ms: ${[...parts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9).map(([n, us]) => `${n} ${(us / 1000).toFixed(0)}`).join(', ')}`);
  }
} finally {
  await browser.close();
}
