import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  cardFromAutocomplete,
  cardHref,
  fetchSuggest,
  imageSrc,
  versionsHref,
} from '../api.js';
import { game } from '../game.js';
import { printingIdentity, setAbbrev, suggestKind } from '../identity.js';
import { Action, track } from '../track.js';
import { useAuth } from '../auth.jsx';
import { APP, authFrom } from '../punchouts.js';
import { useCart } from '../cart.jsx';
import { useWallet } from '../wallet.jsx';
import CardArt from './CardArt.jsx';
import {
  SEARCH_LANGS,
  flagSrc,
  langMeta,
  rewriteCatalogLang,
  searchLangFromPath,
  setSearchLang,
  useSearchLang,
} from '../locale.js';

function Icon({ d }) {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <path fill="currentColor" d={d} />
    </svg>
  );
}

const ICO = {
  market: 'M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zm-9 4H6v-4h6v4z',
  search: 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  forum: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z',
  signal: 'M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z',
  trophy: 'M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94A5.01 5.01 0 0 0 11 17.9V19H7v2h10v-2h-4v-1.1a5.01 5.01 0 0 0 3.61-4.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z',
  explore: 'M12 10.9c-.61 0-1.1.49-1.1 1.1s.49 1.1 1.1 1.1 1.1-.49 1.1-1.1-.49-1.1-1.1-1.1zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm2.19 12.19L6 18l3.81-8.19L18 6l-3.81 8.19z',
  portfolio: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  sets: 'M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z',
  watch: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  wallet: 'M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2 .9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z',
  buy: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09V20h-2.67v-1.93c-1.71-.36-3.16-1.46-3.27-3.4h1.96c.1.93.7 1.64 2.04 1.64 1.51 0 2.1-.78 2.1-1.62 0-.85-.44-1.42-2.32-1.87-2.57-.62-3.45-1.78-3.45-3.4 0-1.77 1.35-2.97 3.18-3.36V5h2.67v1.7c1.82.39 2.96 1.66 3.08 3.38h-1.9c-.1-.87-.69-1.52-1.9-1.52-1.32 0-1.9.68-1.9 1.49 0 .76.47 1.23 2.36 1.7 2.53.63 3.5 1.84 3.5 3.61 0 1.95-1.57 3.16-3.31 3.73z',
  cart: 'M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1 1 0 0 0 20 4H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z',
  checkout: 'M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
  orders: 'M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z',
  nft: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  profile: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  signin: 'M11 7L9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z',
  admin: 'M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z',
};

function MobileTile({ to, href, label, icon, onClick }) {
  const body = (
    <>
      <Icon d={ICO[icon]} />
      <span>{label}</span>
    </>
  );
  if (href) {
    return <a className="mobile-tile" href={href} onClick={onClick}>{body}</a>;
  }
  return (
    <NavLink
      className={({ isActive }) => `mobile-tile${isActive ? ' is-active' : ''}`}
      to={to}
      onClick={onClick}
    >
      {body}
    </NavLink>
  );
}

