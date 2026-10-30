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

const tile = read('./zero/ZeroTile.jsx');
const sortBar = read('./zero/ZeroSortBar.jsx');
const nav = read('./StockNav.jsx');

test('images views keep two rows, To pick then Picked, keyed by lineKey', () => {
  assert.match(pack, /title="To pick"/);
  assert.match(pack, /title="Picked"/);
  assert.match(tile, /draggable="false"/);
  assert.match(pack, /setPicked\(line, action\.to === 'picked' \? lineQuantity\(line\) : 0\)/);
  assert.match(tile, /lineKey: lineKeyOf\(item\(\)\)/);
  assert.match(pack, /'Nothing left to pick\.'/);
  assert.match(pack, /groupLinesByGame/);
  assert.match(pack, /groupsFor\(lines\(\), groupMode\(\)\)/);
});

test('the PT tile: name, # cn - set, price, bin, Picked x/y, rarity, flag, condition, location, comment, Pick, Report issue', () => {
  assert.match(tile, /lineSetText\(item\(\)\)/);
  assert.match(tile, /Bin \{item\(\)\.powerTools\.bin\}/);
  assert.match(tile, /Picked: \{pick\(\)\.picked\}\/\{quantity\(\)\}/);
  assert.match(tile, /rarityBadge\(item\(\)\.rarity\)/);
  assert.match(tile, /listingLanguageFlag\(item\(\)\.language\)/);
  assert.match(tile, /conditionChipSrc\(item\(\)\.condition\)/);
  assert.match(tile, /<PinIcon \/>/);
  assert.match(tile, /locationTakeText\(item\(\)\)/);
  assert.match(tile, /<CommentIcon text=\{comment\(\)\} \/>/);
  assert.match(tile, /'zero-pick-main'/);
  assert.match(tile, />Report issue</);
  assert.match(tile, /Picked from another box…/);
  assert.match(tile, /'is-horizontal': Boolean\(props\.horizontal\)/);
  assert.match(bits, /\{quantity\(\)\} of \{props\.item\.itemQuantity\}/);
  assert.match(bits, /also in: \{alsoInLabels\(props\.item\)\.join\(', '\)\}/);
});

test('a pick moves inventory: sent once, disabled in flight, never replayed offline', () => {
  assert.match(pack, /pickActionBody\(untrack\(order\), line, action, listingId\)/);
  assert.match(pack, /if \(pickFlight\.has\(key\)\) return; \/\/ a double click never sends twice/);
  assert.match(pack, /disabled|isBusy/);
  assert.match(tile, /disabled=\{props\.busy\}/);
  assert.match(list, /disabled=\{busy\(\)\}/);
  assert.match(pack, /inventoryNote\(\{ inventory, action, listingId: body\.listingId \}, lineCopies\(line\)\)/);
  assert.match(pack, /dropUnsentPicks/);
  assert.match(pack, /pickSaveBody\(untrack\(orderId\), lineKey, entry, \['issue'\]\)/);
  assert.match(pack, /if \(props\.preview \|\| inFlight\.has\(lineKey\)\) return false;/);
  assert.match(pack, /window\.addEventListener\('online', flushDirty\)/);
  assert.match(pack, /if \(retryableSaveError\(err\)\) return false;/);
  assert.match(pack, /Not saved: /);
  // An issue never calls pick.
  assert.match(pack, /onClearIssue: \(line\) => setIssue\(line, null\)/);
  assert.match(page, /preview=\{props\.preview\}/);
});

test('four views remembered in pokoin.ctZero.view; single image is the inline picking card', () => {
  assert.match(page, /<For each=\{ZERO_VIEWS\}>/);
  assert.match(page, /normalizeView\(window\.localStorage\.getItem\(VIEW_KEY\)\)/);
  assert.match(pack, /view\(\) === 'images-vertical'/);
  assert.match(pack, /view\(\) === 'images-horizontal'/);
  assert.match(pack, /view\(\) === 'list'/);
  assert.match(pack, /view\(\) === 'single'/);
  assert.match(pack, /<PickingMode\s+inline/);
  assert.match(picking, /props\.inline \? 'Single image' : 'Picking'/);
  assert.match(picking, /window\.removeEventListener\('keydown', onKey\)/);
  assert.match(picking, /event\.key === 'Backspace'/);
});

