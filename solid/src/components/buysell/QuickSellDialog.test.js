import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const dialog = read('./QuickSellDialog.jsx');
const trigger = read('./SellNowForm.jsx');
const css = read('../../../../market/src/styles.css');

test('Quick Sell is one modal dialog, named by its own title', () => {
  assert.match(dialog, /<Portal mount=\{document\.body\}>/);
  assert.match(dialog, /class="qs-scrim" aria-hidden="true"/);
  assert.match(dialog, /role="dialog"\s+aria-modal="true"\s+aria-labelledby=\{titleId\(\)\}\s+tabindex="-1"/);
  assert.match(dialog, /<h3 id=\{titleId\(\)\} class="qs-title">Sell this card<\/h3>/);
  // The × is the same close as Cancel and Escape, and it lets go only between posts.
  assert.match(dialog, /class="qs-close" aria-label="Close" disabled=\{busy\(\)\} onClick=\{close\}/);
  assert.match(dialog, /function close\(\) \{\s*if \(busy\(\)\) return;/);
  // One facet line under the card, the printing's own facets, in the chip's order.
  assert.match(dialog, /target\(\)\.condition,\s*target\(\)\.language,\s*target\(\)\.reverse \? 'Reverse' : '',\s*target\(\)\.firstEdition \? '1st Ed\.' : '',\s*\]\.filter\(Boolean\)\.join\(' · '\)/);
});

test('the dialog prices the exact target it was handed, in the saved unit', () => {
  // Nothing is looked up here: the price, order id and cap arrive in the target.
  // The target is the one handed over, or, where the seller may change facets,
  // the one the caller resolves for the exact printing picked in the dialog.
  assert.match(dialog, /const resolved = createMemo\(\(\) => \(editable\(\) \? props\.resolve\(picked\(\)\) : null\)\);/);
  assert.match(dialog, /const target = \(\) => resolved\(\) \|\| props\.target \|\| \{\};/);
  assert.match(dialog, /const pricePkn = \(\) => Number\(target\(\)\.pricePkn\) \|\| 0;/);
  // The unit is the one the visitor picked for offers, so the dialog and the
  // Define offer popup never show two different amounts for the same offer.
  assert.match(dialog, /const unit = \(\) => storedOfferUnit\(buyerCurrency\(props\.pinned\)\);/);
  assert.match(dialog, /const price = \(\) => offerPriceLabel\(pricePkn\(\), unit\(\)\);/);
  assert.match(dialog, /const pknLine = \(\) => \(unit\(\) === 'PKN' \? '' : formatPkn\(pricePkn\(\)\)\);/);
  assert.match(dialog, /house\(\) \? "Pokoin's offer" : 'Buyer offer'/);
  // The book names nobody: only a caller that knows a handle says one, and the
  // desk falls back to the anonymous buyer rather than inventing a name.
  assert.match(dialog, /const who = \(\) => \(house\(\) \? '' : String\(props\.buyerName \|\| ''\)\.trim\(\) \|\| 'A buyer'\);/);
});

test('the copies stepper walks the order’s own remaining', () => {
  assert.match(dialog, /const remaining = \(\) => Math\.max\(1, Number\(target\(\)\.remaining\) \|\| 1\);/);
  // A facet change that lowers the cap also caps the copies already chosen.
  assert.match(dialog, /const copies = \(\) => Math\.min\(qty\(\), remaining\(\)\);/);
  assert.match(dialog, /setQty\(Math\.min\(remaining\(\), Math\.max\(1, copies\(\) \+ delta\)\)\)/);
  assert.match(dialog, /disabled=\{busy\(\) \|\| copies\(\) <= 1\} onClick=\{\(\) => step\(-1\)\} aria-label="One copy fewer"/);
  assert.match(dialog, /disabled=\{busy\(\) \|\| copies\(\) >= remaining\(\)\} onClick=\{\(\) => step\(1\)\} aria-label="One copy more"/);
  // One copy wanted leaves it fixed at 1, with the hint saying so.
  assert.match(dialog, /remaining\(\) === 1 \? 'only 1 wanted' : `up to \$\{remaining\(\)\} wanted`/);
  assert.match(dialog, /role="group" aria-labelledby=\{`\$\{titleId\(\)\}-copies`\}/);
});

