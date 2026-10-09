import { createEffect, createSignal, For, onSettled, Show, untrack } from 'solid-js';
import { Portal } from '@solidjs/web';
import { useLocation, useNavigate } from '@solidjs/router';
import { formatPknNumber } from '@market/api.js';
import { catalogMenuLinks } from '@market/catalog-links.js';
import { framedByChromeExtension } from '@market/extension-auth-bridge.js';
import { game, isPokemonGame } from '@market/game.js';
import { MESSAGES_UNREAD_EVENT, MESSAGES_UNREAD_REFRESH_MS, unreadMessagesCount } from '@market/messages-unread.js';
import { APP, DASHBOARD_HOME, authFrom, marketUrl } from '@market/punchouts.js';
import { whenIdle } from '../lib/idle.js';
import { lazyModule } from '../lib/lazy-module.js';
import { installSelectBand, selectBand } from '../lib/select-band.js';
import { accountAdmin, accountProfile, accountSilver, pknAmount } from '../stores/account.js';
import { authUser, getBearer, signedIn } from '../stores/auth.js';
import { cartCount } from '../stores/cart.js';
import { desktopItems } from '../stores/desktop.js';
import { searchLang } from '../stores/locale.js';
import AppLink from './AppLink.jsx';
import Avatar from './Avatar.jsx';
import PokoinWordmark from './PokoinWordmark.jsx';
import SearchBox from './SearchBox.jsx';

/** Header icon paths (market/src/components/Chrome.jsx ICO); the phone menu's live in MobileMenu.jsx. */
const ICO = {
  storefront: 'M21.9 8.89l-1.05-4.37c-.22-.9-1-1.52-1.91-1.52H5.05c-.9 0-1.69.63-1.9 1.52L2.1 8.89c-.24 1.02-.02 2.06.62 2.88.08.11.19.19.28.29V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-6.94c.09-.09.2-.18.28-.28.64-.82.87-1.87.62-2.89zm-2.99-3.9l1.05 4.37c.1.42.01.84-.25 1.17-.14.18-.44.47-.94.47-.61 0-1.14-.49-1.21-1.14L16.98 5l1.93-.01zM13 5h1.96l.54 4.52c.05.39-.07.78-.33 1.07-.22.26-.54.41-.95.41-.67 0-1.22-.59-1.22-1.31V5zM8.49 9.52L9.04 5H11v4.69c0 .72-.55 1.31-1.29 1.31-.34 0-.65-.15-.89-.41-.25-.29-.38-.68-.33-1.07zm-4.45-.16L5.05 5h1.97l-.58 4.86c-.08.65-.6 1.14-1.21 1.14-.49 0-.8-.29-.93-.47-.27-.32-.36-.75-.26-1.17zM5 19v-6.03c.08.01.15.03.23.03.87 0 1.66-.36 2.24-.95.6.6 1.4.95 2.31.95.87 0 1.65-.36 2.23-.93.59.57 1.39.93 2.29.93.84 0 1.64-.35 2.24-.95.58.59 1.37.95 2.24.95.08 0 .15-.02.23-.03V19H5z',
  messages: 'M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-5 4V6a2 2 0 0 1 2-2Zm2 5v2h12V9H6Zm0 4v2h8v-2H6Z',
  // Four portrait mini-cards (~6×9, ratio ≈0.67) — not an app-grid of squares.
  dashboard: 'M6 3h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm8 0h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM6 14h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zm8 0h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z',
  trophy: 'M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94A5.01 5.01 0 0 0 11 17.9V19H7v2h10v-2h-4v-1.1a5.01 5.01 0 0 0 3.61-4.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z',
  cart: 'M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1 1 0 0 0 20 4H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z',
  profile: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
};

const DESKTOP_ICON = 'M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v8h14V7H5zm-1 12h16v2H4v-2z';

