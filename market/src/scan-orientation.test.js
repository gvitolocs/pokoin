import assert from 'node:assert/strict';
import test from 'node:test';
import { installScanOrientation, markScanOrientation, scanOrientation } from './scan-orientation.js';

function image(naturalWidth, naturalHeight, complete = true) {
  return { tagName: 'IMG', naturalWidth, naturalHeight, complete, dataset: {} };
}

test('a landscape-stored BREAK scan is told apart from the portrait convention', () => {
  assert.equal(scanOrientation(880, 630), 'landscape');
  assert.equal(scanOrientation(638, 900), 'portrait');
  assert.equal(scanOrientation(630, 630), 'portrait');
  assert.equal(scanOrientation(0, 0), '');
});

test('marking stamps data-scan-orient and skips images that have not decoded', () => {
  const golduck = image(1000, 716);
  markScanOrientation(golduck);
  assert.equal(golduck.dataset.scanOrient, 'landscape');
  const pending = image(0, 0, false);
  markScanOrientation(pending);
  assert.equal(pending.dataset.scanOrient, undefined);
  markScanOrientation({ tagName: 'DIV', dataset: {} });
});

test('the listener marks later loads, images already loaded, and installs once', () => {
  const listeners = [];
  const loaded = image(638, 900);
  const doc = {
    images: [loaded, image(0, 0, false)],
    addEventListener(type, handler, capture) { listeners.push({ type, handler, capture }); },
  };
  installScanOrientation(doc);
  installScanOrientation(doc);
  assert.equal(listeners.length, 1);
  assert.deepEqual([listeners[0].type, listeners[0].capture], ['load', true]);
  assert.equal(loaded.dataset.scanOrient, 'portrait');
  const later = image(880, 630);
  listeners[0].handler({ target: later });
  assert.equal(later.dataset.scanOrient, 'landscape');
});
