// In-app navigation journeys: card, back, rapid20, plus the optional authenticated
// collection / checkout journeys (never submit an order or a payment).
import { AUTH, QUERIES, ROUTES, SELECTORS, TIMING } from '../config.mjs';
import {
  armDesk, armPage, awaitWatcher, beginWindow, cardIdFromHref, endWindow, gotoPath,
  historyBack, loadMetrics, pageNow, relatedImageMs, settle, sleep, waitForCount, waitLoadTail, wallNow,
} from './measure.mjs';

const tileByHref = (page, href) => page.locator(`${SELECTORS.tile}[href=${JSON.stringify(href)}]`).first();

/** Clicks/taps `locator` and waits for the desk of `href` (heading, or image too). */
async function openDesk(env, page, locator, href, until = 'image') {
  const id = cardIdFromHref(href);
  if (!id) throw new Error(`no card id in href ${href}`);
  const wid = await armDesk(page, id, { until });
  await env.press(locator);
  const res = await awaitWatcher(page, wid);
  return { href, ...res };
}

const navArrays = (navs) => ({
  'nav.toUrlMs': navs.map((n) => n.urlMs),
  'nav.toHeadingMs': navs.map((n) => n.headingMs),
  'nav.toImageMs': navs.map((n) => n.imageMs),
  'nav.failed': navs.filter((n) => n.headingMs == null).length,
});

const navDetail = (navs) => navs.map((n) => ({
  href: n.href,
  urlMs: n.urlMs,
  headingMs: n.headingMs,
  imageMs: n.imageMs,
  relatedMs: n.relatedMs,
  backMs: n.backMs,
  heading: n.heading,
  timedOut: n.timedOut,
  error: n.error || undefined,
}));

/** Click the first 8 distinct home tiles in turn, history.back() between them. */
export async function card(env) {
  const { page, cdp } = await env.newPage();
  await gotoPath(env, page, ROUTES.home);
  await waitForCount(page, SELECTORS.tile, TIMING.cardTiles);
  await settle(page, TIMING.settleMs);
  const hrefs = await page.$$eval(SELECTORS.tile, (els, n) => {
    const seen = [];
    for (const el of els) {
      const href = el.getAttribute('href');
      if (href && !seen.includes(href)) seen.push(href);
      if (seen.length >= n) break;
    }
    return seen;
  }, TIMING.cardTiles);

  const handle = await beginWindow(page, cdp);
  const navs = [];
  for (const href of hrefs) {
    const tile = tileByHref(page, href);
    await tile.scrollIntoViewIfNeeded({ timeout: 10000 });
    const nav = await openDesk(env, page, tile, href);
    nav.relatedMs = await relatedImageMs(page, nav.startAt);
    const back = await historyBack(page, {
      exactPath: ROUTES.home,
      readySel: SELECTORS.tile,
      minCount: 1,
      absentSel: SELECTORS.deskRoot,
    });
    nav.backMs = back.ms;
    navs.push(nav);
    if (back.ms == null) {
      env.log(`card: back to home failed (${back.error || 'timeout'}); reloading home`);
      await gotoPath(env, page, ROUTES.home);
    }
    await waitForCount(page, SELECTORS.tile, TIMING.cardTiles);
    await sleep(300);
  }
  const win = await endWindow(page, cdp, handle, { interactive: true });
  return {
    metrics: {
      ...win.metrics,
      ...navArrays(navs),
      'nav.toRelatedImageMs': navs.map((n) => n.relatedMs ?? null),
      'nav.backMs': navs.map((n) => n.backMs),
    },
    detail: { ...win.detail, navs: navDetail(navs) },
  };
}

/** Search results -> scroll -> open a card -> history.back(): results paint + scroll restore. */
export async function back(env) {
  const { page, cdp } = await env.newPage();
  await gotoPath(env, page, ROUTES.search(QUERIES.results));
  await waitForCount(page, SELECTORS.resultsTile, 12);
  await settle(page, TIMING.settleMs);
  await page.evaluate(() => window.scrollTo(0, Math.round(window.innerHeight * 1.5)));
  await sleep(800);
  const savedY = await page.evaluate(() => window.scrollY);
  const href = await page.$$eval(SELECTORS.resultsTile, (els) => {
    const vh = window.innerHeight;
    const inView = els.find((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= vh && r.width > 0;
    });
    return (inView || els[0]).getAttribute('href');
  });
  const open = await openDesk(env, page, tileByHref(page, href), href);
  if (open.headingMs == null) throw new Error(`back: desk ${href} did not paint`);
  await settle(page, 1000);

  const handle = await beginWindow(page, cdp);
  const res = await historyBack(page, {
    pathPrefix: ROUTES.searchPath,
    readySel: SELECTORS.resultsTile,
    minCount: 1,
    absentSel: SELECTORS.deskRoot,
  });
  await sleep(1000);
  const finalY = await page.evaluate(() => window.scrollY);
  const win = await endWindow(page, cdp, handle);
  const deltaAtPaint = res.scrollY == null ? null : Math.abs(res.scrollY - savedY);
  const delta = Math.abs(finalY - savedY);
  return {
    metrics: {
      ...win.metrics,
      'back.toResultsMs': res.ms,
      'back.savedY': savedY,
      'back.scrollDeltaAtPaintPx': deltaAtPaint,
      'back.scrollDeltaPx': delta,
      'back.scrollRestored': delta <= 50 ? 1 : 0,
      ...navArrays([open]),
    },
    detail: { ...win.detail, card: href, back: res, savedY, finalY },
  };
}