const MENU_PATHS = {
  profile: APP.profile,
  messages: APP.messages,
  cart: APP.cart,
  wallet: APP.wallet,
  buy: APP.buy,
  admin: APP.admin,
  forum: APP.forum,
  protection: APP.protection,
  dashboard: DASHBOARD_HOME,
};

// Everything below the header row that is not on the first paint is its own
// chunk, imported on the gesture that shows it (hover, click, card drag).
const cartTray = lazyModule(() => import('./CartDrop.jsx'));
const desktopTray = lazyModule(() => import('./DesktopDrop.jsx'));
const navPreviews = lazyModule(() => import('./NavPreviews.jsx'));
const mobileMenu = lazyModule(() => import('./MobileMenu.jsx'));

function Svg(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="currentColor" d={props.d} />
    </svg>
  );
}

/** Hover / focus card under a nav icon (market NavPreviews NavHover). */
function NavHover(props) {
  const show = () => {
    navPreviews.warm();
    props.setPop(props.id);
  };
  const hide = () => props.setPop((cur) => (cur === props.id ? '' : cur));
  return (
    <span
      class="nav-hover"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusIn={show}
      onFocusOut={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        hide();
      }}
    >
      {props.children}
      <Show when={props.pop === props.id && navPreviews.mod()}>
        {(mod) => {
          const Preview = untrack(mod)[props.preview];
          return <Preview />;
        }}
      </Show>
    </span>
  );
}

/** Footer Catalog disclosure (market/src/components/CatalogHubs.jsx). */
function CatalogMenu(props) {
  return (
    <details class="foot-catalog">
      <summary>Catalog</summary>
      <nav aria-label="Catalog">
        <For each={catalogMenuLinks(props.lang)}>{(row) => <AppLink to={row.to}>{row.label}</AppLink>}</For>
        <a href="/news" target="_self">News</a>
      </nav>
    </details>
  );
}

/** Rubber-band box while a selection is being drawn (select-band.jsx portal). */
function SelectBandBox() {
  const box = () => {
    const rect = selectBand();
    return rect && (rect.width > 0 || rect.height > 0) ? rect : null;
  };
  return (
    <Show when={box()}>
      {(rect) => (
        <Portal mount={document.body}>
          <div
            class="card-select-band shop-marquee"
            style={{
              left: `${rect().left}px`,
              top: `${rect().top}px`,
              width: `${rect().width}px`,
              height: `${rect().height}px`,
            }}
          />
        </Portal>
      )}
    </Show>
  );
}

/**
 * Header, main and footer for every migrated route
 * (market/src/components/Chrome.jsx): brand, Desktop tray, search, icon nav
 * with hover previews and the messages unread dot, PKN wallet chip, avatar,
 * cart tray, phone menu, footer, and the page-wide selection band.
 */
