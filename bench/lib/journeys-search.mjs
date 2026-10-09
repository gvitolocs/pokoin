// Header typeahead journeys: search, typo, printlang, langtype.
import { PRINT_LANG_LABELS, QUERIES, ROUTES, SELECTORS, TIMING } from '../config.mjs';
import {
  armBurstRows, armRows, armRowsMany, awaitWatcher, beginWindow, endWindow, gotoPath, settle, sleep,
  waitRowsStable, wallNow,
} from './measure.mjs';

/** Fresh context on /marketplace with the search input ready and the page settled. */
async function openSearch(env) {
  const { page, cdp } = await env.newPage();
  await gotoPath(env, page, ROUTES.home);
  await page.locator(SELECTORS.searchInput).waitFor({ state: 'visible', timeout: TIMING.readyTimeoutMs });
  await settle(page, TIMING.settleMs);
  return { page, cdp, input: page.locator(SELECTORS.searchInput) };
}

/**
 * Types `text` with one key every keyIntervalMs measured from the first key. Presses are
 * fired on schedule without waiting for the previous one, so keys queue behind a busy
 * main thread the way a user's would. Returns one rows-watcher result per key.
 */
async function typeWatched(page, text) {
  const keys = [...text];
  const burst = await armBurstRows(page, keys.length);
  const ids = await armRowsMany(page, keys.length);
  const presses = [];
  const start = wallNow();
  for (let i = 0; i < keys.length; i += 1) {
    const wait = start + i * TIMING.keyIntervalMs - wallNow();
    if (wait > 0) await sleep(wait);
    presses.push(page.keyboard.press(keys[i]));
  }
  await Promise.all(presses);
  const results = await Promise.all(ids.map((id) => awaitWatcher(page, id)));
  const [first, last] = await Promise.all([awaitWatcher(page, burst.first), awaitWatcher(page, burst.last)]);
  const out = keys.map((key, i) => ({ key, ...results[i] }));
  out.firstToRowsMs = first.ms;
  out.lastToRowsMs = last.ms;
  return out;
}

/** Per-key latencies plus the uncapped burst latencies of every typed segment. */
function keyMetrics(keys, segments = [keys]) {
  const values = keys.map((k) => k.ms);
  const hits = values.filter((v) => v != null);
  return {
    'keys.firstToRowsMs': segments.map((seg) => seg.firstToRowsMs ?? null),
    'keys.lastToFinalRowsMs': segments.map((seg) => seg.lastToRowsMs ?? null),
    'keys.toRowsMs': values,
    'keys.noChange': values.length - hits.length,
    'keys.maxToRowsMs': hits.length ? Math.max(...hits) : null,
  };
}

function keyDetail(keys) {
  return keys.map((k) => ({
    key: k.key,
    ms: k.ms == null ? null : Math.round(k.ms * 10) / 10,
    rows: k.rows,
    baselineRows: k.baselineRows,
    timedOut: k.timedOut,
    noStart: k.noStart,
    error: k.error || undefined,
  }));
}

/** Opens the print-language menu and picks `code`; measures option click -> rows changed. */
async function switchPrintLang(env, page, code) {
  await env.press(page.locator(SELECTORS.printLangButton).first());
  const menu = page.locator(SELECTORS.printLangMenu).first();
  await menu.waitFor({ state: 'visible', timeout: 5000 });
  const option = menu.locator(SELECTORS.langOption, { hasText: PRINT_LANG_LABELS[code] }).first();
  const button = option.locator('button');
  const target = (await button.count()) ? button.first() : option;
  const id = await armRows(page, {
    startEvents: ['pointerdown', 'mousedown', 'touchstart'],
    timeoutMs: TIMING.langTimeoutMs,
  });
  await env.press(target);
  const res = await awaitWatcher(page, id);
  return { code, ms: res.ms, rows: res.rows, baselineRows: res.baselineRows, timedOut: res.timedOut, noStart: res.noStart };
}

async function typingJourney(env, query) {
  const { page, cdp, input } = await openSearch(env);
  const handle = await beginWindow(page, cdp);
  await env.press(input);
  await sleep(200);
  const keys = await typeWatched(page, query);
  const final = await waitRowsStable(page, TIMING.rowsStableMs, 8000);
  const win = await endWindow(page, cdp, handle, { interactive: true });
  const value = await input.inputValue();
  return {
    metrics: {
      ...win.metrics,
      ...keyMetrics(keys),
      'rows.final': final ? final.count : 0,
      'keys.valueMismatch': value === query ? 0 : 1,
    },
    detail: { ...win.detail, query, value, keys: keyDetail(keys) },
  };
}

/** Click the header search and type `pikachu` one key at a time. */
export async function search(env) {
  return typingJourney(env, QUERIES.search);
}

/** Same as search with the transposition typo `pikahcu`. */
export async function typo(env) {
  return typingJourney(env, QUERIES.typo);
}

/** With `pikachu` suggestions open, switch print language to Japanese, then Western. */
export async function printlang(env) {
  const { page, cdp, input } = await openSearch(env);
  await env.press(input);
  await page.keyboard.type(QUERIES.search, { delay: TIMING.keyIntervalMs });
  const ready = await waitRowsStable(page, TIMING.rowsStableMs, 10000);
  if (!ready || !ready.count) throw new Error('printlang: no suggestion rows for the query');

  const handle = await beginWindow(page, cdp);
  const switches = [];
  for (const code of ['japanese', 'western']) {
    switches.push(await switchPrintLang(env, page, code));
    await waitRowsStable(page, 500, 5000);
  }
  const win = await endWindow(page, cdp, handle, { interactive: true });
  return {
    metrics: {
      ...win.metrics,
      'lang.toRowsMs': switches.map((s) => s.ms),
      'lang.noChange': switches.filter((s) => s.ms == null).length,
    },
    detail: { ...win.detail, switches },
  };
}

/** Type `char`, switch print language to Japanese, click back into the box, type `izard`. */
export async function langtype(env) {
  const { page, cdp, input } = await openSearch(env);
  const handle = await beginWindow(page, cdp);
  await env.press(input);
  await sleep(200);
  const first = await typeWatched(page, QUERIES.langtypeA);
  await waitRowsStable(page, 500, 5000);
  const sw = await switchPrintLang(env, page, 'japanese');
  await waitRowsStable(page, 500, 5000);
  await env.press(input);
  await page.keyboard.press('End');
  const second = await typeWatched(page, QUERIES.langtypeB);
  const final = await waitRowsStable(page, TIMING.rowsStableMs, 8000);
  const win = await endWindow(page, cdp, handle, { interactive: true });
  const keys = [...first, ...second];
  return {
    metrics: {
      ...win.metrics,
      ...keyMetrics(keys, [first, second]),
      'lang.toRowsMs': [sw.ms],
      'lang.noChange': sw.ms == null ? 1 : 0,
      'rows.final': final ? final.count : 0,
    },
    detail: { ...win.detail, keys: keyDetail(keys), switch: sw, value: await input.inputValue() },
  };
}
