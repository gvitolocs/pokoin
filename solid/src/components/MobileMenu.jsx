import { For, Show, untrack } from 'solid-js';
import { useLinkState } from '@solidjs/router';
import { accountHeading } from '@market/auth-session.js';
import { catalogLinks } from '@market/catalog-links.js';
import { authAnchorRel, marketUrl } from '@market/punchouts.js';
import Avatar from './Avatar.jsx';

// Phone drawer behind the burger (market/src/components/MobileMenu.jsx):
// account card, four quick actions, then grouped lists (Shop / Catalog /
// Account). Its own chunk: Chrome imports it on the first burger press and
// keeps it mounted after that so the slide transition still plays.

/** Drawer icon paths (market/src/components/Chrome.jsx ICO, passed as `ico` there). */
const ICO = {
  market: 'M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zm-9 4H6v-4h6v4z',
  search: 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  forum: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z',
  cart: 'M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1 1 0 0 0 20 4H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z',
  wallet: 'M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2 .9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z',
  explore: 'M12 10.9c-.61 0-1.1.49-1.1 1.1s.49 1.1 1.1 1.1 1.1-.49 1.1-1.1-.49-1.1-1.1-1.1zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm2.19 12.19L6 18l3.81-8.19L18 6l-3.81 8.19z',
  trophy: 'M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94A5.01 5.01 0 0 0 11 17.9V19H7v2h10v-2h-4v-1.1a5.01 5.01 0 0 0 3.61-4.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z',
  portfolio: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  watch: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  dashboard: 'M6 3h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm8 0h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM6 14h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zm8 0h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z',
  orders: 'M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z',
  nft: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  buy: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09V20h-2.67v-1.93c-1.71-.36-3.16-1.46-3.27-3.4h1.96c.1.93.7 1.64 2.04 1.64 1.51 0 2.1-.78 2.1-1.62 0-.85-.44-1.42-2.32-1.87-2.57-.62-3.45-1.78-3.45-3.4 0-1.77 1.35-2.97 3.18-3.36V5h2.67v1.7c1.82.39 2.96 1.66 3.08 3.38h-1.9c-.1-.87-.69-1.52-1.9-1.52-1.32 0-1.9.68-1.9 1.49 0 .76.47 1.23 2.36 1.7 2.53.63 3.5 1.84 3.5 3.61 0 1.95-1.57 3.16-3.31 3.73z',
  profile: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  admin: 'M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z',
};

function Glyph(props) {
  return (
    <svg viewBox="0 0 24 24" width={props.size ?? 20} height={props.size ?? 20} aria-hidden="true">
      <path fill="currentColor" d={props.d} />
    </svg>
  );
}

/**
 * Same-origin router anchor with NavLink's `is-active`, or an absolute <a>
 * off-host. A plain `href` (Home → the landing page) stays a full page load
 * as in React: target="_self" keeps the router from claiming it.
 */
function MenuLink(props) {
  const target = () => props.href || (props.to ? marketUrl(props.to) : '');
  const external = () => Boolean(props.href) || String(target()).startsWith('http');
  const rel = () => [props.rel, authAnchorRel(props.to || props.href)].filter(Boolean).join(' ') || undefined;
  const link = useLinkState(() => (external() ? '' : target()), { end: untrack(() => props.to === '/marketplace') });
  return (
    <a
      class={[props.class, { 'is-active': !external() && link.active() }]}
      href={target()}
      rel={rel()}
      target={props.href ? '_self' : undefined}
      onClick={() => props.onClick?.()}
    >
      {props.children}
    </a>
  );
}

function Row(props) {
  return (
    <li>
      <MenuLink class="mm-row" to={props.to} onClick={props.onClose}>
        <span class="mm-row-icon"><Glyph d={props.icon} /></span>
        <span class="mm-row-label">{props.label}</span>
        <Show when={props.meta}><span class="mm-row-meta">{props.meta}</span></Show>
        <svg class="mm-row-chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M9.3 6.3 8 7.6 12.6 12 8 16.4l1.3 1.3 6-5.7z" />
        </svg>
      </MenuLink>
    </li>
  );
}

function Quick(props) {
  return (
    <MenuLink class="mm-quick" to={props.to} onClick={props.onClose}>
      <span class="mm-quick-icon">
        <Glyph d={props.icon} size={22} />
        <Show when={props.badge}><em class="mm-quick-badge">{props.badge}</em></Show>
        <Show when={props.dot}><i class="mm-quick-dot" aria-hidden="true" /></Show>
      </span>
      <span>{props.label}</span>
    </MenuLink>
  );
}