/** Waits for the desk's Next (or Previous) card-in-set link. */
async function neighborLink(page, preferred) {
  const order = preferred === 'next' ? ['next', 'prev'] : ['prev', 'next'];
  for (const dir of order) {
    const locator = page.locator(dir === 'next' ? SELECTORS.deskNext : SELECTORS.deskPrev).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: dir === preferred ? 5000 : 1000 });
      return { locator, dir };
    } catch {
      // try the other direction
    }
  }
  return null;
}

/** Open a card, then walk Next-card-in-set 20 times, each as soon as the heading paints. */
export async function rapid20(env) {
  const { page, cdp } = await env.newPage();
  await gotoPath(env, page, ROUTES.search(QUERIES.results));
  await waitForCount(page, SELECTORS.resultsTile, 1);
  await settle(page, TIMING.settleMs);
  const first = page.locator(SELECTORS.resultsTile).first();
  const firstHref = await first.getAttribute('href');
  const open = await openDesk(env, page, first, firstHref, 'heading');
  if (open.headingMs == null) throw new Error(`rapid20: desk ${firstHref} did not paint`);

  const handle = await beginWindow(page, cdp);
  const navs = [];
  let dir = 'next';
  const t0 = wallNow();
  for (let i = 0; i < TIMING.rapidNavs; i += 1) {
    const link = await neighborLink(page, dir);
    if (!link) throw new Error(`rapid20: no neighbour link after ${i} navigations`);
    dir = link.dir;
    const href = await link.locator.getAttribute('href');
    navs.push({ dir, ...(await openDesk(env, page, link.locator, href, 'heading')) });
  }
  const totalMs = wallNow() - t0;
  const win = await endWindow(page, cdp, handle, { interactive: true });
  const nav = navArrays(navs);
  delete nav['nav.toImageMs'];
  return {
    metrics: { ...win.metrics, ...nav, 'rapid.totalMs': Math.round(totalMs) },
    detail: { ...win.detail, start: firstHref, navs: navDetail(navs).map(({ imageMs, backMs, ...n }) => n) },
  };
}

/** Authenticated: load the collection page, open the first editor and cancel it. */
export async function collection(env) {
  if (!env.opts.authState) return { skipped: 'no auth state' };
  const { page, cdp } = await env.newPage({ auth: true });
  const handle = await beginWindow(page, cdp, { newDocument: true });
  await gotoPath(env, page, AUTH.collectionPath);
  await page.waitForSelector(AUTH.collectionReady, { timeout: TIMING.readyTimeoutMs });
  const readyMs = await pageNow(page);
  await waitLoadTail(page, 2000);
  let editOpened = 0;
  const edit = page.locator(AUTH.collectionEdit).first();
  if (await edit.count()) {
    await env.press(edit);
    await page.locator(AUTH.collectionEditor).first().waitFor({ state: 'visible', timeout: 5000 })
      .then(() => { editOpened = 1; }, () => {});
    await page.keyboard.press('Escape'); // never saves
  }
  const win = await endWindow(page, cdp, handle, { interactive: true });
  const load = await loadMetrics(page);
  return {
    metrics: { ...load.metrics, ...win.metrics, 'auth.readyMs': Math.round(readyMs), 'auth.editOpened': editOpened },
    detail: { ...load.detail, ...win.detail },
  };
}

/** Authenticated: cart render, then click through to checkout and stop once it renders. */
export async function checkout(env) {
  if (!env.opts.authState) return { skipped: 'no auth state' };
  const { page, cdp } = await env.newPage({ auth: true });
  const handle = await beginWindow(page, cdp, { newDocument: true });
  await gotoPath(env, page, AUTH.cartPath);
  const title = page.locator(AUTH.cartReady).first();
  await title.waitFor({ state: 'visible', timeout: TIMING.readyTimeoutMs });
  const cartReadyMs = await pageNow(page);
  if (AUTH.cartEmptyText.test((await title.textContent()) || '')) {
    await handle.heap.stop();
    return { skipped: 'cart is empty (add an item with the test account first)' };
  }
  const link = page.locator(AUTH.checkoutLink).first();
  await link.waitFor({ state: 'visible', timeout: 10000 });
  const wid = await armPage(page, { pathPrefix: AUTH.checkoutPath, readySel: AUTH.checkoutReady, minCount: 1 });
  await env.press(link);
  const res = await awaitWatcher(page, wid);
  // Stop at checkout render: never pick a payment method, submit, or place an order.
  const win = await endWindow(page, cdp, handle, { interactive: true });
  return {
    metrics: { ...win.metrics, 'auth.cartReadyMs': Math.round(cartReadyMs), 'auth.toCheckoutMs': res.ms },
    detail: { ...win.detail, checkout: res },
  };
}
