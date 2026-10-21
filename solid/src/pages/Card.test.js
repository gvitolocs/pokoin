import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const page = fs.readFileSync(new URL('./Card.jsx', import.meta.url), 'utf8');

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

test('Best Deal says "Available in the Vault" for Vault stock and names every other seller', () => {
  const deal = page.slice(page.indexOf('<h2>Best Deal</h2>'), page.indexOf('class="deal-what"'));
  assert.match(deal, /when=\{!isVaultOffer\(dealPick\(\)\)\}/);
  assert.match(deal, /fallback=\{<p class="deal-sold-by is-vault">\{VAULT_DEAL_LINE\}<\/p>\}/);
  // Ordinary sellers keep "Sold by" and their shop link.
  assert.match(deal, /Sold by\{' '\}/);
  assert.match(deal, /sellerHref\(dealPick\(\), lang\)/);
});
