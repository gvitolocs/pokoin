import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const page = fs.readFileSync(new URL('./Card.jsx', import.meta.url), 'utf8');

// The band is the desk's Best Deal now: one strip, label line then price,
// seller line and chips. Every Best Deal assertion slices this far.
const BAND = '<h2 class="shop-label band-title">Best Deal</h2>';

test('desk theme transition is a direct color fade, not a class reset', () => {
  assert.match(page, /const pageTheme = createMemo\(\(\) => deskTheme\(themeCard\(\)\)\)/);
  assert.match(page, /rarityDeskVars\(kind\) \|\| deskThemeVars\(pageTheme\(\)\)/);
  assert.match(page, /root\.classList\.toggle\('desk-rainbow', kind === 'rainbow'\)/);
  // Between cards the tint stays; only leaving the desk clears it.
  const themeEffect = page.slice(page.indexOf('// Desk tint on <html>'), page.indexOf('// Derived desk view.'));
  assert.ok(themeEffect.length > 0);
  assert.doesNotMatch(themeEffect, /classList\.remove\('desk-tinted'\)/);
});

test('desk title, set and artist drag their own bundles without starting a tile drag', () => {
  assert.match(page, /class="species-drag"/);
  assert.match(page, /kind: 'species'/);
  assert.match(page, /kind: 'expansion'/);
  assert.match(page, /kind: 'artist'/);
  assert.match(page, /event\.stopPropagation\(\)/);
  // The drag ghost image is warm before the browser asks for it.
  assert.match(page, /onPointerDown=\{\(\) => preloadDragImage\(setLogo\(\)\)\}/);
  assert.match(page, /onPointerDown=\{\(\) => preloadDragImage\(artistCover\(\)\)\}/);
});

test('a desk not painted from a peek shows the stored copy and merges the revalidated page', () => {
  assert.match(page, /fresh: Boolean\(cached\),\n\s+onUpdate: showCard,/);
  assert.match(page, /fetchVersionSet\(cardId, \{ onUpdate: showVersionSet \}\)\.then\(showVersionSet\)/);
  // Listings stay live: never a stored copy.
  assert.match(page, /fetchListings\(cardId, \{ fresh: true, maxAgeMs \}\)/);
  assert.match(page, /includeOffers: false/);
});

test('the desk language list follows the printing nationality', () => {
  assert.match(page, /languagesForNationality/);
});

