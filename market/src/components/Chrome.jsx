import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  cardFromAutocomplete,
  cardHref,
  fetchAutocomplete,
  imageSrc,
} from '../api.js';
import { printingIdentity } from '../identity.js';
import { Action, track } from '../track.js';
import { useAuth } from '../auth.jsx';
import { FLUTTER, authFrom } from '../punchouts.js';

export default function Chrome({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { signedIn } = useAuth();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [hits, setHits] = useState([]);
  const box = useRef(null);

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
      setHits([]);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchAutocomplete(term, { limit: 8, signal: controller.signal })
        .then((data) => {
          setHits((data.rows || []).map(cardFromAutocomplete).filter((card) => card.id));
        })
        .catch((error) => {
          if (error.name !== 'AbortError') {
            setHits([]);
          }
        });
    }, 280);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    function onDoc(event) {
      if (box.current && !box.current.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function goSearch(event) {
    event.preventDefault();
    const next = query.trim();
    setOpen(false);
    setMenu(false);
    navigate(next ? `/marketplace/search?q=${encodeURIComponent(next)}` : '/marketplace/search');
  }

  function pick(card, rank) {
    setOpen(false);
    setQuery(card.name || '');
    track(Action.clickSuggest, card, { query, resultRank: rank });
    navigate(cardHref(card));
  }

  function closeMenu() {
    setMenu(false);
  }

  const from = authFrom(location.pathname || '/marketplace');

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-row">
          <button className="burger" type="button" aria-label="Menu" onClick={() => setMenu((v) => !v)}>
            <span /><span /><span />
          </button>
          <Link className="brand" to="/marketplace" aria-label="Pokoin marketplace">
            <img src="/home/logo.png" alt="" width="40" height="40" />
            <span>Pokoin</span>
          </Link>
          <form className="search" onSubmit={goSearch} role="search" ref={box}>
            <label className="sr-only" htmlFor="market-search">Search cards</label>
            <div className="search-pill">
              <input
                id="market-search"
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                placeholder="Search cards, sets, products..."
                autoComplete="off"
              />
              <button type="submit" aria-label="Search">
                <span className="search-go-text">Search</span>
                <svg className="search-go-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
                </svg>
              </button>
            </div>
            {open && hits.length ? (
              <ul className="suggest" role="listbox">
                {hits.map((card, index) => (
                  <li key={card.id}>
                    <button type="button" onClick={() => pick(card, index)}>
                      {imageSrc(card, 'suggest') ? (
                        <img src={imageSrc(card, 'suggest')} alt="" />
                      ) : <span className="suggest-ph" />}
                      <span>
                        <strong>{card.name}</strong>
                        <em>{printingIdentity(card).suggestLine}</em>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </form>
          <nav className="nav icon-nav" aria-label="Marketplace">
            <span className="lang-flag" title="English" aria-label="English">🇬🇧</span>
            <a href="/" title="Home" aria-label="Home">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" /></svg>
            </a>
            <a href={FLUTTER.forum} title="Forum" aria-label="Forum">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" /></svg>
            </a>
            <a href={FLUTTER.signal} title="Signal" aria-label="Signal">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z" /></svg>
            </a>
            <a className="trophy" href={FLUTTER.competitive} title="Competitive" aria-label="Competitive">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94A5.01 5.01 0 0 0 11 17.9V19H7v2h10v-2h-4v-1.1a5.01 5.01 0 0 0 3.61-4.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z" /></svg>
            </a>
            <a className="pkn-chip" href={FLUTTER.wallet} title="Wallet">0 PKN</a>
            <a href={signedIn ? FLUTTER.profile : from} title={signedIn ? 'Profile' : 'Sign in'} aria-label={signedIn ? 'Profile' : 'Sign in'}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" /></svg>
            </a>
            <a className="cart-chip" href={FLUTTER.cart} title="Cart" aria-label="Cart, 0 items">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1 1 0 0 0 20 4H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z" /></svg>
              <em>0</em>
            </a>
          </nav>
        </div>
        <div className={`mobile-panel ${menu ? 'on' : ''}`}>
          <Link to="/marketplace" onClick={closeMenu}>Marketplace</Link>
          <Link to="/marketplace/search" onClick={closeMenu}>Search</Link>
          <a href="/" onClick={closeMenu}>Home</a>
          <a href={FLUTTER.forum} onClick={closeMenu}>Forum</a>
          <a href={FLUTTER.signal} onClick={closeMenu}>Signal</a>
          <a href={FLUTTER.competitive} onClick={closeMenu}>Competitive</a>
          <a href={FLUTTER.wallet} onClick={closeMenu}>Wallet</a>
          <a href={FLUTTER.cart} onClick={closeMenu}>Cart</a>
          <a href={FLUTTER.profile} onClick={closeMenu}>Profile</a>
          {signedIn ? null : <a href={from} onClick={closeMenu}>Sign in</a>}
        </div>
      </header>
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
          </div>
          <div>
            <h3>Account</h3>
            <a href={FLUTTER.wallet}>Wallet</a>
            <a href={FLUTTER.cart}>Cart</a>
            <a href={FLUTTER.profile}>Profile</a>
            {signedIn ? null : <a href={from}>Sign in</a>}
          </div>
          <div>
            <h3>More</h3>
            <a href="/">Home</a>
            <a href={FLUTTER.forum}>Forum</a>
            <a href={FLUTTER.signal}>Signal</a>
            <a href={FLUTTER.docs}>Docs</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
