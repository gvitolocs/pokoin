import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
const desktopCss = css.slice(0, css.indexOf('@media (max-width: 720px)'));
const phone720 = css.slice(css.indexOf('@media (max-width: 720px)'));
const phone720First = phone720.slice(0, phone720.indexOf('@media (max-width: 480px)'));

/** Desktop Playwright: `resize 1440 900`. Phone: `resize 393 852` (iPhone 16). */
test('suggest row is two columns without a Singles cell', () => {
  const row = desktopCss.match(/\.suggest-row \{[^}]+\}/);
  assert.ok(row, 'desktop .suggest-row');
  assert.match(row[0], /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/);
  assert.equal(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+auto/.test(row[0]), false);
  assert.equal(desktopCss.includes('.suggest-row:has(.suggest-art)'), false);
  const chrome = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'components/Chrome.jsx'), 'utf8');
  assert.equal(chrome.includes('suggest-kind'), false);
  assert.equal(chrome.includes('suggest-meta'), false);
  assert.equal(chrome.includes('suggest-pending'), false);
  assert.equal(desktopCss.includes('.suggest-pending'), false);
  assert.match(chrome, /data-suggest-id/);
  assert.match(chrome, /liveSuggestGroups/);
  assert.match(chrome, /suggestLiveReady/);
  assert.match(chrome, /identity\.suggestExpansionShort/);
  assert.match(chrome, /<ExpansionMark/);
  assert.match(chrome, /expansionSymbolUrl/);
  const api = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'api.js'), 'utf8');
  assert.match(api, /expansion_symbol_url/);
});

