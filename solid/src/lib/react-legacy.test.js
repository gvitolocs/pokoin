import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { UI_KEY, UI_ONCE_KEY, reactLegacyReason } from './react-legacy.js';

function memory(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (Object.hasOwn(data, key) ? data[key] : null),
    removeItem: (key) => { delete data[key]; },
  };
}

test('?ui=react, a React preference and a handoff are reported once and cleared', () => {
  assert.equal(reactLegacyReason({ search: '?ui=react' }), 'ui=react');
  const local = memory({ [UI_KEY]: 'react-auto' });
  assert.equal(reactLegacyReason({ local }), 'pref:react-auto');
  assert.equal(local.data[UI_KEY], undefined);
  assert.equal(reactLegacyReason({ local }), '', 'reported once');
  const session = memory({ [UI_ONCE_KEY]: 'react' });
  assert.equal(reactLegacyReason({ session }), 'handoff:react');
  assert.equal(session.data[UI_ONCE_KEY], undefined);
});

test('the query wins, and every stored switch value is cleared', () => {
  const local = memory({ [UI_KEY]: 'react' });
  const session = memory({ [UI_ONCE_KEY]: 'react' });
  assert.equal(reactLegacyReason({ search: '?ui=react&q=x', local, session }), 'ui=react');
  assert.deepEqual([local.data, session.data], [{}, {}]);
});

test('Solid preferences and plain loads are silent; stale Solid prefs are cleared', () => {
  const local = memory({ [UI_KEY]: 'solid-auto' });
  assert.equal(reactLegacyReason({ search: '?ui=solid', local }), '');
  assert.deepEqual(local.data, {});
  assert.equal(reactLegacyReason({ search: '?q=pikachu' }), '');
  const blocked = { getItem() { throw new Error('denied'); }, removeItem() {} };
  assert.equal(reactLegacyReason({ local: blocked, session: blocked }), '');
});

test('the entry installs the tripwire and App reports it as [react-legacy]', () => {
  const main = fs.readFileSync(new URL('../main.jsx', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  assert.match(main, /installReactLegacyTripwire\(\);[\s\S]*render\(/);
  assert.match(app, /reportClientError\(new Error\(`\[react-legacy\] \$\{legacy\} \$\{location\.pathname\}`\)\)/);
});
