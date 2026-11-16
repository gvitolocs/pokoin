import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync(new URL('./BuySell.jsx', import.meta.url), 'utf8');
const fixture = fs.readFileSync(new URL('./buysell-preview-fixture.js', import.meta.url), 'utf8');
const sellForm = fs.readFileSync(new URL('../components/buysell/SellNowForm.jsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../../../market/src/styles.css', import.meta.url), 'utf8');

// One component each: an assertion about the Seek board cannot be met by the history list.
const between = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
const shared = between('function ownOfferActions', 'function OwnOfferButtons');
const buttons = between('function OwnOfferButtons', 'function Seek');
const seek = between('function Seek', 'function OfferEditor');
const history = between('function History', 'function Offer(props)');
const offer = between('function Offer(props)', 'export default function BuySell');
const page = src.slice(src.indexOf('export default function BuySell'));
const facts = between('function OfferFacts', 'function CardPageLink');
const left = between('function timeLeft', 'function OfferFacets');
const title = between('function OfferTitle', 'function OfferFacts');

test('the Seek board marks the rows the signed-in caller posted themselves', () => {
  // The open ids come from /mine, asked once, only after Auth settles a signed-in visitor.
  assert.match(seek, /createSignal\(props\.preview \? new Set\(previewOwnIds\(\)\) : new Set\(\)\)/);
  assert.match(seek, /createEffect\(\(\) => signedIn\(\), \(ready\) => \{/);
  assert.match(seek, /if \(props\.preview \|\| ownAsked \|\| !ready\) return;/);
  assert.match(seek, /ownAsked = true;\n\s*markOwnOffers\(\);/);
  assert.match(seek, /setOwnIds\(openBuyOrderIds\(\(await fetchMyBuyOrders\(await getBearer\(\)\)\)\?\.items\)\)/);
  assert.match(seek, /const isOwn = \(item\) => ownIds\(\)\.has\(String\(item\.id\)\);/);
  // A read that fails costs the marking only: the board still paints and no banner claims a break.
  const mark = seek.slice(seek.indexOf('async function markOwnOffers'), seek.indexOf('createEffect(() => signedIn'));
  assert.match(mark, /\} catch \(_\) \{/);
  assert.doesNotMatch(mark, /setError/);
  // The tag on a marked row, and the preview row that shows it without signing in.
  assert.match(seek, /<span class="buysell-own">Your offer<\/span>/);
  assert.match(fixture, /export function previewOwnIds\(\) \{\n\s*return \[WANTED\[0\]\.id\];/);
});

test('a marked board row gets Edit and Delete and never Sell now', () => {
  assert.match(seek, /<Show when=\{!isOwn\(item\)\}>/);
  assert.match(seek, /<Show when=\{isOwn\(item\)\}>\s*<OwnOfferButtons order=\{item\} actions=\{own\} \/>/);
  // Sell now is the other buyers' branch, and the board builds it in exactly one place.
  assert.equal((seek.match(/<SellNowForm/g) || []).length, 1);
  assert.doesNotMatch(buttons, /Sell now/);
  // The card page stays for your own row too, now as the row's icon link.
  assert.match(seek, /<CardPageLink cardId=\{item\.card_id\} \/>/);
  assert.match(title, /<AppLink to=\{cardPath\(item\(\)\.card_id\)\}><strong>/);
  // Edit and Delete are icon buttons: the words live in title and aria-label, not in the row.
  assert.match(buttons, /title="Edit offer" aria-label="Edit offer" onClick=\{\(\) => props\.actions\.toggle\(props\.order\)\}>\s*<PencilGlyph \/>/);
  assert.match(buttons, /title="Delete offer"\s*aria-label="Delete offer"\s*disabled=\{props\.actions\.isBusy\(props\.order\)\}/);
  assert.match(buttons, /onClick=\{\(\) => props\.actions\.remove\(props\.order\)\}\s*>\s*<BinGlyph \/>/);
  assert.doesNotMatch(buttons, />Edit<|>Delete offer</);
  // A delete takes the row out of the loaded pages instead of fetching the board again.
  const deleted = seek.slice(seek.indexOf('onDeleted:'), seek.indexOf('// The PATCH answer'));
  assert.match(deleted, /setItems\(\(rows\) => \(rows \|\| \[\]\)\.filter\(\(row\) => String\(row\.id\) !== String\(order\.id\)\)\)/);
  assert.doesNotMatch(deleted, /load\(/);
  // The editor is the My offers one, and a failed write lands in the board's own Alert.
  assert.match(seek, /<OfferEditor\n\s+order=\{item\}/);
  assert.match(seek, /onError: setError,/);
  // The two buttons are the shared piece, with the shared confirm and DELETE.
  assert.match(shared, /window\.confirm\('Delete this offer\?'\)/);
  assert.match(shared, /await cancelBuyOrder\(order\.id, await getBearer\(\)\)/);
});

test('My offers deletes through the same actions, under the Delete offer name', () => {
  assert.match(history, /const own = ownOfferActions\(\{/);
  assert.match(history, /<OwnOfferButtons order=\{order\} actions=\{own\} \/>/);
  assert.match(history, /onDeleted: \(\) => load\(\),/);
  // No second copy of the editor state or the delete request in the history panel.
  assert.doesNotMatch(history, /const \[editing|const \[busyId|window\.confirm|cancelBuyOrder|setBusyId/);
  assert.doesNotMatch(src, /Cancel offer|Cancel this offer/);
});

test('a signed-out visitor still gets the plain public board', () => {
  // Nothing is asked and nothing is marked: the row set starts empty, so every row is somebody else's.
  assert.match(seek, /: new Set\(\)\)/);
  assert.doesNotMatch(seek, /signedIn\(\)\s*\?/);
  // The public board read and its Sell now button are untouched.
  assert.match(seek, /await fetchBuyBoard\(\{ limit: BOARD_PAGE, sort: sort\(\), before: reset \? '' : next\(\) \}\)/);
  assert.match(seek, /<SellNowForm order=\{item\} preview=\{props\.preview\} onDone=\{\(\) => load\(true\)\} \/>/);
});

test('the page is two doors, Seek first, and the tab strip is gone', () => {
  assert.match(seek, /<section class="buysell-panel is-seek" aria-labelledby="buysell-seek-title">/);
  assert.match(seek, /<h2 class="buysell-panel-title" id="buysell-seek-title"><SearchGlyph size=\{19\} \/>Seek<\/h2>/);
  assert.match(offer, /<section class="buysell-panel is-offer" ref=\{\(el\) => \{ panel = el; \}\} aria-labelledby="buysell-offer-title">/);
  assert.match(offer, /<h2 class="buysell-panel-title" id="buysell-offer-title"><BoxGlyph size=\{19\} \/>Offer<\/h2>/);
  // Both doors are built by the page, in the order a phone stacks them.
  assert.match(page, /<div class="buysell-panels">\s*<Seek\n\s+preview=\{preview\}/);
  assert.ok(src.indexOf('<Seek') < src.indexOf('<Offer preview='));
  assert.match(page, /<Offer preview=\{preview\} fromPath=\{here\(\)\} focus=\{\(\) => params\.tab === 'sell'\} \/>/);
  // No tab widget anywhere: the doors are named, not switched.
  assert.doesNotMatch(src, /role="tablist"|role="tab"|aria-selected|buysell-tabs/);
  assert.doesNotMatch(css, /\.buysell-tabs/);
});

test('the explainer sits behind one info button and is not painted on the body', () => {
  assert.match(page, /aria-expanded=\{about\(\) \? 'true' : 'false'\}/);
  assert.match(page, /aria-controls="buysell-about-pop"/);
  assert.match(page, /title="How CardGTS works"\s*aria-label="How CardGTS works"/);
  assert.match(page, /<InfoGlyph size=\{19\} \/>/);
  // Keyboard reachable and dismissible like every other popup on the site.
  assert.match(page, /dismissWhileOpen\(about, \(\) => aboutBox, \(\) => setAbout\(false\)\)/);
  // The three steps and the small print are the popover's content, in order.
  const pop = page.slice(page.indexOf('<Show when={about()}>'), page.indexOf('<div class="buysell-panels">'));
  assert.match(pop, /<ol class="buysell-how">\s*<For each=\{ABOUT_STEPS\}>\{\(step\) => <li>\{step\}<\/li>\}<\/For>\s*<\/ol>/);
  assert.match(pop, /<p class="buysell-fine">\{FINE_PRINT\}<\/p>/);
  const steps = src.slice(src.indexOf('const ABOUT_STEPS = ['), src.indexOf('const FINE_PRINT'));
  assert.equal((steps.match(/'[^']*'/g) || []).length, 3);
  assert.match(src, /const FINE_PRINT = 'Offers are not binding and no money is taken until you buy\.';/);
  // The subtitle stays the only prose the page shows by itself.
  assert.match(page, /lede="Say what you will pay for a card\. Anyone who has it can sell it to you\."/);
  const body = page.slice(page.indexOf('<div class="buysell-panels">'));
  assert.doesNotMatch(body, /buysell-fine|buysell-how|Offers are not binding/);
});

test('your own open offers lead the Seek board', () => {
  assert.match(seek, /const ordered = createMemo\(\(\) => \{/);
  assert.match(seek, /if \(!ownIds\(\)\.size\) return list;/);
  assert.match(seek, /for \(const row of list\) \(isOwn\(row\) \? mine : others\)\.push\(row\);/);
  assert.match(seek, /return \[\.\.\.mine, \.\.\.others\];/);
  // The rendered list is the ordered one, so the marked rows are on top with their Edit and Delete.
  assert.match(seek, /<For each=\{ordered\(\)\}>/);
  assert.doesNotMatch(seek, /<For each=\{items\(\)\}>/);
});

test('a row is a name, a set line, then icon facts', () => {
  // Second line carries the set and the number, nothing else.
  assert.match(title, /\{\[item\(\)\.set_name, item\(\)\.collector_number \? `#\$\{item\(\)\.collector_number\}` : ''\]\.filter\(Boolean\)/);
  assert.match(facts, /<span class="buysell-fact" title=\{`\$\{item\(\)\.remaining\} still wanted`\}>\s*<CopiesGlyph \/>×\{item\(\)\.remaining\}/);
  assert.match(facts, /<span class="buysell-fact" title=\{left\(\)\.title\}>\s*<ClockGlyph \/>\{left\(\)\.value\}/);
  assert.match(facts, /<span class="buysell-fact" title="Buyer">\s*<BuyerGlyph \/>\{item\(\)\.buyer_name\}/);
  // The Offer door adds the caller's own listing price to the same line.
  assert.match(facts, /<TagGlyph \/>\{formatPknNumber\(item\(\)\.my_price_pkn\)\}/);
  // The old sentence is gone from both doors.
  assert.doesNotMatch(seek, /wanted ·|days left|expiryLabel\(/);
  assert.doesNotMatch(offer, /wanted ·|days left/);
  // The condition chip and the language flag stay the shared pieces they were.
  assert.match(between('function OfferFacets', 'function OfferTitle'), /<img class="shop-cond" src=\{conditionChipSrc\(item\(\)\.condition\)\}/);
  assert.match(between('function OfferFacets', 'function OfferTitle'), /<img class="deal-flag" src=\{flagSrc\(String\(item\(\)\.language \|\| ''\)\)\}/);
});

test('time left reads as 27d or 5h and keeps the full date in its title', () => {
  assert.match(left, /const date = new Date\(at\)\.toLocaleDateString\(undefined, \{ day: 'numeric', month: 'short', year: 'numeric' \}\)/);
  assert.match(left, /if \(left <= 0\) return \{ value: 'Ended', title: `Expired \$\{date\}` \};/);
  assert.match(left, /if \(left >= DAY_MS\) return \{ value: `\$\{Math\.floor\(left \/ DAY_MS\)\}d`, title: `Until \$\{date\}` \};/);
  assert.match(left, /if \(left >= HOUR_MS\) return \{ value: `\$\{Math\.floor\(left \/ HOUR_MS\)\}h`, title: `Until \$\{date\}` \};/);
  assert.match(left, /return \{ value: '<1h', title: `Until \$\{date\}` \};/);
  // An order with no expiry says so instead of printing a bogus countdown.
  assert.match(left, /if \(!Number\.isFinite\(at\)\) return \{ value: 'No end', title: 'Until cancelled' \};/);
});

test('signed out, the Offer door asks once and never calls the API', () => {
  assert.match(offer, /createEffect\(\(\) => \(props\.preview \|\| signedIn\(\)\), \(ready\) => \{ if \(ready\) load\(\); \}\);/);
  assert.match(offer, /<Show when=\{props\.preview \|\| signedIn\(\)\}>/);
  assert.match(offer, /<Show when=\{!props\.preview && !signedIn\(\)\}>/);
  assert.match(offer, /<p class="buysell-ask">Sign in to see the offers that match your listings\.<\/p>/);
  assert.match(offer, /<AuthLink class="btn" to=\{authFrom\(props\.fromPath\)\}>Sign in<\/AuthLink>/);
  // One sentence, and no rows or empty state behind it.
  assert.equal((offer.match(/class="buysell-ask"/g) || []).length, 1);
  assert.ok(offer.indexOf('props.preview || signedIn()') < offer.indexOf('buysell-ask'));
  assert.doesNotMatch(seek, /Sign in/);
});

test('the history opens on the Seek head and tab=sell lands on the Offer door', () => {
  assert.match(page, /const historyOpen = \(\) => params\.tab === 'mine';/);
  assert.match(page, /onHistory=\{\(\) => setParams\(\{ tab: historyOpen\(\) \? undefined : 'mine' \}\)\}/);
  // The icon button that opens it says so, and reads as pressed while the history is up.
  assert.match(seek, /aria-pressed=\{props\.historyOpen\(\) \? 'true' : 'false'\}/);
  assert.match(seek, /title="My offers"\s*aria-label="My offers"\s*onClick=\{props\.onHistory\}/);
  assert.match(seek, /<ListGlyph \/>/);
  // `?tab=mine` still shows the list, behind a sign-in for a real visitor and from the fixture in preview.
  assert.match(page, /<Show when=\{historyOpen\(\)\}>/);
  assert.match(page, /fallback=\{<RequireSignIn from=\{here\(\)\}><History onClose=\{\(\) => setParams\(\{ tab: undefined \}\)\} \/><\/RequireSignIn>\}/);
  assert.match(page, /<History preview onClose=\{\(\) => setParams\(\{ tab: undefined \}\)\} \/>/);
  assert.match(history, /<h2 class="buysell-panel-title" id="buysell-history-title"><ListGlyph size=\{19\} \/>My offers<\/h2>/);
  // Opening it brings the panel to the top of the screen instead of leaving it under the doors.
  assert.match(history, /<section class="buysell-panel buysell-history" ref=\{\(el\) => \{ panel = el; \}\}/);
  assert.match(history, /requestAnimationFrame\(\(\) => panel\?\.scrollIntoView\(\{ block: 'start', behavior: 'smooth' \}\)\)/);
  assert.match(history, /title="Close My offers" aria-label="Close My offers" onClick=\{props\.onClose\}/);
  assert.match(history, /<CloseGlyph \/>/);
  // `?tab=sell` scrolls to the Offer door, once, and nothing else changes.
  assert.match(page, /focus=\{\(\) => params\.tab === 'sell'\}/);
  assert.match(offer, /createEffect\(props\.focus, \(onSell\) => \{/);
  assert.match(offer, /if \(!onSell \|\| scrolled\) return;/);
  assert.match(offer, /requestAnimationFrame\(\(\) => panel\?\.scrollIntoView\(\{ block: 'nearest', behavior: 'smooth' \}\)\)/);
});

test('every icon action is a 36px target with a visible ring', () => {
  assert.match(css, /\.buysell-act \{[^}]*width: 36px;[^}]*height: 36px;/);
  assert.match(css, /\.buysell-act:focus-visible \{[^}]*outline: 2px solid var\(--yellow\);[^}]*outline-offset: 2px;/);
  assert.match(css, /\.buysell-act\[aria-pressed="true"\]/);
  assert.match(css, /\.buysell-act:disabled \{[^}]*color: var\(--muted\);[^}]*cursor: default;/);
  // The card page link reuses the same box, so it is not a smaller tap target.
  assert.match(src, /<AppLink class="buysell-act" to=\{cardPath\(props\.cardId\)\} title="Card page" aria-label="Card page">\s*<OpenGlyph \/>\s*<\/AppLink>/);
  // Two doors side by side, stacked on a phone.
  assert.match(css, /\.buysell-panels \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 900px\) \{\n\s*\.buysell-panels \{\n\s*grid-template-columns: 1fr;/);
});

test('the Sell action keeps its word and the two-arrow mark, and its dialog is untouched', () => {
  assert.match(sellForm, /<BuySellIcon class="sell-now-ico" size="0\.95em" \/>\s*Sell\s*<\/button>/);
  // Same target, same dialog, same sign-in hop: only the button's face changed.
  assert.match(sellForm, /const target = \(\) => sellTarget\(props\.order\);/);
  assert.match(sellForm, /<QuickSellDialog\n\s+target=\{target\(\)\}/);
  assert.match(css, /\.sell-now-btn \.buysell-ico \{[^}]*margin-right: 0\.35rem;/);
  // The board sells into a row with its own order id, and the Offer door sends the dialog back here.
  assert.match(offer, /<SellNowForm order=\{item\} fromPath="\/cardgts\?tab=sell" preview=\{props\.preview\} onDone=\{load\} \/>/);
});

test('preview mode still paints both doors and the board pages with Load more', () => {
  assert.match(seek, /props\.preview\s*\?\s*previewBoard\(sort\(\)\)/);
  assert.match(offer, /props\.preview \? previewForMyListings\(\)/);
  assert.match(history, /props\.preview \? previewMine\(\)/);
  assert.match(page, /<Show when=\{preview\}><p class="seller-preview-banner" role="status">\{BUYSELL_PREVIEW_BANNER\}<\/p><\/Show>/);
  assert.match(seek, /<Show when=\{next\(\)\}>[\s\S]*onClick=\{\(\) => load\(false\)\}/);
  assert.match(seek, /<Show when=\{items\(\)\?\.length\}>/);
});
