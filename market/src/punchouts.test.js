import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APP,
  DASHBOARD_HOME,
  DASHBOARD_ORIGIN,
  DASHBOARD_ORIGIN_HOME,
  DASHBOARD_ORIGIN_SCAN,
  DASHBOARD_SCAN,
  MARKET_ORIGIN,
  authFrom,
  goMarket,
  isDashboardDeskPath,
  marketUrl,
} from './punchouts.js';

test('every APP route stays on this host', () => {
  for (const [name, path] of Object.entries(APP)) {
    assert.equal(path.startsWith('/'), true, name);
    assert.equal(path.startsWith('//'), false, name);
    assert.equal(path.includes('://'), false, name);
    assert.equal(path.includes('app.pokoin.com'), false, name);
  }
});

test('authFrom stays on /auth', () => {
  const href = authFrom('/marketplace/en/cards/1/foo');
  assert.equal(href.startsWith('/auth?from='), true);
  assert.equal(href.includes('app.pokoin.com'), false);
});

test('canonical desk paths are apex-relative; legacy host kept for redirects', () => {
  assert.equal(DASHBOARD_ORIGIN, 'https://dashboard.pokoin.com');
  assert.equal(DASHBOARD_HOME, '/dashboard');
  assert.equal(DASHBOARD_SCAN, '/dashboard/scan');
  assert.equal(APP.dashboard, '/dashboard');
  assert.equal(APP.dashboardScan, '/dashboard/scan');
  assert.equal(DASHBOARD_ORIGIN_HOME, 'https://dashboard.pokoin.com/');
  assert.equal(DASHBOARD_ORIGIN_SCAN, 'https://dashboard.pokoin.com/scan');
  assert.equal(DASHBOARD_HOME.includes('://'), false);
});

test('marketUrl keeps relative paths on pokoin.com and abs on legacy dashboard host', () => {
  assert.equal(marketUrl('/marketplace', 'pokoin.com'), '/marketplace');
  assert.equal(marketUrl('/marketplace/search', 'www.pokoin.com'), '/marketplace/search');
  assert.equal(marketUrl('/dashboard', 'pokoin.com'), '/dashboard');
  assert.equal(
    marketUrl('/marketplace', 'dashboard.pokoin.com'),
    `${MARKET_ORIGIN}/marketplace`,
  );
  assert.equal(
    marketUrl('/wallet', 'dashboard.pokoin.com'),
    `${MARKET_ORIGIN}/wallet`,
  );
});

test('goMarket only hard-assigns absolute http(s) URLs', () => {
  const assigned = [];
  const prev = globalThis.window;
  globalThis.window = {
    location: {
      assign(url) {
        assigned.push(url);
      },
    },
  };
  try {
    assert.equal(goMarket('/marketplace', 'pokoin.com'), '/marketplace');
    assert.deepEqual(assigned, []);
    assert.equal(
      goMarket('/wallet', 'dashboard.pokoin.com'),
      `${MARKET_ORIGIN}/wallet`,
    );
    assert.deepEqual(assigned, [`${MARKET_ORIGIN}/wallet`]);
  } finally {
    if (prev === undefined) delete globalThis.window;
    else globalThis.window = prev;
  }
});

test('dashboard desk paths include apex /dashboard and legacy host paths', () => {
  assert.equal(isDashboardDeskPath('/'), true);
  assert.equal(isDashboardDeskPath(''), true);
  assert.equal(isDashboardDeskPath('/scan'), true);
  assert.equal(isDashboardDeskPath('/inventory/scan'), true);
  assert.equal(isDashboardDeskPath('/dashboard'), true);
  assert.equal(isDashboardDeskPath('/dashboard/scan'), true);
  assert.equal(isDashboardDeskPath('/marketplace'), false);
  assert.equal(isDashboardDeskPath('/inventory'), false);
});
