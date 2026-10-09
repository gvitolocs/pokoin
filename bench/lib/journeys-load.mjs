// Page-load and passive journeys: cold, warm, scroll, realtime.
import { QUERIES, ROUTES, SELECTORS, TIMING } from '../config.mjs';
import {
  armDesk, awaitWatcher, beginWindow, cardIdFromHref, endWindow, gotoPath, loadMetrics,
  settle, sleep, waitForCount, waitLoadTail, wallNow,
} from './measure.mjs';
import { frameStats } from './observers.mjs';

/** Measures one document load of the home page (navigation or reload). */
async function measureLoad(env, page, cdp, navigate) {
  const handle = await beginWindow(page, cdp, { newDocument: true });
  await navigate();
  await page.waitForSelector(SELECTORS.tile, { timeout: TIMING.readyTimeoutMs })
    .catch(() => env.log('load: no card tile appeared'));
  await waitLoadTail(page, TIMING.coldTailMs);
  const win = await endWindow(page, cdp, handle);
  const load = await loadMetrics(page);
  return { metrics: { ...load.metrics, ...win.metrics }, detail: { ...load.detail, ...win.detail } };
}

/** Fresh context (empty cache) -> /marketplace. */
export async function cold(env) {
  const { page, cdp } = await env.newPage();
  return measureLoad(env, page, cdp, () => gotoPath(env, page, ROUTES.home));
}

/** Same context: load /marketplace once, then measure a reload. */
export async function warm(env) {
  const { page, cdp } = await env.newPage();
  await gotoPath(env, page, ROUTES.home);
  await page.waitForSelector(SELECTORS.tile, { timeout: TIMING.readyTimeoutMs }).catch(() => {});
  await settle(page, TIMING.settleMs);
  return measureLoad(env, page, cdp, () => page.reload({ waitUntil: 'load', timeout: TIMING.gotoTimeoutMs }));
}

/**
 * /marketplace/search?q=energy, wheel-scroll down for scrollMs, pressing "Load more"
 * whenever the bottom is reached: frame gaps, long tasks, DOM growth, heap.
 */
export async function scroll(env) {
  const { page, cdp } = await env.newPage();
  await gotoPath(env, page, ROUTES.search(QUERIES.scroll));
  await waitForCount(page, SELECTORS.resultsTile, 12);
  await settle(page, TIMING.settleMs);
  const tilesStart = await page.locator(SELECTORS.tile).count();

  const handle = await beginWindow(page, cdp);
  await page.evaluate(() => window.__benchApi.startFrames());
  const vp = page.viewportSize() || { width: 800, height: 600 };
  await page.mouse.move(vp.width / 2, vp.height / 2);
  let useWheel = true;
  let steps = 0;
  let loadMore = 0;
  const end = wallNow() + TIMING.scrollMs;
  while (wallNow() < end) {
    if (useWheel) {
      try {
        await page.mouse.wheel(0, TIMING.scrollStepPx);
      } catch (err) {
        env.log(`scroll: mouse.wheel unavailable (${err.message}); using scrollBy`);
        useWheel = false;
      }
    }
    if (!useWheel) await page.evaluate((dy) => window.scrollBy(0, dy), TIMING.scrollStepPx);
    steps += 1;
    const atBottom = await page.evaluate(
      () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4,
    );
    if (atBottom) {
      const more = page.locator(SELECTORS.loadMore).first();
      if (await more.isVisible().catch(() => false)) {
        await env.press(more);
        loadMore += 1;
        await page.mouse.move(vp.width / 2, vp.height / 2);
      }
    }
    await sleep(TIMING.scrollStepMs);
  }
  const gaps = await page.evaluate(() => window.__benchApi.stopFrames());
  const win = await endWindow(page, cdp, handle, { interactive: loadMore > 0 });
  const tail = await page.evaluate((sel) => ({
    y: window.scrollY,
    height: document.documentElement.scrollHeight,
    tiles: document.querySelectorAll(sel).length,
  }), SELECTORS.tile);
  const fr = frameStats(gaps);
  return {
    metrics: {
      ...win.metrics,
      'scroll.frames': fr.frames,
      'scroll.gapsOver33': fr.over33,
      'scroll.gapsOver50': fr.over50,
      'scroll.maxGapMs': fr.maxGapMs,
      'scroll.p95GapMs': fr.p95GapMs,
      'scroll.meanGapMs': fr.meanGapMs,
      'scroll.finalY': Math.round(tail.y),
      'scroll.scrollHeight': tail.height,
      'scroll.tilesStart': tilesStart,
      'scroll.tilesEnd': tail.tiles,
      'scroll.loadMoreClicks': loadMore,
    },
    detail: { ...win.detail, steps, wheel: useWheel },
  };
}

/** Opens the first home tile in-app, then idles realtimeMs: background requests and CPU. */
export async function realtime(env) {
  const { page, cdp } = await env.newPage();
  await gotoPath(env, page, ROUTES.home);
  const tile = page.locator(SELECTORS.tile).first();
  await tile.waitFor({ state: 'visible', timeout: TIMING.readyTimeoutMs });
  const href = await tile.getAttribute('href');
  const id = cardIdFromHref(href);
  const wid = await armDesk(page, id);
  await env.press(tile);
  const desk = await awaitWatcher(page, wid);
  if (desk.headingMs == null) throw new Error(`realtime: desk ${href} did not paint (${JSON.stringify(desk)})`);
  await settle(page, 3000);

  const handle = await beginWindow(page, cdp);
  await sleep(TIMING.realtimeMs);
  const win = await endWindow(page, cdp, handle);
  const perMin = 60000 / TIMING.realtimeMs;
  return {
    metrics: {
      ...win.metrics,
      'idle.requestsPerMin': Math.round(win.metrics['net.requests'] * perMin * 10) / 10,
      'idle.scriptMsPerMin': Math.round(win.metrics['cpu.scriptMs'] * perMin * 10) / 10,
    },
    detail: { ...win.detail, card: href },
  };
}
