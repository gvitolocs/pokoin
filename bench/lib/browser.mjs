// Browser launch and per-profile context setup shared by run.mjs and profile.mjs.
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { SELECTORS, TIMING } from '../config.mjs';
import { installBenchObservers } from './observers.mjs';
import { openCdp } from './cdp.mjs';

/**
 * channel 'chromium' = full Chromium in new-headless mode (closest to real Chrome);
 * 'headless-shell' = Playwright's lighter old-headless shell; 'chrome' = installed Chrome.
 */
export async function launch({ headed = false, channel = 'chromium' } = {}) {
  return chromium.launch({
    headless: !headed,
    ...(channel && channel !== 'headless-shell' ? { channel } : {}),
  });
}

export function playwrightVersion() {
  try {
    return createRequire(import.meta.url)('playwright/package.json').version;
  } catch {
    return null;
  }
}

/** Playwright context options for a profile (fresh, isolated cache and storage). */
export function contextOptions(profile, browser, { storageState = null } = {}) {
  const major = browser.version().split('.')[0];
  return {
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    ...(profile.userAgent ? { userAgent: profile.userAgent.replace('{major}', major) } : {}),
    locale: 'en-US',
    ...(storageState ? { storageState } : {}),
  };
}

/** New context + page with the observers installed and CDP throttling applied. */
export async function openBenchPage(browser, profile, { net = null, storageState = null } = {}) {
  const context = await browser.newContext(contextOptions(profile, browser, { storageState }));
  await context.addInitScript(installBenchObservers, {
    firstSelectors: { tile: SELECTORS.tile, appReady: SELECTORS.searchInput },
    firstTimeoutMs: TIMING.readyTimeoutMs,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMING.navTimeoutMs);
  const cdp = await openCdp(page, { cpuThrottle: profile.cpuThrottle, net });
  return { context, page, cdp };
}

/** Click on desktop, tap on touch profiles. */
export function pressFor(profile) {
  return (locator) => (profile.useTap ? locator.tap() : locator.click());
}
