import { createSignal, Show } from 'solid-js';
import { useLocation, useNavigate } from '@solidjs/router';
import { game, isPokemonGame } from '@market/game.js';
import { APP, DASHBOARD_HOME, authFrom, marketUrl } from '@market/punchouts.js';
import AppLink from './AppLink.jsx';
import PokoinWordmark from './PokoinWordmark.jsx';
import SearchBox from './SearchBox.jsx';
import { cartCount } from '../stores/cart.js';
import { signedIn } from '../stores/auth.js';

/** Icon paths shared with market/src/components/Chrome.jsx (ICO). */
const ICO = {
  storefront: 'M21.9 8.89l-1.05-4.37c-.22-.9-1-1.52-1.91-1.52H5.05c-.9 0-1.69.63-1.9 1.52L2.1 8.89c-.24 1.02-.02 2.06.62 2.88.08.11.19.19.28.29V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-6.94c.09-.09.2-.18.28-.28.64-.82.87-1.87.62-2.89zm-2.99-3.9l1.05 4.37c.1.42.01.84-.25 1.17-.14.18-.44.47-.94.47-.61 0-1.14-.49-1.21-1.14L16.98 5l1.93-.01zM13 5h1.96l.54 4.52c.05.39-.07.78-.33 1.07-.22.26-.54.41-.95.41-.67 0-1.22-.59-1.22-1.31V5zM8.49 9.52L9.04 5H11v4.69c0 .72-.55 1.31-1.29 1.31-.34 0-.65-.15-.89-.41-.25-.29-.38-.68-.33-1.07zm-4.45-.16L5.05 5h1.97l-.58 4.86c-.08.65-.6 1.14-1.21 1.14-.49 0-.8-.29-.93-.47-.27-.32-.36-.75-.26-1.17zM5 19v-6.03c.08.01.15.03.23.03.87 0 1.66-.36 2.24-.95.6.6 1.4.95 2.31.95.87 0 1.65-.36 2.23-.93.59.57 1.39.93 2.29.93.84 0 1.64-.35 2.24-.95.58.59 1.37.95 2.24.95.08 0 .15-.02.23-.03V19H5z',
  messages: 'M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-5 4V6a2 2 0 0 1 2-2Zm2 5v2h12V9H6Zm0 4v2h8v-2H6Z',
  dashboard: 'M6 3h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm8 0h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM6 14h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zm8 0h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z',
  trophy: 'M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94A5.01 5.01 0 0 0 11 17.9V19H7v2h10v-2h-4v-1.1a5.01 5.01 0 0 0 3.61-4.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z',
  profile: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  cart: 'M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1 1 0 0 0 20 4H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z',
};

function Svg(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="currentColor" d={props.d} />
    </svg>
  );
}

/**
 * Header, main and footer for every migrated route (market/src/components/Chrome.jsx).
 * Ported so far: brand, search box, icon nav, cart count, sign-in, footer.
 * Still React-only (follow-up slices): mobile menu, desktop/cart drops, nav
 * hover previews, messages unread dot, PKN wallet chip, avatar.
 */
export default function Chrome(props) {
  const navigate = useNavigate();
  const location = useLocation();
  const [menu, setMenu] = createSignal(false);
  const site = game();
  const signInTo = () => {
    const path = location.pathname.startsWith('/auth')
      ? (new URLSearchParams(location.search).get('from') || '/marketplace')
      : `${location.pathname || '/marketplace'}${location.search || ''}`;
    return authFrom(path);
  };

  return (
    <div class="shell">
      <header class="topbar">
        <div class="topbar-row">
          <button
            class="burger"
            type="button"
            aria-label="Menu"
            aria-expanded={menu()}
            aria-controls="mobile-menu"
            onClick={() => setMenu((v) => !v)}
          >
            <span /><span /><span />
          </button>
          <AppLink class="brand" to="/marketplace" aria-label={site.title}>
            <img class="brand-badge" src="/home/logo.png" alt="" width="40" height="40" />
            <PokoinWordmark />
          </AppLink>
          <SearchBox />
          <nav class="nav icon-nav" aria-label="Marketplace">
            <AppLink to="/marketplace" aria-label="Marketplace"><Svg d={ICO.storefront} /></AppLink>
            <AppLink class="messages-link" to={APP.messages} aria-label="Messages"><Svg d={ICO.messages} /></AppLink>
            <AppLink to={DASHBOARD_HOME} aria-label="Dashboard"><Svg d={ICO.dashboard} /></AppLink>
            <Show when={site.features?.competitive}>
              <AppLink class="trophy" to="/marketplace/competitive" title="Competitive" aria-label="Competitive"><Svg d={ICO.trophy} /></AppLink>
            </Show>
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
              <AppLink to="/profile" title="Profile" aria-label="Profile"><Svg d={ICO.profile} /></AppLink>
            </Show>
            <span class="cart-anchor">
              <AppLink class="cart-chip" to="/cart" aria-label={`Cart, ${cartCount()} items`}>
                <Svg d={ICO.cart} />
                <em>{cartCount()}</em>
              </AppLink>
            </span>
          </nav>
        </div>
      </header>
      <main>{props.children}</main>
      <Footer />
    </div>
  );
}

function Footer() {
  const pokemon = isPokemonGame();
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
          <Show when={pokemon}>
            <AppLink to="/marketplace/en/pokemon">Pokémon</AppLink>
            <AppLink to="/marketplace/en/artists">Artists</AppLink>
          </Show>
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
        </div>
        <div>
          <h3>More</h3>
          <a href={marketUrl('/')}>Home</a>
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
