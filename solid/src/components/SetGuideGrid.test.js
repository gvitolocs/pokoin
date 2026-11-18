import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync(new URL('./SetGuideGrid.jsx', import.meta.url), 'utf8');

test('SetGuideGrid drags the whole set card, not only the wordmark img', () => {
  assert.match(src, /class="set-guide-card"[\s\S]*?draggable="true"/);
  assert.match(src, /kind: 'expansion'/);
  assert.match(src, /draggable="false"/);
});

test('set tiles show the print flag beside the name, never on the logo', () => {
  assert.match(src, /class="set-shortcut is-on"/);
  // Nationality goes through resolveExpansionNationality (pins for empty/unknown catalog values, PR 254).
  assert.match(src, /printFlagFromNationality\(resolveExpansionNationality\(props\.row\)\)/);
  assert.match(src, /set-guide-print-flag/);
  assert.doesNotMatch(src.match(/function SetGuideLogo[\s\S]*?\n\}/)[0], /printFlag/);
  const expansion = fs.readFileSync(new URL('../pages/Expansion.jsx', import.meta.url), 'utf8');
  assert.match(expansion, /set-sym-wrap/);
});