test('desktop collector number is its own middle column; phone folds it into the title', () => {
  const main = desktopCss.match(/\.suggest-main \{[^}]+\}/);
  assert.ok(main, 'desktop .suggest-main');
  assert.match(main[0], /grid-template-columns:\s*2\.15rem 48px minmax\(0,\s*1fr\)/);
  assert.match(main[0], /width:\s*100%/);
  assert.match(desktopCss, /\.suggest-copy \{[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)/);
  assert.match(desktopCss, /\.suggest-copy \{[^}]*align-items:\s*first baseline/);
  assert.match(desktopCss, /\.suggest-copy-text \{[^}]*flex-direction:\s*column/);
  assert.match(desktopCss, /\.suggest-number \{[^}]*text-align:\s*left/);
  assert.match(desktopCss, /\.suggest-number \{[^}]*min-width:\s*7\.5ch/);
  assert.equal(desktopCss.includes('suggest-copy-head'), false);
  const chrome = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'components/Chrome.jsx'), 'utf8');
  assert.match(chrome, /className="suggest-translated"/);
  assert.match(chrome, /suggestTranslatedLine/);
  assert.match(chrome, /suggestCardName/);
  assert.match(desktopCss, /\.suggest-translated \{/);
  assert.match(chrome, /className="suggest-number"/);
  assert.match(chrome, /clipSuggestCollector/);
  assert.match(desktopCss, /\.suggest-number \{[^}]*font-size:\s*1\.55rem/);
  assert.match(desktopCss, /\.suggest-copy strong \{[^}]*color:\s*var\(--yellow\)/);
  assert.match(desktopCss, /\.suggest-copy strong \{[^}]*font-size:\s*1\.4rem/);
  assert.match(desktopCss, /\.suggest-num-phone \{\s*display:\s*none/);
  assert.match(phone720First, /\.suggest-number \{\s*display:\s*none/);
  assert.match(phone720First, /\.suggest-num-phone \{\s*display:\s*inline/);
  const phoneMain = phone720First.match(/\.suggest-main \{[^}]+\}/);
  assert.ok(phoneMain, 'phone .suggest-main');
  assert.match(phoneMain[0], /grid-template-columns:\s*40px minmax\(0,\s*1fr\)/);
  assert.equal(/1\.85rem 40px/.test(phoneMain[0]), false);
  assert.equal(/minmax\(0,\s*1fr\)\s+auto/.test(phoneMain[0]), false);
  assert.match(desktopCss, /\.suggest-set \{[^}]*min-height:\s*68px/);
  assert.match(desktopCss, /\.suggest-set \.set-shortcut \{[^}]*width:\s*2\.15rem/);
  assert.match(desktopCss, /\.suggest-set \.set-shortcut-sym \{[^}]*min-height:\s*0/);
  assert.match(desktopCss, /\.suggest-set \.set-shortcut-sym \{[^}]*max-height:\s*2\.15rem/);
  assert.match(desktopCss, /\.suggest-main img:not\(\.set-shortcut-sym\)/);
  assert.match(desktopCss, /\.suggest-set \.set-shortcut-sym \{[^}]*background:\s*transparent/);
  assert.match(desktopCss, /\.set-shortcut:has\(\.set-shortcut-code\) \{[^}]*background:\s*rgb\(35 31 32\)/);
  assert.match(desktopCss, /\.set-shortcut\.is-on:has\(\.set-shortcut-code\) \{[^}]*background:\s*rgb\(35 31 32\)/);
  assert.match(desktopCss, /\.set-shortcut\.is-on:has\(\.set-shortcut-code\) \{[^}]*box-shadow:/);
  assert.equal(/\.set-shortcut\.is-on:has\(\.set-shortcut-code\) \{[^}]*background:\s*#fff/.test(desktopCss), false);
  assert.equal(/\.set-shortcut \{\s*[^}]*background:\s*#fff/.test(desktopCss), false);
  assert.equal(/\.set-shortcut\.is-on,\s*\.set-mark-glow \{[^}]*color:\s*var\(--yellow\)/.test(desktopCss), false);
  assert.match(desktopCss, /\.set-shortcut\.is-on \.set-shortcut-sym/);
  assert.match(desktopCss, /\.set-shortcut\.is-on \.set-shortcut-sym,\s*\.set-mark-glow \.set-shortcut-sym[\s\S]*drop-shadow/);
  assert.match(desktopCss, /\.set-shortcut\.is-on,\s*\.set-mark-glow \{[^}]*border-color:\s*transparent/);
  assert.equal(/\.set-shortcut\.is-on,\s*\.set-mark-glow \{[^}]*border-color:\s*var\(--yellow\)/.test(desktopCss), false);
  assert.match(chrome, /className="set-shortcut is-on"/);
  const expansion = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pages/Expansion.jsx'), 'utf8');
  assert.match(expansion, /set-sym-wrap/);
  const setGuide = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'components/SetGuideGrid.jsx'), 'utf8');
  const desk = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'desk.css'), 'utf8');
  assert.match(setGuide, /className="set-shortcut is-on"/);
  assert.match(setGuide, /printFlagFromNationality\(row\.nationality\)/);
  assert.match(setGuide, /set-guide-print-flag/);
  assert.match(desk, /\.set-guide-print-flag img \{[^}]*border-radius:\s*50%/);
  assert.match(desk, /\.set-guide-card strong\.has-print-flag \{[^}]*display:\s*flex/);
  assert.doesNotMatch(setGuide.match(/function SetGuideLogo[\s\S]*?\n\}/)[0], /printFlag/);
  assert.match(
    phone720First,
    /\.suggest-art-cluster:has\(\.suggest-art\) \.suggest-print-flag \{[^}]*position:\s*absolute/,
  );
});

test('phone ≤720px suggest row stays two columns', () => {
  const row = phone720First.match(/\.suggest-row \{[^}]+\}/g)?.find((block) => /grid-template-columns/.test(block));
  assert.ok(row, 'phone .suggest-row sets columns');
  assert.match(row, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/);
  assert.equal(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+auto/.test(row), false);
  assert.match(phone720First, /\.suggest-main \{[^}]*width:\s*100%/);
});

