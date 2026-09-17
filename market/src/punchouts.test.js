import assert from 'node:assert/strict';
import test from 'node:test';
import { APP, DASHBOARD_ORIGIN, DASHBOARD_SCAN, authFrom } from './punchouts.js';

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


test('dashboard desk is the Scan Connect host, not app.pokoin.com', () => {
  assert.equal(DASHBOARD_ORIGIN, 'https://dashboard.pokoin.com');
  assert.equal(DASHBOARD_SCAN, 'https://dashboard.pokoin.com/scan');
  assert.equal(DASHBOARD_SCAN.includes('app.pokoin.com'), false);
});
