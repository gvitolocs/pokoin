import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  gameBasename,
  gameHref,
  gameIdFromPath,
  gameSitePath,
  isMarketplaceHomePath,
} from '../../../market/src/game.js';
import { searchLanguageNavigationPath } from '../../../market/src/locale.js';
import { searchHref } from '../../../market/src/search-kind.js';
import { crossGameFullLoad } from '../lib/yield-nav.js';
import { landingHistory } from './landing-history.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const landing = read('./LandingSearch.jsx');
const island = read('./island.jsx');
const box = read('../components/SearchBox.jsx');
const chrome = read('../components/Chrome.jsx');

const tick = () => new Promise((resolve) => queueMicrotask(resolve));

test('the landing and the header render the same SearchBox component', () => {
  assert.match(chrome, /import SearchBox from '\.\/SearchBox\.jsx';/);
  assert.match(chrome, /<SearchBox /);
  assert.match(landing, /import SearchBox, \{ fillSuggest, prewarmSuggest \} from '\.\.\/components\/SearchBox\.jsx';/);
  assert.match(landing, /<SearchBox\s+hero/);
  // No second typeahead: no own engine, listbox or result rows on the landing.
  for (const source of [landing, island]) {
    assert.doesNotMatch(source, /createLiveSuggest|live-suggest|role="listbox"|hero-suggest|fetchSuggest/);
  }
  // Same pickers inside the box: game, title language, print family.
  assert.match(box, /<GameSelect \/>/);
  assert.match(box, /<LangToggle \/>/);
  assert.match(box, /<PrintLangToggle \/>/);
  // The hero variant only adds a class and a visible Search button.
  assert.match(box, /class=\{\['search', \{ 'search-hero': props\.hero \}\]\}/);
  assert.match(box, /class=\{props\.hero \? 'search-go' : 'sr-only'\} type="submit">Search</);
});

test('the landing loads the header search styles, not a copy', () => {
  assert.match(landing, /import '@market\/search-box\.css';/);
  const styles = read('../../../market/src/styles.css');
  assert.match(styles, /^@import "\.\/search-box\.css";/);
  const searchCss = read('../../../market/src/search-box.css');
  for (const rule of ['.suggest-row {', '.game-menu {', '.print-lang-toggle {', '.lang-menu {', '.search-tabs {']) {
    assert.ok(searchCss.includes(rule), `${rule} lives in search-box.css`);
    assert.equal(styles.includes(`\n${rule}`), false, `${rule} is not duplicated in styles.css`);
  }
});

