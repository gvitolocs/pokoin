import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const DESK_CSS = new URL('../../../../market/src/desk.css', import.meta.url);

test('MyPokoin row and tile links highlight on hover without the global underline', () => {
  // a:hover { text-decoration: underline } ran through every cell of the hovered
  // Live listings row (Flamefish · Dawn Of History · EN · 1 · 17/10).
  const css = fs.readFileSync(DESK_CSS, 'utf8');
  const rule = css.match(/((?:\.[\w-]+:hover,\s*)*\.[\w-]+:hover)\s*\{\s*text-decoration:\s*none;\s*\}/);
  assert.ok(rule, 'a text-decoration: none hover rule');
  const selectors = rule[1].split(',').map((part) => part.trim());
  for (const selector of ['.inv-row:hover', '.inv-card:hover', '.loc-posting:hover', '.collection-tile:hover']) {
    assert.ok(selectors.includes(selector), selector);
  }
});
