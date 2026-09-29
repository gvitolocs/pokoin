import { NavLink } from 'react-router-dom';
import { marketUrl } from '../punchouts.js';
import { accountHeading } from '../auth-session.js';
import { catalogLinks } from './CatalogHubs.jsx';
import Avatar from './Avatar.jsx';

// Phone drawer behind the burger: account card, four quick actions, then
// grouped lists (Shop / Catalog / Account) instead of a wall of equal tiles.

function Glyph({ d, size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path fill="currentColor" d={d} />
    </svg>
  );
}

/** Same-origin NavLink, or an absolute <a> when the SPA is on another host. */
function MenuLink({ to, href, className, onClick, children, ...rest }) {
  const external = href || (to ? marketUrl(to) : '');
  if (href || (to && String(external).startsWith('http'))) {
    return <a className={className} href={external} onClick={onClick} {...rest}>{children}</a>;
  }
  return (
    <NavLink
      className={({ isActive }) => `${className}${isActive ? ' is-active' : ''}`}
      to={to}
      end={to === '/marketplace'}
      onClick={onClick}
      {...rest}
    >
      {children}
    </NavLink>
  );
}

function Row({ icon, label, meta, onClose, ...link }) {
  return (
    <li>
      <MenuLink className="mm-row" onClick={onClose} {...link}>
        <span className="mm-row-icon"><Glyph d={icon} /></span>
        <span className="mm-row-label">{label}</span>
        {meta ? <span className="mm-row-meta">{meta}</span> : null}
        <svg className="mm-row-chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M9.3 6.3 8 7.6 12.6 12 8 16.4l1.3 1.3 6-5.7z" />
        </svg>
      </MenuLink>
    </li>
  );
}

function Quick({ icon, label, badge, dot, onClose, ...link }) {
  return (
    <MenuLink className="mm-quick" onClick={onClose} {...link}>
      <span className="mm-quick-icon">
        <Glyph d={icon} size={22} />
        {badge ? <em className="mm-quick-badge">{badge}</em> : null}
        {dot ? <i className="mm-quick-dot" aria-hidden="true" /> : null}
      </span>
      <span>{label}</span>
    </MenuLink>
  );
}

export default function MobileMenu({
  open,
  onClose,
  ico,
  lang = 'en',
  pokemon = true,
  competitive = false,
  signedIn = false,
  admin = false,
  profile = null,
  user = null,
  silver = false,
  pknLabel = '',
  cartCount = 0,
  messagesUnread = 0,
  signInTo = '/auth',
  homeHref = '/',
  paths,
}) {
  const name = accountHeading(user, profile) || 'Your account';
  const handle = profile?.username ? `@${profile.username}` : (user?.email || '');
  const catalog = pokemon
    ? catalogLinks(lang)
    : [{ to: '/marketplace/sets', label: 'Sets' }];

  return (
    <nav id="mobile-menu" className={`mobile-panel ${open ? 'on' : ''}`} aria-label="Menu" aria-hidden={!open}>
      {signedIn ? (
        <MenuLink className="mm-account" to={paths.profile} onClick={onClose}>
          <Avatar src={profile?.photoUrl} seed={profile?.uid || user?.uid} name={name} size={44} silver={silver} variant="chip" />
          <span className="mm-account-text">
            <strong>{name}</strong>
            <span>{handle}{silver ? ' · Silver' : ''}</span>
          </span>
          <span className="mm-account-pkn">{pknLabel}</span>
        </MenuLink>
      ) : (
        <div className="mm-account is-guest">
          <span className="mm-account-text">
            <strong>Welcome to Pokoin</strong>
            <span>Sign in to buy, sell and chat.</span>
          </span>
          <MenuLink className="btn mm-signin" to={signInTo} onClick={onClose}>Sign in</MenuLink>
        </div>
      )}

      <div className="mm-quick-row">
        <Quick to="/marketplace/search" icon={ico.search} label="Search" onClose={onClose} />
        <Quick to={paths.messages} icon={ico.forum} label="Messages" dot={messagesUnread > 0} onClose={onClose} />
        <Quick to={paths.cart} icon={ico.cart} label="Cart" badge={cartCount > 0 ? String(cartCount) : ''} onClose={onClose} />
        <Quick to={paths.wallet} icon={ico.wallet} label="Wallet" onClose={onClose} />
      </div>

      <section className="mm-group" aria-labelledby="mm-shop">
        <h2 id="mm-shop">Shop</h2>
        <ul>
          <Row to="/marketplace" icon={ico.market} label="Marketplace" onClose={onClose} />
          <Row to="/marketplace/explore" icon={ico.explore} label="Explore" onClose={onClose} />
          {competitive ? <Row to="/marketplace/competitive" icon={ico.trophy} label="Competitive" onClose={onClose} /> : null}
          <Row to="/marketplace/portfolio" icon={ico.portfolio} label="Portfolio" onClose={onClose} />
          <Row to="/marketplace/watchlist" icon={ico.watch} label="Watchlist" onClose={onClose} />
        </ul>
      </section>

      <section className="mm-group" aria-labelledby="mm-catalog">
        <h2 id="mm-catalog">Catalog</h2>
        <div className="mm-chips">
          {catalog.map((row) => (
            <MenuLink key={row.to} className="mm-chip" to={row.to} onClick={onClose}>{row.label}</MenuLink>
          ))}
        </div>
      </section>

      <section className="mm-group" aria-labelledby="mm-account">
        <h2 id="mm-account">Account</h2>
        <ul>
          <Row to={paths.dashboard} icon={ico.dashboard} label="Dashboard" onClose={onClose} />
          <Row to="/orders" icon={ico.orders} label="Orders" onClose={onClose} />
          <Row to="/collection" icon={ico.nft} label="Collection" onClose={onClose} />
          <Row to={paths.buy} icon={ico.buy} label="Buy PKN" onClose={onClose} />
          {signedIn ? <Row to={paths.profile} icon={ico.profile} label="Profile" onClose={onClose} /> : null}
          {admin ? <Row to={paths.admin} icon={ico.admin} label="Admin" onClose={onClose} /> : null}
        </ul>
      </section>

      <footer className="mm-foot">
        <MenuLink className="mm-foot-link" href={homeHref} onClick={onClose}>Home</MenuLink>
        <MenuLink className="mm-foot-link" to={paths.forum} onClick={onClose}>Forum</MenuLink>
        <MenuLink className="mm-foot-link" to="/sitemap" onClick={onClose}>Site map</MenuLink>
        <MenuLink className="mm-foot-link" to={paths.protection} onClick={onClose}>Buyer protection</MenuLink>
      </footer>
    </nav>
  );
}