test('the gold sparkles swap the desk scan to the verified reverse holo and back', () => {
  assert.match(page, /const reverseScan = createMemo\(\(\) => reverseScanUrl\(card\(\)\)\)/);
  // The toggle is keyed by card id: the next desk opens on its regular scan.
  assert.match(page, /reverseFor\(\) === String\(card\(\)\.id\)/);
  assert.match(page, /const heroArt = createMemo\(\(\) => \(reverseOn\(\) \? reverseScan\(\) : art\(\)\)\)/);
  assert.match(page, /<DeskArtFrame\n\s+card=\{card\(\)\}\n\s+art=\{heroArt\(\)\}/);
  // Shown only for printings that have one, next to the expansion marks.
  const row = page.slice(page.indexOf('class="version-shortcuts"'), page.indexOf('More versions...'));
  assert.match(row, /<Show when=\{reverseScan\(\)\}>\s*<button\s+type="button"\s+class=\{\['set-shortcut', 'reverse-toggle'/);
  assert.match(row, /aria-pressed=\{reverseOn\(\) \? 'true' : 'false'\}/);
  assert.match(row, /<ReverseSparkles \/>/);
  // SEO and drags keep the regular printing's scan.
  assert.match(page, /image=\{art\(\)\}/);
});

test('Best Deal shows no seller line for Vault stock and names every other seller', () => {
  const deal = page.slice(page.indexOf(BAND), page.indexOf('class="deal-facets"'));
  assert.match(deal, /when=\{!isVaultOffer\(dealPick\(\)\)\}/);
  assert.doesNotMatch(deal, /Available in the Vault|VAULT_DEAL_LINE|is-vault/);
  assert.doesNotMatch(deal, /<Show\s+when=\{!isVaultOffer\(dealPick\(\)\)\}\s+fallback=/);
  // Ordinary sellers keep "Sold by" and their shop link.
  assert.match(deal, /Sold by\{' '\}/);
  assert.match(deal, /sellerHref\(dealPick\(\), lang\)/);
});

test('Best Deal goes price, seller line, then the chips: no grade · language text line', () => {
  const deal = page.slice(page.indexOf(BAND), page.indexOf('class="deal-facets"'));
  assert.ok(deal.includes('deal-sold-by'));
  assert.doesNotMatch(page, /deal-what/);
  assert.doesNotMatch(deal, /languageName|conditionLabel/);
});

test('Best Deal flips its two-line price: local currency large, PKN small; nothing else flips', () => {
  const deal = page.slice(page.indexOf(BAND), page.indexOf('class="deal-facets"'));
  assert.match(deal, /<PriceStack flip parts=\{buyerParts\(dealPick\(\)\?\.pricePkn/);
  const stack = fs.readFileSync(new URL('../components/PriceStack.jsx', import.meta.url), 'utf8');
  assert.match(stack, /stackOrder\(props\.parts, props\.flip\)/);
  for (const file of ['../components/CardTile.jsx', '../components/desk/ShopListing.jsx']) {
    assert.doesNotMatch(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), /<PriceStack[^>]*\bflip\b/);
  }
});

test('Best Deal is one horizontal band: label and marketplace links above, price, chips, then the buy side', () => {
  const band = page.slice(page.indexOf('class="panel add-panel desk-band"'), page.indexOf('<CheapestListings'));
  assert.ok(band.length > 200, 'the band is a section of its own');
  // The compact label line keeps the SilverHead link, not a button row.
  assert.match(band, /<div class="band-head">\s*<h2 class="shop-label band-title">Best Deal<\/h2>\s*<SilverHead card=\{card\(\)\} fromPath=\{fromPath\(\)\} \/>/);
  // One wrapped row: price stack, chips, and the offer bar beside Add to cart.
  assert.match(band, /<div class="band-main">\s*<div class="band-price">/);
  assert.ok(band.indexOf('class="band-price"') < band.indexOf('class="deal-facets"'), 'price before chips');
  assert.ok(band.indexOf('class="deal-facets"') < band.indexOf('class="band-actions"'), 'chips before the buy side');
  const actions = band.slice(band.indexOf('class="band-actions"'));
  assert.ok(actions.indexOf('<OfferBar') < actions.indexOf('class="btn buy-btn"'), 'the offer bar sits left of Add to cart');
  // With no Pokoin seller the price slot says so and the buy side stays.
  assert.match(band, /<p class="deal-none">No Pokoin seller has this card right now\.<\/p>/);
  assert.match(band, /when=\{!offersReady\(\) \|\| canBuy\(\)\}/);
  assert.doesNotMatch(band, /hero-deal|deal-actions|deal-book/);
});

test('the offer bar sits above Add to cart and its settings open in a body portal popup', () => {
  assert.match(page, /<OfferBar[\s\S]*above=\{canBuy\(\)\}/);
  const bar = fs.readFileSync(new URL('../components/desk/OfferBar.jsx', import.meta.url), 'utf8');
  assert.match(bar, /aria-label="Define offer"\s+title="Define offer"\s+aria-haspopup="dialog"/);
  assert.match(bar, /<h3 class="offer-open-head">Define offer<\/h3>/);
  assert.match(bar, /role="dialog"\s+aria-label="Define offer"/);
  assert.match(bar, /Change it in Define offer\./);
  assert.doesNotMatch(bar, /Offer settings|in the settings/);
  assert.match(bar, /<Portal mount=\{document\.body\}>/);
  assert.match(bar, /event\.key === 'Escape'/);
  assert.match(bar, /pointerdown/);
  assert.match(bar, /gear\?\.focus\(\)/);
  // The settings form is in the popup only: nothing expands inside the panel.
  assert.doesNotMatch(bar, /offer-open"/);
  // Prices go through the listing form's conversion helpers, not a second one.
  assert.match(bar, /offerPricePkn\(price\(\), cur\(\)\)/);
});

test('the Shop panel starts with the column-header filters and keeps an accessible name', () => {
  const shop = page.slice(page.indexOf('class="panel shop-panel shop-terminal"'), page.indexOf('<ShopList offers={split().shop}'));
  assert.match(shop, /aria-label="Shop"/);
  assert.match(shop, /<h2 class="sr-only">Shop<\/h2>/);
  assert.doesNotMatch(shop, /<select/);
  assert.match(shop, /<Show when=\{split\(\)\.shop\.length \|\| condition\(\) \|\| language\(\)\}>\s*<ShopHeader/);
  // The header drives the same state the three selects drove.
  assert.match(shop, /onCondition=\{setCondition\}/);
  assert.match(shop, /onLanguage=\{setLanguage\}/);
  assert.match(shop, /onSort=\{setOfferSort\}/);
  // Filters that hide every row keep the header and offer a way out.
  assert.match(shop, /No listings match these filters\./);
  assert.match(shop, /Clear filters/);
  assert.match(shop, /No Pokoin listings for this card yet\./);
});

test('an empty Vault is not a panel at any width: the row is conditional markup', () => {
  // Replaces the phone-only CSS hide: the desk's optional rows auto-place, so a
  // rendered-but-empty Vault would cost a bordered box and a gap.
  assert.match(page, /<Show when=\{split\(\)\.vault\.length\}>\s*<section class="panel shop-panel vault-panel">/);
  assert.doesNotMatch(page, /'is-empty': !split\(\)\.vault\.length/);
  assert.match(page, /<h2 class="shop-label vault-title">\s*<Ico name="vault" \/>\s*<span>Vault<\/span>\s*<\/h2>/);
  assert.match(page, /import ShopHeader, \{ Ico \} from '..\/components\/desk\/ShopHeader\.jsx'/);
  // The Seller label in the Shop header uses the same class.
  const header = fs.readFileSync(new URL('../components/desk/ShopHeader.jsx', import.meta.url), 'utf8');
  assert.match(header, /shop-hseller shop-label/);
});

test('the desk loads one buy book and hands it to the bar and the Buy offers cell', () => {
  assert.match(page, /const buy = createBuyBook\(\{ cardId, ready: offersReady, language: shownLang \}\)/);
  assert.match(page, /<OfferBar\n\s*buy=\{buy\}/);
  assert.match(page, /<BuyOffers\n\s*buy=\{buy\}/);
  // The bar reads the book itself; only the cells need to know the listings landed.
  const barProps = page.match(/<OfferBar\n[\s\S]*?\n\s*\/>/)[0];
  assert.doesNotMatch(barProps, /ready=\{offersReady\(\)\}/);
  assert.match(page, /<CheapestListings\n[\s\S]*ready=\{offersReady\(\)\}/);
  assert.doesNotMatch(page, /fetchBuyBook/);
  // The bar owns the only Sell now form: the rows ask it for a grade, they do not grow one.
  const lib = fs.readFileSync(new URL('../lib/buy-book.js', import.meta.url), 'utf8');
  assert.match(lib, /pickSell\(condition\) \{\s*setSellPick\(condition \|\| ''\);\s*\}/);
  // An empty Buy offers cell names no condition, so it asks for the popup alone.
  assert.match(lib, /askOffer\(\) \{\s*setOfferAsk\(offerAsk\(\) \+ 1\);\s*\}/);
  const bar = fs.readFileSync(new URL('../components/desk/OfferBar.jsx', import.meta.url), 'utf8');
  assert.match(bar, /createEffect\(buy\.sellPick, \(condition\) => \{/);
  assert.match(bar, /setSetting\('condition', condition\);\s*openPopup\(\)/);
  assert.match(bar, /createEffect\(buy\.offerAsk, \(ask\) => \{\s*if \(!ask\) return;\s*openPopup\(\);/);
  assert.doesNotMatch(bar, /fetchBuyBook/);
});

test('the two listing cells are the third desk row, capped by the viewport and wired to the Shop', () => {
  assert.ok(!fs.existsSync(new URL('../components/deal/DealBook.jsx', import.meta.url)), 'the measured book is gone');
  const cheap = page.slice(page.indexOf('<CheapestListings'), page.indexOf('<BuyOffers'));
  const offers = page.slice(page.indexOf('<BuyOffers'), page.indexOf('own stock gets its own row'));
  assert.ok(cheap.length > 40 && offers.length > 40);
  assert.ok(page.indexOf('<CheapestListings') < page.indexOf('<BuyOffers'), 'listings first, then offers');
  // Both read the desk's own listings and the one book; neither fetches.
  assert.match(cheap, /rows=\{nativeLive\(\)\}/);
  assert.match(cheap, /marketPrice=\{salesSeries\(\)\?\.lastMedianPkn\}/);
  assert.match(cheap, /onCart=\{addListingToCart\}/);
  for (const block of [cheap, offers]) {
    assert.match(block, /max=\{deskRows\(\)\}/);
    assert.doesNotMatch(block, /fetch/i);
  }
  assert.match(offers, /condition=\{shownCond\(\)\}/);
  assert.match(offers, /language=\{shownLang\(\)\}/);

  // The cap is a viewport count, not a CSS hide, so See all counts what is cut.
  assert.match(page, /const deskRows = \(\) => dealBookRows\(deskWidth\(\)\)/);
  assert.match(page, /window\.addEventListener\('resize', onResize, \{ passive: true \}\)/);
  assert.match(page, /import \{ buyOfferSellable, dealBookRows \} from '@market\/deal-book\.js'/);
  // The chips are the desk's one selection: every one can be pressed, a pressed
  // one is kept even with nothing listed, and the sold graph plots what they pick.
  assert.doesNotMatch(page, /class=\{\['deal-chip'[^\n]*\n(?:[^\n]*\n){0,6}[^\n]*disabled=\{dim\(\)\}/);
  assert.match(page, /if \(condPinned\(\)\) return wanted;/);
  assert.match(page, /createEffect\(\(\) => \[shownCond\(\), shownLang\(\), dealReverse\(\)\]/);
  assert.match(page, /class=\{\['deal-chip', 'deal-chip-reverse', \{ 'is-on': dealReverse\(\) \}\]\}/);
  assert.match(page, /linkedLabel=\{graphScope\(\)\}/);
  const graph = fs.readFileSync(new URL('../components/desk/SoldPriceGraph.jsx', import.meta.url), 'utf8');
  assert.match(graph, /<Show when=\{!props\.linkedLabel\}>\s*<SoldGraphFilter/);
  // The sell strip is the same one line signed in or out; the form opens from it.
  assert.match(page, /sellNowNote=\{sellNowNote\(\)\}/);
  assert.match(page, /onSellNow=\{sellNowRow\(\) \? \(\) => buy\.pickSell\(shownCond\(\)\) : undefined\}/);
  const form = fs.readFileSync(new URL('../components/desk/ListingForm.jsx', import.meta.url), 'utf8');
  assert.match(form, /const collapsed = \(\) => !isEditing\(\) && !opened\(\);/);
  assert.match(form, /onClick=\{\(\) => setOpened\(false\)\}/);

  // Rows, price, quantity and cart are the Shop's own components.
  const rows = fs.readFileSync(new URL('../components/deal/CheapestListings.jsx', import.meta.url), 'utf8');
  assert.match(rows, /import ShopListingRow from '..\/desk\/ShopListing\.jsx'/);
  assert.match(rows, /cheapestRows\(\{ rows: props\.rows, max: props\.max \}\)/);
  assert.match(rows, /seeAllListings\(\{ rows: props\.rows, shown: rows\(\) \}\)/);
  assert.match(rows, /<ShopListingRow[\s\S]*compact[\s\S]*showCard=\{false\}/);
  assert.match(rows, /See all \$\{count\(\)\} listings/);
  assert.match(rows, /aria-expanded=\{props\.open \? 'true' : 'false'\}/);
  assert.match(rows, /No listings yet\./);
  // See all lives in the one-line title, not in a footer row under the rows.
  assert.match(rows, /<h2 class="cell-title">[\s\S]*cell-more[\s\S]*<\/h2>/);
  assert.doesNotMatch(rows.slice(rows.indexOf('</h2>')), /cell-more/);

  const cells = fs.readFileSync(new URL('../components/deal/BuyOffers.jsx', import.meta.url), 'utf8');
  assert.match(cells, /buyOfferRows\(book\(\), \{ language: props\.language, max: props\.max \}\)/);
  assert.match(cells, /props\.buy\.pickSell\(row\.condition\)/);
  // Never an empty hole: no offers is one line that opens the Define offer popup.
  assert.match(cells, /No buy offers yet/);
  assert.match(cells, /props\.buy\.askOffer\(\)/);
  // A book that failed to load paints nothing, exactly like the bar.
  assert.match(cells, /<Show when=\{Array\.isArray\(book\(\)\)\}>/);
});

test("See all opens the full Shop in place, as the desk's last row", () => {
  assert.match(page, /const \[shopOpen, setShopOpen\] = createSignal\(false\)/);
  assert.match(page, /<Show when=\{shopOpen\(\)\}>\s*<section class="panel shop-panel shop-terminal"/);
  assert.match(page, /onSeeAll=\{scrollShop\}/);
  assert.match(page, /<CheapestListings[\s\S]*open=\{shopOpen\(\)\}/);
  const scroll = page.match(/function scrollShop\(\) \{[\s\S]*?\n  \}/)[0];
  assert.match(scroll, /const open = !shopOpen\(\);/);
  assert.match(scroll, /setShopOpen\(open\)/);
  // Collapsing must not scroll to a panel that is being removed.
  assert.match(scroll, /if \(!open\) return;/);
  assert.match(scroll, /document\.querySelector\('\.card-desk \.shop-terminal'\)/);
  assert.match(scroll, /scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/);
  assert.match(scroll, /querySelector\('\.shop-header'\)\?\.focus\(\)/);
});