export default function MobileMenu(props) {
  const name = () => accountHeading(props.user, props.profile) || 'Your account';
  const handle = () => (props.profile?.username ? `@${props.profile.username}` : (props.user?.email || ''));
  const catalog = () => (props.pokemon !== false
    ? catalogLinks(props.lang || 'en')
    : [{ to: '/marketplace/sets', label: 'Sets' }]);
  const close = () => props.onClose?.();

  return (
    <nav id="mobile-menu" class={['mobile-panel', { on: props.open }]} aria-label="Menu" aria-hidden={props.open ? 'false' : 'true'}>
      <Show
        when={props.signedIn}
        fallback={(
          <div class="mm-account is-guest">
            <span class="mm-account-text">
              <strong>Welcome to Pokoin</strong>
              <span>Sign in to buy, sell and chat.</span>
            </span>
            <MenuLink class="btn mm-signin" to={props.signInTo} onClick={close}>Sign in</MenuLink>
          </div>
        )}
      >
        <MenuLink class="mm-account" to={props.paths.profile} onClick={close}>
          <Avatar
            src={props.profile?.photoUrl}
            seed={props.profile?.uid || props.user?.uid}
            name={name()}
            size={44}
            silver={props.silver}
            variant="chip"
          />
          <span class="mm-account-text">
            <strong>{name()}</strong>
            <span>{handle()}{props.silver ? ' · Silver' : ''}</span>
          </span>
          <span class="mm-account-pkn">{props.pknLabel}</span>
        </MenuLink>
      </Show>

      <div class="mm-quick-row">
        <Quick to="/marketplace/search" icon={ICO.search} label="Search" onClose={close} />
        <Quick to={props.paths.messages} icon={ICO.forum} label="Messages" dot={props.messagesUnread > 0} onClose={close} />
        <Quick to={props.paths.cart} icon={ICO.cart} label="Cart" badge={props.cartCount > 0 ? String(props.cartCount) : ''} onClose={close} />
        <Quick to={props.paths.wallet} icon={ICO.wallet} label="Wallet" onClose={close} />
      </div>

      <section class="mm-group" aria-labelledby="mm-shop">
        <h2 id="mm-shop">Shop</h2>
        <ul>
          <Row to="/marketplace" icon={ICO.market} label="Marketplace" onClose={close} />
          <Row to="/marketplace/explore" icon={ICO.explore} label="Explore" onClose={close} />
          <Show when={props.competitive}>
            <Row to="/marketplace/competitive" icon={ICO.trophy} label="Competitive" onClose={close} />
          </Show>
          <Row to="/marketplace/portfolio" icon={ICO.portfolio} label="Portfolio" onClose={close} />
          <Row to="/marketplace/watchlist" icon={ICO.watch} label="Watchlist" onClose={close} />
        </ul>
      </section>

      <section class="mm-group" aria-labelledby="mm-catalog">
        <h2 id="mm-catalog">Catalog</h2>
        <div class="mm-chips">
          <For each={catalog()}>
            {(row) => <MenuLink class="mm-chip" to={row.to} onClick={close}>{row.label}</MenuLink>}
          </For>
        </div>
      </section>

      <section class="mm-group" aria-labelledby="mm-account">
        <h2 id="mm-account">Account</h2>
        <ul>
          <Row to={props.paths.dashboard} icon={ICO.dashboard} label="Dashboard" onClose={close} />
          <Row to="/orders" icon={ICO.orders} label="Orders" onClose={close} />
          <Row to="/mypokoin/collection" icon={ICO.nft} label="Collection" onClose={close} />
          <Row to={props.paths.buy} icon={ICO.buy} label="Buy PKN" onClose={close} />
          <Show when={props.signedIn}>
            <Row to={props.paths.profile} icon={ICO.profile} label="Profile" onClose={close} />
          </Show>
          <Show when={props.admin}>
            <Row to={props.paths.admin} icon={ICO.admin} label="Admin" onClose={close} />
          </Show>
        </ul>
      </section>

      <footer class="mm-foot">
        <MenuLink class="mm-foot-link" href={props.homeHref} onClick={close}>Home</MenuLink>
        <MenuLink class="mm-foot-link" to={props.paths.forum} onClick={close}>Forum</MenuLink>
        <MenuLink class="mm-foot-link" to="/sitemap" onClick={close}>Site map</MenuLink>
        <MenuLink class="mm-foot-link" to={props.paths.protection} onClick={close}>Buyer protection</MenuLink>
      </footer>
    </nav>
  );
}
