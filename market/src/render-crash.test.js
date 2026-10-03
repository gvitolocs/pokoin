import assert from 'node:assert/strict';
import test from 'node:test';
import {
  currentSuggestState,
  noteSuggestState,
  renderCrashRecord,
  resetSuggestStateForTests,
} from './render-crash.js';

test('render crash record keeps the exception, route, and search generation', () => {
  resetSuggestStateForTests();
  noteSuggestState({ query: 'pikachu ex', generation: 4 });
  const lines = [];
  const original = console.error;
  console.error = (...args) => {
    lines.push(args);
  };
  try {
    const error = new TypeError('Cannot read properties of null (reading \'id\')');
    const record = renderCrashRecord(error, {
      componentStack: '\n    at SearchBox\n    at Chrome',
    });
    assert.equal(record.name, 'TypeError');
    assert.match(record.message, /reading 'id'/);
    assert.match(record.componentStack, /SearchBox/);
    assert.equal(record.query, 'pikachu ex');
    assert.equal(record.generation, 4);
    assert.equal(lines.length, 1);
    assert.equal(lines[0][0], 'pokoin render failed');
    assert.equal(lines[0][1].name, 'TypeError');
    assert.equal(globalThis.__pokoinRenderCrash.query, 'pikachu ex');
    assert.deepEqual(currentSuggestState(), { query: 'pikachu ex', generation: 4 });
  } finally {
    console.error = original;
    resetSuggestStateForTests();
  }
});

test('render crash record strips bearer tokens from the message', () => {
  resetSuggestStateForTests();
  const original = console.error;
  console.error = () => {};
  try {
    const error = new Error('failed bearer eyJabc.def.ghi for user');
    const record = renderCrashRecord(error, { componentStack: '' });
    assert.equal(record.message.includes('eyJabc'), false);
    assert.match(record.message, /\[redacted\]/);
  } finally {
    console.error = original;
    resetSuggestStateForTests();
  }
});