test('header: Switch list, Reload picking list, Export; search, print, PT order', () => {
  assert.match(page, />\s*Switch list\s*</);
  assert.match(page, /'Reload picking list'/);
  assert.match(page, />Export</);
  assert.match(page, /downloadCsv\(/);
  assert.match(page, /<PendingList items=\{pendingItems\(\)\}/);
  assert.match(pack, /Sort by PT order/);
  assert.match(pack, /disabled=\{!ptComparable\(\)\}/);
  assert.match(pack, /title=\{ptSortTitle\(\)\}/);
  assert.match(pack, /const ptComparable = \(\) => order\(\)\.ptPicking\?\.comparable === true;/);
  assert.match(pack, /in a different place than in Power Tools/);
  assert.match(pack, /Your picking order matches the Power Tools order/);
  assert.match(pack, /Ct Zero closed/);
  assert.match(pack, /step\(event\.shiftKey \? -1 : 1\)/);
  assert.match(pack, /window\.print\(\)/);
  assert.match(list, /zero-print-box/);
  assert.match(css, /@media print/);
  assert.match(css, /break-inside: avoid/);
});

test('sort bar: 4 levels, Apply sort, Reset, duplicate message, CardTrader hint, Smart locations', () => {
  assert.match(sortBar, /chooseSortField\(draft\(\), level, value\)/);
  assert.match(sortBar, /disabled=\{!sortLevelEnabled\(draft\(\), level\) \|\| props\.busy\}/);
  assert.match(sortBar, /'Apply sort'/);
  assert.match(sortBar, />Reset</);
  assert.match(sortBar, /Click Apply sort to update the list on CardTrader too/);
  assert.match(sortBar, /Smart locations/);
  assert.match(sortBar, /role="switch"/);
  assert.match(pack, /sortZeroLines\(order\(\)\.items, sortFields\(\)\)/);
});

test('Apply sort: local, save on Pokoin, PT dry run then confirmed write with expectCount, restore', () => {
  assert.match(page, /setSortFields\(checked\.fields\); \/\/ instant/);
  assert.match(page, /saveCardTraderZeroSort\(token, \{ fields: checked\.fields, smartLocations: smartLocations\(\) \}\)/);
  assert.match(page, /dryRun: true/);
  assert.match(page, /expectCount: target\.count/);
  assert.match(dialogs, /Send this order \(\{props\.count\} cards\) to CardTrader through Power Tools\?/);
  assert.match(page, /'CardTrader order updated'/);
  assert.match(page, /'Power Tools kept a different order'/);
  assert.match(page, /Restore previous order/);
  assert.match(page, /sequence: restore\.before/);
  assert.match(page, /Your Power Tools session expired\. Reconnect Power Tools\./);
  assert.match(page, /href="#zero-powertools"/);
  assert.match(page, /'Saved on Pokoin\. No Power Tools picking list for this shipment\.'/);
  for (const code of ['powertools_cardtrader_not_connected', 'pt_picking_list_missing', 'pt_sort_throttled']) {
    assert.match(page, new RegExp(code));
  }
  assert.match(page, /saveCardTraderZeroSort\(token, \{ fields: sortFields\(\), smartLocations: on \}\)/);
});

test('smart locations off: every candidate box is a choice; choosing one is the swap pick', () => {
  assert.match(tile, /props\.smartLocations === false && copies\(\)\.length > 0/);
  assert.match(tile, /props\.onPick\(item\(\), copy\.listingId\)/);
  assert.match(list, /props\.onPick\(line\(\), copy\.listingId\)/);
  assert.match(dialogs, /props\.onChoose\(copy\.listingId\)/);
});

test('dialogs are labelled modals: issue, swap, PT confirmation', () => {
  assert.match(dialogs, /role="dialog" aria-modal="true" aria-labelledby=\{props\.titleId\}/);
  assert.match(dialogs, /What issue would you like to report\?/);
  assert.match(dialogs, /maxlength=\{ISSUE_NOTE_MAX\}/);
  assert.match(dialogs, /<LocationText item=\{props\.line\} \/>/);
  assert.match(dialogs, /export function SwapDialog/);
  assert.match(dialogs, /export function PtSortDialog/);
});

test('the page explains the game-first picking order and shows the refresh time', () => {
  assert.match(page, /Magic, Pokémon, Yu-Gi-Oh!, Riftbound, then the other games/);
  assert.match(page, /Refreshed at \{refreshedAt\(\)\}/);
  assert.match(page, /<ShipmentPanel/);
  assert.match(page, /onSession=\{\(\) => load\(\{ refresh: true \}\)\}/);
});

test('Power Tools locations are tagged', () => {
  assert.match(bits, /title="Location from Power Tools"/);
  assert.match(bits, /lineLocationFromPt\(props\.item\)/);
  assert.match(tile, /lineLocationFromPt\(item\(\)\) \? 'Location from Power Tools'/);
  assert.match(list, /<LocationText item=\{line\(\)\} \/>/);
  assert.match(picking, /lineLocationFromPt\(line\(\)\)/);
});

test('MyPokoin nav has Picked next to Collection', () => {
  assert.match(nav, /label: 'Collection'[^\n]*\n\s*\{ to: '\/mypokoin\/picked', label: 'Picked'/);
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

test('reverse holo is a glowing sparkles mark, not a Reverse text pill, on tiles and facet badges', () => {
  assert.match(bits, /import ReverseSparkles from '\.\.\/desk\/ReverseSparkles\.jsx';/);
  assert.match(bits, /<span class="zero-reverse" title="Reverse holo" aria-label="Reverse holo" role="img">\s*<ReverseSparkles \/>/);
  assert.match(bits, /<Show when=\{lineIsReverse\(props\.item\)\}><ReverseMark \/><\/Show>/);
  assert.match(bits, /<For each=\{lineTextFacets\(props\.item\)\}>/);
  assert.doesNotMatch(bits, /lineFacets\(/);
  assert.match(tile, /<Show when=\{lineIsReverse\(item\(\)\)\}><ReverseMark \/><\/Show>/);
  assert.match(tile, /lineTextFacets\(\{ \.\.\.line, condition: '', language: '' \}\)/);
  assert.doesNotMatch(tile, /lineFacets\(/);
  assert.match(css, /\.zero-reverse \{[^}]*animation: zero-reverse-glow/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.zero-reverse \{ animation: none; \}/);
  assert.match(css, /\.zero-reverse \.reverse-sparkles path \{ fill: #000;/);
});