test('the box mounts at idle or on intent; the engine still loads on focus', () => {
  assert.match(island, /import\('\.\/LandingSearch\.jsx'\)/);
  assert.match(island, /whenIdle\(startQuietly\)/);
  assert.match(island, /'focusin', startQuietly/);
  // The SearchBox chunk owns the engine import, behind its own intent handlers.
  assert.match(box, /import\('\.\.\/lib\/suggest-engine\.js'\)/);
  assert.match(box, /onFocus=\{\(\) => \{\s*setOpen\(true\);\s*onIntent\(\);/);
  assert.match(box, /const \[intent, setIntent\] = createSignal\(!props\.hero\);/);
});

test('landing history: a game pick moves the virtual home and stays on the page', () => {
  const loads = [];
  const history = landingHistory({ assign: (href) => loads.push(href) });
  assert.equal(history.get(), '/marketplace');
  // GameSelect on the landing: gameSitePath → that game's marketplace home → navigate.
  const target = gameSitePath('one_piece', history.get());
  assert.equal(target, '/one-piece/marketplace');
  assert.equal(isMarketplaceHomePath(target), true);
  assert.equal(crossGameFullLoad(history.get(), target), false);
  history.set({ value: target });
  assert.equal(history.get(), '/one-piece/marketplace');
  assert.equal(gameIdFromPath(history.get()), 'one_piece');
  assert.deepEqual(loads, []);
  // Back to Pokémon.
  history.set({ value: gameSitePath('pokemon', history.get()) });
  assert.equal(history.get(), '/marketplace');
  assert.deepEqual(loads, []);
});

test('landing history: a search is a document load into the game-prefixed search page', async () => {
  const loads = [];
  const notified = [];
  const history = landingHistory({ assign: (href) => loads.push(href) });
  history.init((value) => notified.push(value));
  history.set({ value: '/one-piece/marketplace' });
  // SearchBox goSearch → useGameNavigate → gameHref under the picked game.
  const href = gameHref(searchHref('luffy gear 5'), gameBasename(history.get()));
  assert.equal(href, '/one-piece/marketplace/search?q=luffy+gear+5');
  history.set({ value: href });
  assert.deepEqual(loads, ['/one-piece/marketplace/search?q=luffy+gear+5']);
  await tick();
  // The router settles back on the home it left.
  assert.deepEqual(notified, ['/one-piece/marketplace']);
  assert.equal(history.get(), '/one-piece/marketplace');
});

test('landing history: Pokémon searches keep the unprefixed URL and tab params', () => {
  const loads = [];
  const history = landingHistory({ assign: (href) => loads.push(href) });
  const href = gameHref(searchHref('mimikyu gx', 'product'), gameBasename(history.get()));
  history.set({ value: href });
  assert.deepEqual(loads, ['/marketplace/search?q=mimikyu+gx&tab=product']);
});

test('the title-language picker does not navigate away from the landing', () => {
  for (const lang of ['jp', 'it', 'en']) {
    assert.equal(searchLanguageNavigationPath('/marketplace', lang), '/marketplace');
    assert.equal(searchLanguageNavigationPath('/one-piece/marketplace', lang), '/one-piece/marketplace');
  }
});

test('a Popular chip is warmed ahead and fills the box in one update', () => {
  // One paging loop for the live pool and the prewarm: the same suggestPage keys.
  assert.equal((box.match(/await suggestPage\(/g) || []).length, 1);
  assert.match(box, /async function pageUniverse\(live, text, \{ lang, print, signal, alive = \(\) => true, onPage \} = \{\}\)/);
  assert.match(box, /const ended = await pageUniverse\(live, text, \{/);
  assert.match(box, /pageUniverse\(live, q, \{ lang, print \}\),/);
  // Catalog hydration and row warming are shared too.
  assert.match(box, /for \(const target of catalogTargets\(live, text, lang\)\) \{\s*hydrateTarget\(live, target, lang\)/);
  assert.match(box, /\.\.\.catalogTargets\(live, q, lang\)\.map\(\(target\) => hydrateTarget\(live, target, lang\)/);
  assert.match(box, /warmRows\(rows, rotatePreload\.length \? rows\.concat\(rotatePreload\) : rows\);/);
  // The results total is asked for with the same options as the popup's count.
  assert.match(box, /prefetchSearchPage\(q, lang, \{ fetchSearchPage: fetchSearchRecall, tab, printLang: print \}\)/);
  // fillSuggest commits query and term together and takes the warmed total at once.
  assert.match(box, /node\.addEventListener\('suggest-fill', \(event\) => fillWhole\(String\(event\.detail \|\| ''\)\)\)/);
  assert.match(box, /function fillWhole\(value\) \{[\s\S]*?setQuery\(value\);\s*setTerm\(value\);[\s\S]*?takeHotSearchPage\(text, searchLang\(\), searchTab\(\), printLang\(\)\)/);
  // Typing still trails a paint (unchanged).
  assert.match(box, /termTimer = afterPaint\(\(\) => \{\s*termTimer = 0;\s*setTerm\(nextTerm\);/);

  assert.match(landing, /export function warmPopular\(query, \{ thumbs = false \} = \{\}\) \{\s*return prewarmSuggest\(query, \{ lang: searchLang\(\), printLang: printLang\(\), thumbs \}\);/);
  // Island: warm on hover / focus / touch, wait (capped) on click, then fill; idle warming skips slow or metered links.
  assert.match(island, /chip\.addEventListener\('pointerenter', warmThumbs, \{ once: true \}\);/);
  assert.match(island, /Promise\.race\(\[ready, new Promise\(\(resolve\) => setTimeout\(resolve, CHIP_WAIT_MS\)\)\]\)/);
  assert.match(island, /landing\.fillSuggest\(input, query\);/);
  assert.match(island, /link\?\.saveData \|\| \/\(\?:\^\|-\)\[23\]g\$\//);
});