test('the note is optional, counted by the same rules as the wire, and blocks the sale', () => {
  assert.match(dialog, /<label class="sell-field qs-field">/);
  assert.match(dialog, /placeholder="Sleeved since opening, ready to ship…"/);
  assert.match(dialog, /const count = \(\) => buyerMessageLength\(note\(\)\);/);
  assert.match(dialog, /const noteBad = \(\) => buyerMessageError\(note\(\)\);/);
  assert.match(dialog, /class=\{\['qs-count', \{ 'is-over': count\(\) > BUYER_MESSAGE_MAX \}\]\} aria-live="polite">\{count\(\)\}\/\{BUYER_MESSAGE_MAX\}/);
  assert.match(dialog, /house\(\) \? 'Note to Pokoin \(optional\)' : 'Message to buyer \(optional\)'/);
  assert.match(dialog, /house\(\) \? 'Sent to Pokoin with the notification\.' : 'Sent to the buyer with the notification\.'\} This is not a chat\./);
  // Over the limit is a red counter and no sale: the button is the blocked one.
  assert.match(dialog, /const blocked = \(\) => busy\(\) \|\| Boolean\(noteBad\(\)\);/);
  assert.match(dialog, /disabled=\{blocked\(\)\} onClick=\{submit\}/);
});

test('a listing is called a listing, in the form and after it', () => {
  assert.match(dialog, /"This creates a listing at Pokoin's starting price\. Pokoin is not charged automatically; you are paid only if it buys it\."/);
  assert.match(dialog, /"This creates a listing at the buyer's offered price\. They are not charged automatically; you are paid only if they buy it\."/);
  assert.match(dialog, /busy\(\) \? 'Listing…' : `List at \$\{price\(\)\}`/);
  const done = dialog.slice(dialog.indexOf('<Show when={done()}>'));
  assert.match(done, /`Listed at \$\{price\(\)\}\. Pokoin will be notified\.`/);
  assert.match(done, /`Listed at \$\{price\(\)\}\. The buyer will be notified\.`/);
  assert.match(done, /<AppLink class="btn" to="\/mypokoin">See your listings<\/AppLink>/);
  assert.doesNotMatch(done, /Sold|payment received|receipt|email sent/i);
});

