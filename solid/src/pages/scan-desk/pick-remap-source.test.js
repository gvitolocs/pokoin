import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../ScanDesk.jsx', import.meta.url), 'utf8');

function body(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = source.indexOf('\n  /**', start);
  return source.slice(start, next > start ? next : start + 1500);
}

test('startDraft never swaps the picked printing', () => {
  const fn = body('startDraft');
  assert.doesNotMatch(fn, /remapDraftArtwork/);
  assert.match(fn, /draftLanguageForPick\(card, d\.language\)/);
});

test('the draft language hotkey still remaps to that language printing', () => {
  assert.match(source, /cmd\.field === 'language' && current\.cardId\) \{\s*void remapDraftArtwork\(/);
});

test('search preserves nationality and a created draft is guarded before rows render', () => {
  const suggest = readFileSync(new URL('../../lib/live-suggest.js', import.meta.url), 'utf8');
  const rows = readFileSync(new URL('./rows.jsx', import.meta.url), 'utf8');
  assert.match(suggest, /nationality: printing\.nationality/);
  const commit = body('commitDraft');
  assert.ok(commit.indexOf('markPick(') < commit.indexOf("dispatch({ type: 'items'"));
  assert.match(rows, /const remapTried = props\.remapTried/);
  assert.match(rows, /props\.remapTried\.has\(tryKey/);
});