test('LEGEND and BREAK suggest art is the full card rotated, not the art-cut', () => {
  const chrome = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'components/Chrome.jsx'), 'utf8');
  assert.match(chrome, /resolveArtLayout/);
  assert.match(chrome, /artLayout === 'landscape'/);
  assert.match(chrome, /is-landscape/);
  assert.match(chrome, /cut=\{artLayout === 'window' \|\| artLayout === 'halfart'\}/);
  assert.match(desktopCss, /\.suggest-art\.is-landscape \{/);
  assert.match(desktopCss, /\.suggest-art\.is-landscape img \{[^}]*rotate\(90deg\)/);
  assert.match(phone720First, /\.suggest-art\.is-landscape \{ --suggest-art-w:\s*6\.75rem/);
});

test('full-bleed suggest art skips the illustration window crop', () => {
  const chrome = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'components/Chrome.jsx'), 'utf8');
  assert.match(chrome, /resolveArtLayout/);
  assert.match(chrome, /is-bleed/);
  assert.match(desktopCss, /\.suggest-art\.is-bleed \{/);
  assert.match(desktopCss, /\.suggest-art\.is-bleed img \{[^}]*object-position:\s*center 18%/);
});

test('desktop suggest hover shows leftover JPEG beside the panel', () => {
  const chrome = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'components/Chrome.jsx'), 'utf8');
  assert.match(desktopCss, /\.suggest-hover \{[^}]*position:\s*fixed/);
  assert.match(desktopCss, /\.suggest-hover \{[^}]*pointer-events:\s*none/);
  assert.match(phone720First, /\.suggest-hover \{\s*display:\s*none/);
  assert.match(chrome, /className="suggest-hover"/);
  assert.match(chrome, /full=\{Boolean\(hoverHero\)\}/);
  assert.match(chrome, /createPortal/);
  assert.match(chrome, /<CardArt src=\{hoverSrc\} full=\{Boolean\(hoverHero\)\} alt="" \/>/);
});

test('suggest thumbs preload into a 128 LRU; hover JPEGs are not cached', () => {
  const chrome = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'components/Chrome.jsx'), 'utf8');
  const images = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'suggest-images.js'), 'utf8');
  const api = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'api.js'), 'utf8');
  assert.match(images, /SUGGEST_THUMB_CACHE = 128/);
  assert.equal(images.includes('preloadSuggestHero'), false);
  assert.match(chrome, /preloadSuggestThumbs/);
  assert.match(chrome, /loading=\{thumbLoading\}/);
  assert.match(chrome, /fetchPriority=\{thumbPriority\}/);
  assert.match(chrome, /SUGGEST_THUMB_EAGER/);
  assert.match(api, /preloadSuggestThumbs\(collectPrintingThumbUrls/);
});

test('game and title language sit on the left of the search pill', () => {
  assert.match(desktopCss, /\.topbar-row \{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto auto/);
  assert.match(desktopCss, /--topbar-logo:\s*40px/);
  assert.match(desktopCss, /--topbar-flag:\s*32px/);
  const phoneBar = phone720First.match(/\.topbar-row \{[^}]+\}/);
  assert.ok(phoneBar, 'phone .topbar-row');
  assert.match(phoneBar[0], /grid-template-columns:\s*auto auto minmax\(0,\s*1fr\) auto/);
  assert.match(phoneBar[0], /--topbar-flag:\s*32px/);
  assert.equal(phone720First.includes('.topbar-row > .lang-toggle {'), false);
  const chrome = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'components/Chrome.jsx'), 'utf8');
  const toolbar = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'components/SearchToolbar.jsx'), 'utf8');
  assert.match(chrome, /className="search-pill"[\s\S]*<div className="search-lead">[\s\S]*<GameSelect \/>[\s\S]*<LangToggle \/>/);
  assert.equal(chrome.includes('PrintLangToggle'), false);
  assert.match(chrome, /className="search-submit" type="submit"/);
  assert.equal(/<\/form>\s*<LangToggle \/>/.test(chrome), false);
  assert.match(toolbar, /aria-label="Card print"/);
  assert.equal(chrome.includes('variant="drawer"'), false);
});
