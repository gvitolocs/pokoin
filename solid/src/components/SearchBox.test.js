import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const box = read('./SearchBox.jsx');
const toggles = read('./SearchToggles.jsx');

test('the header ranks locally from the first keystrokes; the network pool only hydrates', () => {
  assert.match(box, /Progressive network pool/);
  assert.match(box, /progressive: true/);
  assert.match(box, /live\.paintCatalogGroups\(text, \{\s*printLang: rankPrint\(\), searchLang: searchLang\(\), kind: catalogTab\(\), limit,\s*\}\)/);
  assert.match(box, /suggestLiveReady/);
  assert.match(box, /fetchSearch,/);
  assert.match(box, /live\.catalogIntent\(text\)/);
  assert.match(box, /fetchArtist/);
  assert.match(box, /liveTick\(\)/);
  assert.match(box, /<SearchTabs/);
  assert.match(box, /searchTab\(\)/);
  assert.equal(box.includes('fetchSuggestRanked'), false);
  assert.equal(box.includes('setGroups(liveSuggestGroups'), false);
  assert.equal(box.includes('suggest-pending'), false);
  assert.equal(/term\(\)\.length < 2|term\.length < 2/.test(box), false);
});

test('View-all count prefers the payload total, keeps the suggest baseline', () => {
  assert.doesNotMatch(box, /setHitCount\(count\)/);
  assert.doesNotMatch(box, /count:\s*hitCount/);
  // Exact totals override; the suggest estimate survives where the payload has none.
  assert.match(box, /const total = Number\(payload\?\.total\);/);
  assert.match(box, /Number\.isFinite\(total\) && total > 0/);
  assert.match(box, /setHitCount\(Number\(page\?\.count\) \|\| 0\)/);
});

test('suggest rows: two columns, no Singles cell, set mark, collector and translation', () => {
  assert.equal(box.includes('suggest-kind'), false);
  assert.equal(box.includes('suggest-meta'), false);
  assert.match(box, /data-suggest-id/);
  assert.match(box, /identity\(\)\.suggestExpansionShort/);
  assert.match(box, /<ExpansionMark/);
  assert.match(box, /symbolUrl=\{card\(\)\.expansionSymbolUrl\}/);
  assert.match(box, /class="suggest-translated"/);
  assert.match(box, /suggestTranslatedLine/);
  assert.match(box, /suggestCardName/);
  assert.match(box, /class="suggest-number"/);
  assert.match(box, /clipSuggestCollector/);
  assert.match(box, /class="set-shortcut is-on"/);
});

test('titles are fitted before FLIP measures the rows', () => {
  assert.match(box, /fitSuggestTitles\(list\);\s*flip\.update\(list\);/);
});

test('LEGEND/BREAK art is the full card rotated; full-bleed art skips the window crop', () => {
  assert.match(box, /resolveArtLayout/);
  assert.match(box, /artLayout\(\) === 'landscape'/);
  assert.match(box, /'is-landscape': landscapePrint\(\)/);
  assert.match(box, /'is-bleed'/);
  assert.match(box, /cut=\{artLayout\(\) === 'window' \|\| artLayout\(\) === 'halfart'\}/);
});

test('desktop suggest hover shows the leftover JPEG beside the panel', () => {
  assert.match(box, /<Portal mount=\{document\.body\}>/);
  assert.match(box, /class="suggest-hover"/);
  assert.match(box, /<CardArt src=\{hoverSrc\(\)\} full=\{Boolean\(hoverHero\(\)\)\} alt="" \/>/);
});

test('suggest thumbs preload into the LRU; the first rows load eagerly', () => {
  assert.match(box, /preloadSuggestThumbs/);
  assert.match(box, /loading=\{thumbLoading\(\)\}/);
  assert.match(box, /fetchPriority=\{thumbPriority\(\)\}/);
  assert.match(box, /SUGGEST_THUMB_EAGER/);
});

test('game and title language sit on the left of the search pill', () => {
  assert.match(box, /class="search-pill"[\s\S]*<div class="search-lead">[\s\S]*<GameSelect \/>[\s\S]*<LangToggle \/>/);
  assert.match(toggles, /export function PrintLangToggle[\s\S]*search-lens-mark[\s\S]*search-go-icon/);
  assert.match(box, /<Show when=\{pokemon\(\)\}><PrintLangToggle \/><\/Show>/);
  // The header submit is screen-reader only; the landing hero shows it (search-go).
  assert.match(box, /class=\{props\.hero \? 'search-go' : 'sr-only'\} type="submit"/);
  assert.equal(box.includes('search-submit'), false);
  assert.equal(/<\/form>\s*<LangToggle \/>/.test(box), false);
  assert.match(read('./SearchToolbar.jsx'), /aria-label="Card print"/);
  assert.equal(box.includes('variant="drawer"'), false);
});

test('satellite games: no Pokémon print chip in suggest or search; one icon per game', () => {
  assert.match(box, /fetchSuggest\(text, \{[^}]*printLang: 'all'/s);
  const search = read('../pages/Search.jsx');
  assert.match(search, /const activePrintLang = createMemo\(\(\) => \(!pokemon \|\| tab\(\) === 'users' \? 'all' : printLang\(\)\)\)/);
  assert.match(search, /showPrint=\{pokemon\}/);
  assert.match(toggles, /gameIconSrc/);
  assert.match(toggles, /class="game-icon"/);
});

test('the extension side panel asks for cards only', () => {
  assert.match(box, /props\.extensionDesk \? 'Search cards'/);
});
