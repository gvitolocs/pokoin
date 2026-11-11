import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const chrome = read('./Chrome.jsx');
const app = read('../App.jsx');

test('the nav dot is driven by the same /api/chat list seam as the Messages page', () => {
  assert.match(chrome, /listConversations/);
  assert.match(chrome, /unreadMessagesCount/);
  assert.match(chrome, /messages-unread-dot/);
  assert.match(chrome, /MESSAGES_UNREAD_REFRESH_MS/);
});

test('closed ChatDock shows a fixed bottom-right FAB that opens the list', () => {
  const dock = read('./ChatDock.jsx');
  assert.match(dock, /class="chat-fab"/);
  assert.match(dock, /openChatList\(\)/);
  assert.match(dock, /chat-fab-badge/);
});

test('the cookie banner publishes its height so the chat button sits above Accept', () => {
  const banner = read('./CookieBanner.jsx');
  assert.match(banner, /setProperty\('--cookie-banner-h'/);
  assert.match(banner, /removeProperty\('--cookie-banner-h'\)/);
  assert.match(banner, /new ResizeObserver\(sync\)/);
});

test('extension side-panel desk clips chrome and skips the origin-down page', () => {
  assert.match(app, /classList\.toggle\('is-extension-desk', framed\)/);
  assert.match(app, /const framed = framedByChromeExtension\(\)/);
  assert.match(app, /<Show when=\{!\(originDown\(\) && !framed\)\} fallback=\{<WorkingOnIt \/>\}>/);
  // Bare pages (test boards, the extension bridge) never show the origin-down page.
  assert.match(app, /<Show when=\{!bare\(\)\} fallback=\{route\(\)\}>/);
});

test('satellite eras and set icons stay off the Pokémon catalogs', () => {
  const era = read('../pages/Era.jsx');
  const sets = read('../pages/Sets.jsx');
  assert.match(era, /SatelliteEras/);
  assert.match(era, /isPokemonGame/);
  assert.match(era, /does not use Pokémon TCG blocks/);
  assert.match(sets, /satelliteGroups/);
  assert.match(sets, /pokemon\s*\?\s*groupExpansions/);
});

test('BuySell sits right after the market icon, in the footer and in the phone menu', () => {
  const menu = read('./MobileMenu.jsx');
  assert.match(chrome, /<BuySellIcon size=\{20\} \/>/);
  assert.doesNotMatch(chrome, /buysell: BUYSELL_ICON/);
  assert.match(chrome, /<\/NavHover>\s*<AppLink class="buysell-link" to="\/buysell" aria-label="BuySell"><BuySellIcon size=\{20\} \/><\/AppLink>\s*<NavHover id="messages"/);
  assert.match(chrome, /<AppLink to="\/buysell">BuySell<\/AppLink>/);
  assert.match(menu, /<Row to="\/buysell" mark="buysell" label="BuySell"/);
});

test('Assets nav preview prints the viewer-currency value, not PKN', () => {
  const src = read('./NavPreviews.jsx');
  assert.match(src, /formatAssetsValue\(last\(\), sellerCurrency\(\)\)/);
  assert.doesNotMatch(src, /formatPknNumber/);
  assert.doesNotMatch(src, /\} PKN/);
});