export default function Chrome(props) {
  const navigate = useNavigate();
  const location = useLocation();
  const site = game();
  const pokemon = isPokemonGame();
  const extensionDesk = framedByChromeExtension();
  const [menu, setMenu] = createSignal(false);
  const [menuArmed, setMenuArmed] = createSignal(false);
  const [navPop, setNavPop] = createSignal('');
  const [cardDrag, setCardDrag] = createSignal(false);
  const [messagesUnread, setMessagesUnread] = createSignal(0);

  const profile = () => accountProfile();
  const showAvatar = () => Boolean(signedIn() && (profile()?.uid || authUser()?.uid));
  const desktopCount = () => desktopItems().length;
  const pknLabel = () => `${formatPknNumber(pknAmount())} PKN`;
  const homeHref = marketUrl(site.homeHref || '/');
  const signInTo = () => {
    const path = location.pathname.startsWith('/auth')
      ? (new URLSearchParams(location.search).get('from') || '/marketplace')
      : `${location.pathname || '/marketplace'}${location.search || ''}`;
    return authFrom(path);
  };

  installSelectBand(() => `${location.pathname}${location.search}`);

  // Card drags open both trays. Mounting them in the same turn as dragstart
  // makes Chrome abort HTML5 drags that started from text links (Pokémon
  // name / set / artist), so they open on the next frame.
  let openTray = 0;
  function openDragTrays() {
    cartTray.warm();
    desktopTray.warm();
    if (openTray) cancelAnimationFrame(openTray);
    openTray = requestAnimationFrame(() => {
      openTray = 0;
      setNavPop('');
      setCardDrag(true);
    });
  }
  function onDragEnd() {
    if (openTray) {
      cancelAnimationFrame(openTray);
      openTray = 0;
    }
    setCardDrag(false);
  }
  onSettled(() => {
    // writeListingDrag → markCardDragging dispatches this (survives stopPropagation).
    window.addEventListener('pokoin-card-drag', openDragTrays);
    window.addEventListener('dragend', onDragEnd);
    window.addEventListener('pokoin-card-drag-end', onDragEnd);
    return () => {
      if (openTray) cancelAnimationFrame(openTray);
      window.removeEventListener('pokoin-card-drag', openDragTrays);
      window.removeEventListener('dragend', onDragEnd);
      window.removeEventListener('pokoin-card-drag-end', onDragEnd);
    };
  });

  // Messages unread dot: same /api/chat list seam and refresh event as React.
  createEffect(signedIn, (on) => {
    if (!on) {
      setMessagesUnread(0);
      return undefined;
    }
    let active = true;
    const refresh = async () => {
      try {
        const token = await getBearer();
        if (!token) return;
        const { listConversations } = await import('@market/chat-client.js');
        const result = await listConversations(token);
        if (active) setMessagesUnread(unreadMessagesCount(result?.conversations || []));
      } catch {
        /* unread dot is best-effort; never break the nav */
      }
    };
    // First read after the first paint: it needs a bearer.
    const cancel = whenIdle(refresh);
    const timer = setInterval(refresh, MESSAGES_UNREAD_REFRESH_MS);
    const onUnread = (event) => {
      if (typeof event?.detail?.count === 'number') setMessagesUnread(event.detail.count);
    };
    window.addEventListener(MESSAGES_UNREAD_EVENT, onUnread);
    return () => {
      active = false;
      cancel();
      clearInterval(timer);
      window.removeEventListener(MESSAGES_UNREAD_EVENT, onUnread);
    };
  });

  // Phone menu: close on navigation; while open, lock the page scroll, hide
  // the chat button and listen for Escape.
  createEffect(() => location.pathname, () => {
    setMenu(false);
  }, { defer: true });
  createEffect(menu, (open) => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.classList.add('menu-open');
    const onKey = (event) => {
      if (event.key === 'Escape') setMenu(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      document.body.classList.remove('menu-open');
      document.removeEventListener('keydown', onKey);
    };
  });
  // The drawer mounts closed when its chunk lands, then opens a frame later
  // so the slide-in transition plays on the first press too.
  createEffect(() => Boolean(mobileMenu.mod()), (loaded) => {
    if (!loaded) return undefined;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setMenuArmed(true)));
    return () => cancelAnimationFrame(id);
  });
  const closeMenu = () => setMenu(false);

  return (
    <div class="shell">
      <header class="topbar">
        <div class="topbar-row">
          <button
            class="burger"
            type="button"
            aria-label="Menu"
            aria-expanded={menu() ? 'true' : 'false'}
            aria-controls="mobile-menu"
            onPointerDown={() => mobileMenu.warm()}
            onClick={() => {
              mobileMenu.warm();
              setMenu((v) => !v);
            }}
          >
            <span /><span /><span />
          </button>
          <AppLink class="brand" to="/marketplace" aria-label={site.title}>
            {/* Flyer wordmark: the coin mascot is the "o" in Pokoin. Phone keeps the round badge. */}
            <img class="brand-badge" src="/home/logo.png" alt="" width="40" height="40" />
            <PokoinWordmark />
          </AppLink>
          <span
            class="desktop-anchor"
            onMouseEnter={() => {
              desktopTray.warm();
              setNavPop('desktop');
            }}
            onMouseLeave={() => setNavPop((cur) => (cur === 'desktop' ? '' : cur))}
          >
            <button
              type="button"
              class="desktop-chip"
              aria-label={`Desktop, ${desktopCount()} cards`}
              title="Desktop"
              onClick={() => {
                desktopTray.warm();
                setNavPop((cur) => (cur === 'desktop' ? '' : 'desktop'));
              }}
            >
              <Svg d={DESKTOP_ICON} />
              <Show when={desktopCount() > 0}><em>{desktopCount()}</em></Show>
            </button>
            <Show when={(cardDrag() || navPop() === 'desktop') && desktopTray.mod()}>
              {(mod) => {
                const Tray = untrack(mod).default;
                return <Tray />;
              }}
            </Show>
          </span>
          <SearchBox onNavigate={closeMenu} extensionDesk={extensionDesk} />
          <nav class="nav icon-nav" aria-label="Marketplace">
            <NavHover id="market" pop={navPop()} setPop={setNavPop} preview="MarketPreview">
              <AppLink to="/marketplace" aria-label="Marketplace"><Svg d={ICO.storefront} /></AppLink>
            </NavHover>
            <NavHover id="messages" pop={navPop()} setPop={setNavPop} preview="MessagesPreview">
              <AppLink
                class="messages-link"
                to={APP.messages}
                aria-label={messagesUnread() > 0 ? 'Messages, unread messages' : 'Messages'}
              >
                <Svg d={ICO.messages} />
                <Show when={messagesUnread() > 0}><span class="messages-unread-dot" aria-hidden="true" /></Show>
              </AppLink>
            </NavHover>
            <NavHover id="dashboard" pop={navPop()} setPop={setNavPop} preview="DashboardPreview">
              <AppLink to={DASHBOARD_HOME} aria-label="Dashboard"><Svg d={ICO.dashboard} /></AppLink>
            </NavHover>
            <Show when={site.features?.competitive}>
              <AppLink class="trophy" to="/marketplace/competitive" title="Competitive" aria-label="Competitive"><Svg d={ICO.trophy} /></AppLink>
            </Show>
            <AppLink class="pkn-chip" to="/wallet" title="Wallet">{pknLabel()}</AppLink>
            <Show
              when={signedIn()}
              fallback={(
                <button
                  type="button"
                  class="signin-button"
                  title="Sign in"
                  aria-label="Sign in"
                  onClick={() => navigate(signInTo())}
                >
                  <Svg d={ICO.profile} />
                </button>
              )}
            >
              <AppLink class={showAvatar() ? 'topbar-avatar' : undefined} to="/profile" title="Profile" aria-label="Profile">
                <Show when={showAvatar()} fallback={<Svg d={ICO.profile} />}>
                  <Avatar
                    src={profile()?.photoUrl}
                    seed={profile()?.uid || authUser()?.uid}
                    name={profile()?.username}
                    size={32}
                    silver={accountSilver()}
                    variant="chip"
                  />
                </Show>
              </AppLink>
            </Show>
            <span
              class="cart-anchor"
              onMouseEnter={() => {
                cartTray.warm();
                setNavPop('cart');
              }}
              onMouseLeave={() => setNavPop((cur) => (cur === 'cart' ? '' : cur))}
            >
              <AppLink class="cart-chip" to="/cart" aria-label={`Cart, ${cartCount()} items`}>
                <Svg d={ICO.cart} />
                <em>{cartCount()}</em>
              </AppLink>
              <Show when={(cardDrag() || navPop() === 'cart') && cartTray.mod()}>
                {(mod) => {
                  const Tray = untrack(mod).default;
                  return <Tray />;
                }}
              </Show>
            </span>
          </nav>
        </div>
      </header>
      <button
        class={['mobile-scrim', { on: menu() }]}
        type="button"
        tabindex={menu() ? 0 : -1}
        aria-label="Close menu"
        onClick={closeMenu}
      />
      <Show when={mobileMenu.mod()}>
        {(mod) => {
          const Menu = untrack(mod).default;
          return (
            <Menu
              open={menu() && menuArmed()}
              onClose={closeMenu}
              lang={searchLang()}
              pokemon={pokemon}
              competitive={Boolean(site.features?.competitive)}
              signedIn={signedIn()}
              admin={accountAdmin()}
              profile={profile()}
              user={authUser() || null}
              silver={accountSilver()}
              pknLabel={pknLabel()}
              cartCount={cartCount()}
              messagesUnread={messagesUnread()}
              signInTo={signInTo()}
              homeHref={homeHref}
              paths={MENU_PATHS}
            />
          );
        }}
      </Show>
      <main>{props.children}</main>
      <SelectBandBox />
      <Footer signInTo={signInTo()} />
    </div>
  );
}