function LangToggle() {
  const lang = useSearchLang();
  const current = langMeta(lang);
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const fromPath = searchLangFromPath(location.pathname);
    if (fromPath) {
      setSearchLang(fromPath);
    }
  }, [location.pathname]);

  useEffect(() => {
    function onDoc(event) {
      if (box.current && !box.current.contains(event.target)) {
        setOpen(false);
      }
    }
    function onKey(event) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  function pick(code) {
    setSearchLang(code);
    setOpen(false);
    const nextPath = rewriteCatalogLang(location.pathname, code);
    if (nextPath !== location.pathname) {
      navigate(`${nextPath}${location.search || ''}`);
    }
  }

  return (
    <div className="lang-toggle" ref={box}>
      <button
        type="button"
        aria-label={`Search language, ${current.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current.label}
        onClick={() => setOpen((value) => !value)}
      >
        <img src={flagSrc(current.code)} alt="" width="28" height="28" />
      </button>
      {open ? (
        <ul className="lang-menu" role="listbox" aria-label="Search language">
          {SEARCH_LANGS.map((item) => (
            <li key={item.code} role="option" aria-selected={item.code === lang}>
              <button type="button" className={item.code === lang ? 'is-active' : ''} onClick={() => pick(item.code)}>
                <img src={flagSrc(item.code)} alt="" width="22" height="22" />
                <span>{item.label}</span>
                <em>{item.code.toUpperCase()}</em>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function flattenPrintings(groups) {
  const rows = [];
  groups.forEach((group, groupIndex) => {
    (group.printings || []).forEach((card, printingIndex) => {
      rows.push({
        card,
        group,
        groupIndex,
        printingIndex,
        optionId: `suggest-${card.id}`,
      });
    });
  });
  return rows;
}

export default function Chrome({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { signedIn, admin } = useAuth();
  const { count } = useCart();
  const { balance } = useWallet();
  const lang = useSearchLang();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [groups, setGroups] = useState([]);
  const [hitCount, setHitCount] = useState(0);
  const [pending, setPending] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const box = useRef(null);
  const inputRef = useRef(null);
  const flat = flattenPrintings(groups);
  const activeOption = activeIndex >= 0 ? flat[activeIndex] : null;

  useEffect(() => {
    const q = new URLSearchParams(location.search).get('q');
    if (location.pathname === '/marketplace/search' && q) {
      setQuery(q);
    }
  }, [location.pathname, location.search]);

  useLayoutEffect(() => {
    window.history.scrollRestoration = 'manual';
  }, []);

  useLayoutEffect(() => {
    if (location.hash) {
      return;
    }
    window.scrollTo(0, 0);
  }, [location.key]);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setPending(false);
      if (!term) {
        setGroups([]);
        setHitCount(0);
        setActiveIndex(-1);
      }
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPending(true);
      fetchSuggest(term, { limit: 12, signal: controller.signal, lang })
        .then((data) => {
          setGroups(Array.isArray(data.groups) ? data.groups : []);
          setHitCount(Number(data.count) || 0);
          setActiveIndex(-1);
        })
        .catch((error) => {
          if (error.name !== 'AbortError') {
            setActiveIndex(-1);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setPending(false);
          }
        });
    }, 120);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, lang]);

  useEffect(() => {
    function onDoc(event) {
      if (box.current && !box.current.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    setMenu(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!menu) {
      return undefined;
    }
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKey(event) {
      if (event.key === 'Escape') {
        setMenu(false);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  function goSearch(event) {
    event?.preventDefault?.();
    const next = query.trim();
    setOpen(false);
    setMenu(false);
    navigate(next ? `/marketplace/search?q=${encodeURIComponent(next)}` : '/marketplace/search');
  }

  function pick(card, rank) {
    const mapped = cardFromAutocomplete(card);
    setOpen(false);
    setQuery(mapped.name || '');
    track(Action.clickSuggest, mapped, { query, resultRank: rank });
    navigate(cardHref(mapped));
  }

  function onSearchKeyDown(event) {
    if (!open) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, flat.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, -1));
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (event.key === 'Enter' && activeOption) {
      event.preventDefault();
      pick(activeOption.card, activeIndex);
    }
  }

  function closeMenu() {
    setMenu(false);
  }

  const returnPath = location.pathname.startsWith('/auth')
    ? (new URLSearchParams(location.search).get('from') || '/marketplace')
    : `${location.pathname || '/marketplace'}${location.search || ''}`;
  const from = authFrom(returnPath);
  const pknLabel = `${Number.isFinite(balance) ? balance.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '0'} PKN`;
  const site = game();
  const homeHref = site.homeHref || '/';

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-row">
          <button
            className="burger"
            type="button"
            aria-label="Menu"
            aria-expanded={menu}
            aria-controls="mobile-menu"
            onClick={() => setMenu((v) => !v)}
          >
            <span /><span /><span />
          </button>
          <Link className="brand" to="/marketplace" aria-label={site.title}>
            <img src="/home/logo.png" alt="" width="40" height="40" />
            <span>{site.brand}</span>
          </Link>
          <form className="search" onSubmit={goSearch} role="search" ref={box}>
            <label className="sr-only" htmlFor="market-search">Search cards</label>
            <div className="search-pill">
              <input
                ref={inputRef}
                id="market-search"
                type="search"
                role="combobox"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onKeyDown={onSearchKeyDown}
                placeholder="Search cards, sets, products..."
                autoComplete="off"
                aria-expanded={open && (groups.length > 0 || pending)}
                aria-controls="market-suggest"
                aria-activedescendant={activeOption ? activeOption.optionId : undefined}
                aria-autocomplete="list"
                aria-busy={pending}
              />
              <button type="submit" aria-label="Search">
                <svg className="search-go-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                  <path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
                </svg>
              </button>
            </div>
            {open && (groups.length || pending) ? (
              <div className="suggest" id="market-suggest">
                {pending ? <div className="suggest-pending" aria-hidden="true" /> : null}
                <ul role="listbox" aria-label="Card suggestions">
                  {groups.map((group) => {
                    const versionCount = (group.printings || []).length;
                    return (
                      <li key={group.name} className="suggest-group">
                        <ul>
                          {(group.printings || []).map((printing) => {
                            const card = cardFromAutocomplete(printing);
                            const identity = printingIdentity(card);
                            const optionId = `suggest-${card.id}`;
                            const active = activeOption?.optionId === optionId;
                            const thumb = imageSrc(card, 'suggest');
                            const mark = setAbbrev(identity.set);
                            const kind = suggestKind(card);
                            return (
                              <li key={card.id} role="option" id={optionId} aria-selected={active}>
                                <div className={`suggest-row${active ? ' is-active' : ''}`}>
                                  <button
                                    type="button"
                                    className="suggest-main"
                                    onClick={() => pick(card, flat.findIndex((row) => row.optionId === optionId))}
                                  >
                                    <span className="suggest-set" aria-hidden="true">{mark || '●'}</span>
                                    {thumb ? <CardArt src={thumb} alt="" /> : <span className="suggest-ph" />}
                                    <span className="suggest-copy">
                                      <strong>{identity.suggestTitle || card.name}</strong>
                                      {identity.suggestExpansion ? <em>{identity.suggestExpansion}</em> : null}
                                    </span>
                                  </button>
                                  <div className="suggest-meta">
                                    <span className="suggest-kind">{kind}</span>
                                    {versionCount > 1 ? (
                                      <Link
                                        className="suggest-versions"
                                        to={versionsHref(card)}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setOpen(false);
                                        }}
                                      >
                                        View all {versionCount} versions
                                      </Link>
                                    ) : null}
                                  </div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
                {query.trim().length >= 2 ? (
                  <button className="suggest-all" type="submit">
                    {hitCount > 0
                      ? `View all ${hitCount} results`
                      : `View all results for “${query.trim()}”`}
                  </button>
                ) : null}
              </div>
            ) : null}
          </form>
          <LangToggle />
          <nav className="nav icon-nav" aria-label="Marketplace">
            <a href={homeHref} title="Home" aria-label="Home">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" /></svg>
            </a>
            <NavLink to="/forum" title="Forum" aria-label="Forum">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" /></svg>
            </NavLink>
            <NavLink to="/marketplace/signal" title="Signal" aria-label="Signal">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z" /></svg>
            </NavLink>
            {site.features.competitive ? (
              <NavLink className="trophy" to="/marketplace/competitive" title="Competitive" aria-label="Competitive">
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94A5.01 5.01 0 0 0 11 17.9V19H7v2h10v-2h-4v-1.1a5.01 5.01 0 0 0 3.61-4.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z" /></svg>
              </NavLink>
            ) : null}
            <NavLink className="pkn-chip" to="/wallet" title="Wallet">{pknLabel}</NavLink>
            <NavLink to={signedIn ? '/profile' : from} title={signedIn ? 'Profile' : 'Sign in'} aria-label={signedIn ? 'Profile' : 'Sign in'}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" /></svg>
            </NavLink>
            <NavLink className="cart-chip" to="/cart" title="Cart" aria-label={`Cart, ${count} items`}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1 1 0 0 0 20 4H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z" /></svg>
              <em>{count}</em>
            </NavLink>
          </nav>
        </div>
      </header>
      <button
        className={`mobile-scrim ${menu ? 'on' : ''}`}
        type="button"
        tabIndex={menu ? 0 : -1}
        aria-label="Close menu"
        onClick={closeMenu}
      />
      <nav id="mobile-menu" className={`mobile-panel ${menu ? 'on' : ''}`} aria-label="Menu" aria-hidden={!menu}>
        <MobileTile to="/marketplace" label="Marketplace" icon="market" onClick={closeMenu} />
        <MobileTile to="/marketplace/search" label="Search" icon="search" onClick={closeMenu} />
        <MobileTile href={homeHref} label="Home" icon="home" onClick={closeMenu} />
        <MobileTile to={APP.forum} label="Forum" icon="forum" onClick={closeMenu} />
        <MobileTile to={APP.signal} label="Signal" icon="signal" onClick={closeMenu} />
        {site.features.competitive ? (
          <MobileTile to="/marketplace/competitive" label="Competitive" icon="trophy" onClick={closeMenu} />
        ) : null}
        <MobileTile to="/marketplace/explore" label="Explore" icon="explore" onClick={closeMenu} />
        <MobileTile to="/marketplace/portfolio" label="Portfolio" icon="portfolio" onClick={closeMenu} />
        <MobileTile to="/marketplace/sets" label="Sets" icon="sets" onClick={closeMenu} />
        <MobileTile to="/marketplace/watchlist" label="Watchlist" icon="watch" onClick={closeMenu} />
        <MobileTile to={APP.wallet} label="Wallet" icon="wallet" onClick={closeMenu} />
        <MobileTile to={APP.buy} label="Buy PKN" icon="buy" onClick={closeMenu} />
        <MobileTile to={APP.cart} label="Cart" icon="cart" onClick={closeMenu} />
        <MobileTile to="/checkout" label="Checkout" icon="checkout" onClick={closeMenu} />
        <MobileTile to="/orders" label="Orders" icon="orders" onClick={closeMenu} />
        <MobileTile to="/nft" label="NFT" icon="nft" onClick={closeMenu} />
        <MobileTile to={APP.profile} label="Profile" icon="profile" onClick={closeMenu} />
        {admin ? <MobileTile to={APP.admin} label="Admin" icon="admin" onClick={closeMenu} /> : null}
        {signedIn ? null : <MobileTile to={from} label="Sign in" icon="signin" onClick={closeMenu} />}
      </nav>
      <main>{children}</main>
      <footer className="foot">
        <div className="foot-grid">
          <div>
            <strong>Pokoin</strong>
            <p>Buy. Sell. Settle in PKN. Catalog identity is the public card id — never divide it.</p>
          </div>
          <div>
            <h3>Shop</h3>
            <Link to="/marketplace">Marketplace</Link>
            <Link to="/marketplace/search">Search</Link>
            <Link to="/marketplace/competitive">Competitive</Link>
            <Link to="/marketplace/explore">Explore</Link>
            <Link to="/marketplace/portfolio">Portfolio</Link>
            <Link to="/marketplace/sets">Sets</Link>
            <Link to="/marketplace/watchlist">Watchlist</Link>
          </div>
          <div>
            <h3>Account</h3>
            <Link to={APP.wallet}>Wallet</Link>
            <Link to={APP.buy}>Buy PKN</Link>
            <Link to={APP.cart}>Cart</Link>
            <Link to="/checkout">Checkout</Link>
            <Link to="/orders">Orders</Link>
            <Link to="/nft">NFT</Link>
            <Link to={APP.profile}>Profile</Link>
            {admin ? <Link to={APP.admin}>Admin</Link> : null}
            {signedIn ? null : <Link to={from}>Sign in</Link>}
          </div>
          <div>
            <h3>More</h3>
            <a href="/">Home</a>
            <Link to={APP.forum}>Forum</Link>
            <Link to={APP.signal}>Signal</Link>
            <Link to={APP.docs}>Docs</Link>
            <Link to={APP.scan}>Scan</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
