import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APP,
  DASHBOARD_HOME,
  DASHBOARD_ORIGIN,
  DASHBOARD_SCAN,
  MARKET_ORIGIN,
  authFrom,
  isDashboardDeskPath,
  legacyDashboardHref,
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

test('dashboard desk is /dashboard on pokoin.com, not a second origin', () => {
  assert.equal(DASHBOARD_HOME, '/dashboard');
  assert.equal(DASHBOARD_SCAN, '/dashboard/scan');
  assert.equal(DASHBOARD_ORIGIN, 'https://dashboard.pokoin.com');
  assert.equal(DASHBOARD_HOME.includes('app.pokoin.com'), false);
  assert.equal(DASHBOARD_SCAN.includes('://'), false);
});

test('marketUrl keeps relative paths on pokoin.com and abs on dashboard', () => {
  assert.equal(marketUrl('/marketplace', 'pokoin.com'), '/marketplace');
  assert.equal(marketUrl('/marketplace/search', 'www.pokoin.com'), '/marketplace/search');
  assert.equal(
    marketUrl('/marketplace', 'dashboard.pokoin.com'),
    `${MARKET_ORIGIN}/marketplace`,
  );
  assert.equal(
    marketUrl('/wallet', 'dashboard.pokoin.com'),
    `${MARKET_ORIGIN}/wallet`,
  );
  assert.equal(
    marketUrl('/inventory', 'dashboard.pokoin.com'),
    `${MARKET_ORIGIN}/inventory`,
  );
});

test('dashboard desk paths are seller home and Scan Connect', () => {
  assert.equal(isDashboardDeskPath('/dashboard'), true);
  assert.equal(isDashboardDeskPath('/dashboard/'), true);
  assert.equal(isDashboardDeskPath('/dashboard/scan'), true);
  assert.equal(isDashboardDeskPath('/inventory/scan'), true);
  assert.equal(isDashboardDeskPath('/'), false);
  assert.equal(isDashboardDeskPath('/scan'), false);
  assert.equal(isDashboardDeskPath('/marketplace'), false);
  assert.equal(isDashboardDeskPath('/inventory'), false);
});

test('legacy dashboard host maps home and scan onto /dashboard', () => {
  assert.equal(legacyDashboardHref('/'), 'https://pokoin.com/dashboard');
  assert.equal(legacyDashboardHref('/scan'), 'https://pokoin.com/dashboard/scan');
  assert.equal(legacyDashboardHref('/scan/'), 'https://pokoin.com/dashboard/scan');
  assert.equal(
    legacyDashboardHref('/marketplace', '?q=pikachu'),
    'https://pokoin.com/marketplace?q=pikachu',
  );
  assert.equal(
    legacyDashboardHref('/', '?dashPreview=1'),
    'https://pokoin.com/dashboard?dashPreview=1',
  );
});