function Footer(props) {
  const lang = () => searchLang();
  return (
    <footer class="foot">
      <div class="foot-grid">
        <div>
          <strong>Pokoin</strong>
          <p>Buy. Sell. Settle in PKN.</p>
        </div>
        <div>
          <h3>Shop</h3>
          <AppLink to="/marketplace">Marketplace</AppLink>
          <AppLink to="/marketplace/search">Search</AppLink>
          <AppLink to="/marketplace/competitive">Competitive</AppLink>
          <AppLink to="/marketplace/explore">Explore</AppLink>
          <AppLink to="/marketplace/portfolio">Portfolio</AppLink>
          <AppLink to="/marketplace/sets">Sets</AppLink>
          <AppLink to={`/marketplace/${lang()}/pokemon`}>Pokémon</AppLink>
          <AppLink to={`/marketplace/${lang()}/artists`}>Artists</AppLink>
          <Show when={isPokemonGame()}><CatalogMenu lang={lang()} /></Show>
          <AppLink to="/marketplace/watchlist">Watchlist</AppLink>
        </div>
        <div>
          <h3>Account</h3>
          <AppLink to={APP.messages}>Messages</AppLink>
          <AppLink to={APP.wallet}>Wallet</AppLink>
          <AppLink to={APP.buy}>Buy PKN</AppLink>
          <AppLink to={APP.cart}>Cart</AppLink>
          <AppLink to="/checkout">Checkout</AppLink>
          <AppLink to="/orders">Orders</AppLink>
          <AppLink to="/mypokoin/collection">Collection</AppLink>
          <AppLink to={APP.profile}>Profile</AppLink>
          <Show when={accountAdmin()}><AppLink to={APP.admin}>Admin</AppLink></Show>
          <Show when={!signedIn()}><AppLink to={props.signInTo}>Sign in</AppLink></Show>
        </div>
        <div>
          <h3>More</h3>
          <a href={marketUrl('/')} target="_self">Home</a>
          <AppLink to={APP.forum}>Forum</AppLink>
          <AppLink to={DASHBOARD_HOME}>Dashboard</AppLink>
          <AppLink to={APP.docs}>Docs</AppLink>
          <AppLink to={APP.about}>About</AppLink>
          <AppLink to="/sitemap">Site map</AppLink>
          <AppLink to={APP.careers}>Careers</AppLink>
          <AppLink to={APP.privacy}>Privacy</AppLink>
          <AppLink to={APP.emailPreferences}>Email preferences</AppLink>
          <AppLink to={APP.protection}>Buyer protection</AppLink>
          <AppLink to="/flex">Pokoin Flex</AppLink>
          <AppLink to="/invite">Invite &amp; Earn</AppLink>
          <AppLink to="/ambassadorprogram">Ambassador program</AppLink>
          <AppLink to={APP.scan}>Scan</AppLink>
        </div>
      </div>
    </footer>
  );
}
