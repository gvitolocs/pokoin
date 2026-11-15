import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync(new URL('./BuySell.jsx', import.meta.url), 'utf8');
const fixture = fs.readFileSync(new URL('./buysell-preview-fixture.js', import.meta.url), 'utf8');

// One component each: an assertion about the Wanted board cannot be met by My offers.
const between = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
const shared = between('function ownOfferActions', 'function OwnOfferButtons');
const buttons = between('function OwnOfferButtons', 'function Wanted');
const wanted = between('function Wanted', 'function OfferEditor');
const mine = between('function MyOffers', 'function SellToBuyers');

test('the Wanted board marks the rows the signed-in caller posted themselves', () => {
  // The open ids come from /mine, asked once, only after Auth settles a signed-in visitor.
  assert.match(wanted, /createSignal\(props\.preview \? new Set\(previewOwnIds\(\)\) : new Set\(\)\)/);
  assert.match(wanted, /createEffect\(\(\) => signedIn\(\), \(ready\) => \{/);
  assert.match(wanted, /if \(props\.preview \|\| ownAsked \|\| !ready\) return;/);
  assert.match(wanted, /ownAsked = true;\n\s*markOwnOffers\(\);/);
  assert.match(wanted, /setOwnIds\(openBuyOrderIds\(\(await fetchMyBuyOrders\(await getBearer\(\)\)\)\?\.items\)\)/);
  assert.match(wanted, /const isOwn = \(item\) => ownIds\(\)\.has\(String\(item\.id\)\);/);
  // A read that fails costs the marking only: the board still paints and no banner claims a break.
  const mark = wanted.slice(wanted.indexOf('async function markOwnOffers'), wanted.indexOf('createEffect(() => signedIn'));
  assert.match(mark, /\} catch \(_\) \{/);
  assert.doesNotMatch(mark, /setError/);
  // The tag on a marked row, and the preview row that shows it without signing in.
  assert.match(wanted, /<span class="buysell-own">Your offer<\/span>/);
  assert.match(fixture, /export function previewOwnIds\(\) \{\n\s*return \[WANTED\[0\]\.id\];/);
});

test('a marked board row gets Edit and Delete and never Sell now', () => {
  assert.match(wanted, /<Show when=\{!isOwn\(item\)\}>/);
  assert.match(wanted, /<Show when=\{isOwn\(item\)\}>\s*<OwnOfferButtons order=\{item\} actions=\{own\} \/>/);
  // Sell now is the other buyers' branch, and the board builds it in exactly one place.
  assert.equal((wanted.match(/<SellNowForm/g) || []).length, 1);
  assert.doesNotMatch(buttons, /Sell now/);
  // Card page stays for your own row too.
  assert.match(wanted, /<AppLink to=\{cardPath\(item\.card_id\)\}>Card page<\/AppLink>/);
  // A delete takes the row out of the loaded pages instead of fetching the board again.
  const deleted = wanted.slice(wanted.indexOf('onDeleted:'), wanted.indexOf('// The PATCH answer'));
  assert.match(deleted, /setItems\(\(rows\) => \(rows \|\| \[\]\)\.filter\(\(row\) => String\(row\.id\) !== String\(order\.id\)\)\)/);
  assert.doesNotMatch(deleted, /load\(/);
  // The editor is the My offers one, and a failed write lands in the board's own Alert.
  assert.match(wanted, /<OfferEditor\n\s+order=\{item\}/);
  assert.match(wanted, /onError: setError,/);
  // The two buttons are the shared piece, with the shared confirm and DELETE.
  assert.match(buttons, />Edit</);
  assert.match(buttons, />Delete offer</);
  assert.match(shared, /window\.confirm\('Delete this offer\?'\)/);
  assert.match(shared, /await cancelBuyOrder\(order\.id, await getBearer\(\)\)/);
});

test('My offers deletes through the same actions, under the Delete offer name', () => {
  assert.match(mine, /const own = ownOfferActions\(\{/);
  assert.match(mine, /<OwnOfferButtons order=\{order\} actions=\{own\} \/>/);
  assert.match(mine, /onDeleted: \(\) => load\(\),/);
  // No second copy of the editor state or the delete request in the tab.
  assert.doesNotMatch(mine, /const \[editing|const \[busyId|window\.confirm|cancelBuyOrder|setBusyId/);
  assert.doesNotMatch(src, /Cancel offer|Cancel this offer/);
});

test('a signed-out visitor still gets the plain public board', () => {
  // Nothing is asked and nothing is marked: the row set starts empty, so every row is somebody else's.
  assert.match(wanted, /: new Set\(\)\)/);
  assert.doesNotMatch(wanted, /signedIn\(\)\s*\?/);
  // The public board read and its Sell now button are untouched.
  assert.match(wanted, /await fetchBuyBoard\(\{ limit: BOARD_PAGE, sort: sort\(\), before: reset \? '' : next\(\) \}\)/);
  assert.match(wanted, /<SellNowForm order=\{item\} preview=\{props\.preview\} onDone=\{\(\) => load\(true\)\} \/>/);
});
