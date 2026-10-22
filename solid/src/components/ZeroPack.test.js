import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const pack = read('./ZeroPack.jsx');
const page = read('../pages/CardTraderZero.jsx');
const list = read('./zero/ZeroList.jsx');
const picking = read('./zero/PickingMode.jsx');
const dialogs = read('./zero/ZeroDialogs.jsx');
const bits = read('./zero/zero-bits.jsx');
const css = read('../../../market/src/zero-pack.css');

test('the Cards view keeps two rows, Pick then Picked, keyed by lineKey', () => {
  assert.match(pack, /title="Pick"/);
  assert.match(pack, /title="Picked"/);
  assert.match(pack, /draggable="false"/);
  assert.match(pack, /setPicked\(line, action\.to === 'picked' \? lineQuantity\(line\) : 0\)/);
  assert.match(pack, /lineKey: lineKeyOf\(item\(\)\)/);
  assert.match(pack, /Mark picked/);
  assert.match(pack, /Undo/);
  assert.match(pack, /'Nothing left to pick\.'/);
  assert.doesNotMatch(pack, /places\.get\(item\.itemId\)/);
  assert.match(pack, /groupLinesByGame/);
});

test('per-box lines show take N, N of M, also in, and picked x/y', () => {
  assert.match(bits, /take \{quantity\(\)\}/);
  assert.match(bits, /\{quantity\(\)\} of \{props\.item\.itemQuantity\}/);
  assert.match(bits, /also in: \{props\.item\.alsoIn\.join\(', '\)\}/);
  assert.match(pack, /picked \{pick\(\)\.picked\}\/\{quantity\(\)\}/);
  assert.match(pack, /aria-pressed=/);
});

test('picked state is server first, saved with saveCardTraderZeroPick, never in preview', () => {
  assert.match(pack, /saveCardTraderZeroPick\(token, body\)/);
  assert.match(pack, /if \(props\.preview \|\| inFlight\.has\(lineKey\)\) return false;/);
  assert.match(pack, /window\.addEventListener\('online', flushDirty\)/);
  assert.match(pack, /takeLegacyPicked/);
  assert.match(page, /preview=\{props\.preview\}/);
});

test('views, search, CSV, print, PT order, picking mode', () => {
  assert.match(pack, />Cards<\/button>/);
  assert.match(pack, />List<\/button>/);
  assert.match(pack, /Start picking/);
  assert.match(pack, /Export CSV/);
  assert.match(pack, /window\.print\(\)/);
  assert.match(pack, /Sort by PT order/);
  assert.match(pack, /disabled=\{!ptComparable\(\)\}/);
  assert.match(pack, /in a different place than in Power Tools/);
  assert.match(pack, /Your picking order matches the Power Tools order/);
  assert.match(pack, /Ct Zero closed/);
  assert.match(pack, /step\(event\.shiftKey \? -1 : 1\)/);
  assert.match(list, /nameEn/);
  assert.match(list, /zero-print-box/);
  assert.match(picking, /window\.removeEventListener\('keydown', onKey\)/);
  assert.match(picking, /event\.key === 'Backspace'/);
  assert.match(css, /@media print/);
  assert.match(css, /break-inside: avoid/);
});

test('dialogs are labelled modals: quantity and issue', () => {
  assert.match(dialogs, /role="dialog" aria-modal="true" aria-labelledby=\{props\.titleId\}/);
  assert.match(dialogs, /What issue would you like to report\?/);
  assert.match(dialogs, />All</);
  assert.match(dialogs, />None</);
  assert.match(dialogs, />Done</);
  assert.match(pack, /issue: null/);
});

test('the page explains the game-first picking order and shows the refresh time', () => {
  assert.match(page, /Magic, Pokémon, Yu-Gi-Oh!, Riftbound, then the other games/);
  assert.match(page, /Refreshed at \{refreshedAt\(\)\}/);
  assert.match(page, /<ShipmentPanel/);
  assert.match(page, /onSession=\{\(\) => load\(\{ refresh: true \}\)\}/);
});

test('Power Tools locations are tagged, rejected saves surface, PT sort needs a comparable list', () => {
  assert.match(bits, /title="Location from Power Tools"/);
  assert.match(bits, /lineLocationFromPt\(props\.item\)/);
  assert.match(pack, /<LocationText item=\{item\(\)\} \/>/);
  assert.match(list, /<LocationText item=\{line\(\)\} \/>/);
  assert.match(picking, /lineLocationFromPt\(line\(\)\)/);
  assert.match(dialogs, /<LocationText item=\{props\.line\} \/>/);
  assert.match(dialogs, /maxlength=\{ISSUE_NOTE_MAX\}/);
  assert.match(pack, /pickSaveBody\(untrack\(orderId\), lineKey, entry, fields\)/);
  assert.match(pack, /if \(retryableSaveError\(err\)\) return false;/);
  assert.match(pack, /Not saved: /);
  assert.match(pack, /const ptComparable = \(\) => order\(\)\.ptPicking\?\.comparable === true;/);
  assert.match(pack, /title=\{ptSortTitle\(\)\}/);
});

test('a big pack loads fast: lazy dialogs, print list only while printing, two-phase load', () => {
  assert.match(pack, /lazy\(\(\) => import\('\.\/zero\/PickingMode\.jsx'\)\)/);
  assert.match(pack, /lazy\(\(\) => import\('\.\/zero\/ZeroDialogs\.jsx'\)/);
  assert.doesNotMatch(pack, /^import PickingMode/m);
  assert.match(pack, /<Show when=\{printing\(\)\}><ZeroList \{\.\.\.rowProps\} groups=\{allGroups\(\)\} printOnly \/><\/Show>/);
  assert.match(pack, /addEventListener\('beforeprint', startPrint\)/);
  assert.match(page, /fetchCardTraderZero\(token, \{ powerTools: false, refresh \}\)/);
  assert.match(page, /if \(inflight\) return inflight;/);
  assert.match(page, /readLastPack\(storage\(\), authUid\(\)\)/);
  assert.match(page, /load\(\{ refresh: true \}\)/);
});