test('submit posts once against the target and answers every failure in place', () => {
  // A preview never reaches the network and never asks for sign-in.
  assert.match(dialog, /if \(props\.preview\) \{\s*setDone\(true\);\s*props\.onDone\?\.\(\);\s*return;\s*\}/);
  assert.match(dialog, /if \(!signedIn\(\)\) \{\s*toSignIn\(\);\s*return;\s*\}/);
  assert.match(dialog, /navigate\(authFrom\(props\.fromPath \|\| '\/marketplace'\)\)/);
  // A token that will not be had is the same dead end as being signed out.
  assert.match(dialog, /const token = await getBearer\(\);\n {6}if \(!token\) \{\n {8}toSignIn\(\);/);
  assert.match(dialog, /const text = note\(\);/);
  assert.match(dialog, /await sellToHouse\(\{[\s\S]*quantity: copies\(\),[\s\S]*buyerMessage: text,\n\s*\}, token\)/);
  assert.match(dialog, /await sellIntoBuyOrder\(target\(\)\.orderId, copies\(\), token, text\)/);
  assert.match(dialog, /if \(err\.status === 401\) \{\s*toSignIn\(\);\s*return;\s*\}/);
  // 409: the copies or the price moved. The sentence stays with the form, and
  // the caller reloads so the next attempt carries a fresh limit.
  assert.match(dialog, /setError\(errorMessage\(err\)\);/);
  assert.match(dialog, /if \(err\.status === 409\) props\.onDone\?\.\(\)/);
  assert.match(dialog, /finally \{\s*setBusy\(false\);/);
});

test('the dialog traps focus, closes on Escape and backdrop, and hands focus back', () => {
  assert.match(dialog, /const trigger = document\.activeElement;/);
  assert.match(dialog, /document\.body\.style\.overflow = 'hidden';/);
  assert.match(dialog, /document\.body\.style\.overflow = overflow;/);
  // The container takes the first focus: Tab then starts at the first control.
  assert.match(dialog, /requestAnimationFrame\(\(\) => box\?\.focus\(\)\)/);
  assert.match(dialog, /const FOCUSABLE = 'button:not\(\[disabled\]\)/);
  assert.match(dialog, /if \(event\.key === 'Escape'\) \{\s*if \(busy\(\)\) return;/);
  assert.match(dialog, /if \(event\.shiftKey && here <= 0\) \{[\s\S]*last\.focus\(\);/);
  assert.match(dialog, /if \(!event\.shiftKey && here === items\.length - 1\) \{[\s\S]*first\.focus\(\);/);
  // Outside the box closes it, until a post is in flight. Capture phase, so a
  // press on the scrim is seen before anything can stop it.
  assert.match(dialog, /if \(busy\(\) \|\| box\?\.contains\(event\.target\)\) return;\s*close\(\);/);
  assert.match(dialog, /document\.addEventListener\('pointerdown', onPointer, true\)/);
  // Back to the Sell button that opened it, except on a phone, where the sheet
  // covered that button and the visitor has already moved on.
  assert.match(dialog, /const SHEET_QUERY = '\(max-width: 720px\)';/);
  assert.match(dialog, /if \(!window\.matchMedia\?\.\(SHEET_QUERY\)\.matches\) trigger\?\.focus\?\.\(\);/);
});

test('the BuySell row trigger builds the target and never posts a sale itself', () => {
  assert.match(trigger, /const target = \(\) => sellTarget\(props\.order\);/);
  assert.match(trigger, /if \(!props\.preview && !signedIn\(\)\) \{[\s\S]*navigate\(authFrom\(/);
  // No target, no dialog: an offer that names no order cannot be sold into.
  assert.match(trigger, /if \(!target\(\)\) return;/);
  assert.match(trigger, /<QuickSellDialog\n\s+target=\{target\(\)\}/);
  // Only the board knows a handle, and it hands that to the dialog.
  assert.match(trigger, /buyerName=\{props\.order\?\.buyer_name \|\| props\.order\?\.buyerName \|\| ''\}/);
  assert.doesNotMatch(trigger, /sellToHouse|sellIntoBuyOrder|askOffer|offerPriceLabel/);
  assert.match(trigger, /import QuickSellDialog from '\.\/QuickSellDialog\.jsx'/);
  assert.match(trigger, /import \{ rowThumbSrc \} from '\.\.\/inventory\/RowThumb\.jsx'/);
});

test('Quick Sell reuses the popup surfaces and keeps 40px targets', () => {
  const block = css.slice(css.indexOf('.qs-scrim {'), css.indexOf('.buysell-how {'));
  assert.ok(block.length > 200, 'the qs rules are one block');
  assert.match(block, /\.qs-pop \{[\s\S]*width: min\(26rem, calc\(100vw - 1\.5rem\)\)/);
  // The same bottom sheet as the Define offer popup, at the same width.
  assert.match(block, /@media \(max-width: 720px\) \{\n\s*\.qs-pop \{\n\s*top: auto;/);
  assert.match(block, /\.qs-step \{\n\s*min-width: 40px;\n\s*min-height: 40px;/);
  assert.match(block, /\.qs-close \{\n\s*flex: none;\n\s*width: 40px;\n\s*height: 40px;/);
  // Motion is a courtesy: reduced motion drops the slide-in, nothing else changes.
  assert.match(block, /@media \(prefers-reduced-motion: reduce\) \{\n\s*\.qs-pop \{\n\s*animation: none;/);
});

test('the desk lets the seller change condition, language and finish, and the offer follows', () => {
  assert.match(dialog, /<div class="qs-facet-row" role="radiogroup" aria-label="Condition">/);
  assert.match(dialog, /<div class="qs-facet-row" role="radiogroup" aria-label="Language">/);
  assert.match(dialog, /onClick=\{\(\) => pick\('reverse', !picked\(\)\.reverse\)\}/);
  assert.match(dialog, /onClick=\{\(\) => pick\('firstEdition', !picked\(\)\.firstEdition\)\}/);
  const page = read('../../pages/Card.jsx');
  assert.match(page, /choices=\{sellChoices\(\)\}\s*resolve=\{resolveSell\}/);
  // Each pick is that printing's best buyer offer, never your own, else Pokoin's 1 PKN.
  assert.match(page, /sellableBid\(buy\.book\(\), buy\.mine\(\), facets\) \|\| \{ house: true \}/);
});
