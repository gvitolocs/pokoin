import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useWindowScrollRestore } from '../scroll-restore.js';
import {
  cardFromAutocomplete,
  cardHref,
  fetchArtist,
  fetchExpansion,
  fetchSearch,
  fetchSellerByUsername,
  fetchSuggest,
  formatPknNumber,
  imageSrc,
  warmupCard,
} from '../api.js';
import { resolveArtLayout } from '../art-cut.js';
import { pickSuggestHoverSrc, suggestHoverAllowed, suggestHoverBox } from '../suggest-hover.js';
import { fetchSuggestRanked, rankConcurrency, rankNames, resolveSearchQuery, typedMeiliQuery } from '../suggest-rank.js';
import { rankChunkOnWorker, warmupSuggestRankWorkers } from '../suggest-rank-runtime.js';
import { useSuggestFlip } from '../suggest-flip.js';
import {
  cachedPrintings,
  isLiveStub,
  liveSuggestGroups,
  rememberPrintings,
  rememberSuggestGroups,
  suggestLiveReady,
} from '../suggest-live.js';
import { catalogCacheKey, catalogIntent, groupsFromCards } from '../suggest-catalog.js';
import { resolveSuggestQuery, serializeResolution } from '../suggest-resolve.js';
import {
  SUGGEST_THUMB_EAGER,
  SUGGEST_THUMB_HIGH,
  collectPrintingThumbUrls,
  preloadSuggestThumbs,
} from '../suggest-images.js';
import { prefetchSearchPage } from '../search-hot.js';
import { game, isPokemonGame } from '../game.js';
import { printingIdentity, clipSuggestCollector, suggestCardName, suggestTranslatedLine } from '../identity.js';
import { normalizeSearchTab, searchHref, uniqueSellers } from '../search-kind.js';
import { sellerHref } from '../listing-meta.js';
import CatalogMenu from './CatalogHubs.jsx';
import ExpansionMark from './ExpansionMark.jsx';
import SearchTabs from './SearchTabs.jsx';
import { Action, track } from '../track.js';
import { useAuth } from '../auth.jsx';
import { framedByChromeExtension } from '../extension-auth-bridge.js';
import { APP, DASHBOARD_HOME, authFrom, goMarket, marketUrl } from '../punchouts.js';
import { isDashboardHost } from '../scan-api.js';
import { useCart } from '../cart.jsx';
import { useWallet } from '../wallet.jsx';
import { listConversations } from '../chat-client.js';
import { MESSAGES_UNREAD_EVENT, MESSAGES_UNREAD_REFRESH_MS, unreadMessagesCount } from '../messages-unread.js';
import CardArt from './CardArt.jsx';
import {
  PRINT_LANGS,
  SEARCH_LANGS,
  flagSrc,
  langMeta,
  printFlagFromNationality,
  printLangMeta,
  rewriteCatalogLang,
  rowPrintBucket,
  searchLangFromPath,
  setPrintLang,
  setSearchLang,
  usePrintLang,
  useSearchLang,
} from '../locale.js';

function Icon({ d }) {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <path fill="currentColor" d={d} />
    </svg>
  );
}

/** Four portrait mini-cards (~6×9, ratio ≈0.67) — not an app-grid of squares. */
const DASHBOARD_CARDS_ICON =
  'M6 3h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm8 0h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM6 14h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zm8 0h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z';

const ICO = {
  market: 'M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zm-9 4H6v-4h6v4z',
  storefront: 'M21.9 8.89l-1.05-4.37c-.22-.9-1-1.52-1.91-1.52H5.05c-.9 0-1.69.63-1.9 1.52L2.1 8.89c-.24 1.02-.02 2.06.62 2.88.08.11.19.19.28.29V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-6.94c.09-.09.2-.18.28-.28.64-.82.87-1.87.62-2.89zm-2.99-3.9l1.05 4.37c.1.42.01.84-.25 1.17-.14.18-.44.47-.94.47-.61 0-1.14-.49-1.21-1.14L16.98 5l1.93-.01zM13 5h1.96l.54 4.52c.05.39-.07.78-.33 1.07-.22.26-.54.41-.95.41-.67 0-1.22-.59-1.22-1.31V5zM8.49 9.52L9.04 5H11v4.69c0 .72-.55 1.31-1.29 1.31-.34 0-.65-.15-.89-.41-.25-.29-.38-.68-.33-1.07zm-4.45-.16L5.05 5h1.97l-.58 4.86c-.08.65-.6 1.14-1.21 1.14-.49 0-.8-.29-.93-.47-.27-.32-.36-.75-.26-1.17zM5 19v-6.03c.08.01.15.03.23.03.87 0 1.66-.36 2.24-.95.6.6 1.4.95 2.31.95.87 0 1.65-.36 2.23-.93.59.57 1.39.93 2.29.93.84 0 1.64-.35 2.24-.95.58.59 1.37.95 2.24.95.08 0 .15-.02.23-.03V19H5z',
  search: 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  forum: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z',
  signal: 'M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z',
  dashboard: DASHBOARD_CARDS_ICON,
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
  const external = href || (to ? marketUrl(to) : '');
  // On dashboard.pokoin.com, marketUrl returns https://pokoin.com/… so leave the host.
  if (href || (to && String(external).startsWith('http'))) {
    return <a className="mobile-tile" href={external} onClick={onClick}>{body}</a>;
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

/** Same-origin NavLink, or absolute pokoin.com <a> when the SPA is on dashboard. */
function AppLink({ to, className, title, 'aria-label': ariaLabel, children }) {
  const href = marketUrl(to);
  if (String(href).startsWith('http')) {
    return (
      <a
        className={typeof className === 'function' ? className({ isActive: false }) : className}
        href={href}
        title={title}
        aria-label={ariaLabel}
        onClick={(event) => {
          event.preventDefault();
          goMarket(href);
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <NavLink className={className} to={to} title={title} aria-label={ariaLabel}>
      {children}
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
        aria-label={`Card title language, ${current.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current.label}
        onClick={() => setOpen((value) => !value)}
      >
        <img src={flagSrc(current.code)} alt="" width="40" height="40" />
      </button>
      {open ? (
        <ul className="lang-menu" role="listbox" aria-label="Card title language">
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

function PrintLangToggle() {
  const lang = usePrintLang();
  const current = printLangMeta(lang);
  const [open, setOpen] = useState(false);
  const box = useRef(null);

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

  return (
    <div className="print-lang-toggle" ref={box}>
      <button
        type="button"
        aria-label={`Card print language, ${current.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current.label}
        onClick={() => setOpen((value) => !value)}
      >
        <svg className="search-go-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
        </svg>
        <svg className="lang-caret" viewBox="0 0 12 8" width="10" height="7" aria-hidden="true">
          <path fill="currentColor" d="M1.2 1.5h9.6L6 6.8z" />
        </svg>
      </button>
      {open ? (
        <ul className="lang-menu" role="listbox" aria-label="Card print language">
          {PRINT_LANGS.map((item) => (
            <li key={item.code} role="option" aria-selected={item.code === lang}>
              <button type="button" className={item.code === lang ? 'is-active' : ''} onClick={() => { setPrintLang(item.code); setOpen(false); }}>
                {item.flag ? (
                  <img src={flagSrc(item.flag)} alt="" width="22" height="22" />
                ) : (
                  <svg className="print-lang-all" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                    <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
                  </svg>
                )}
                <span>{item.label}</span>
                <em>{item.tag || (item.flag ? item.flag.toUpperCase() : 'ALL')}</em>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function suggestThumbSrc(printing) {
  const card = cardFromAutocomplete(printing);
  if (isLiveStub(card) || isLiveStub(printing)) {
    return '';
  }
  return imageSrc(card, 'suggest');
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
  const { signedIn, admin, availablePkn, getBearer } = useAuth();
  const { count } = useCart();
  const { balance } = useWallet();
  const extensionDesk = framedByChromeExtension();
  const lang = useSearchLang();
  const printLang = usePrintLang();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [groups, setGroups] = useState([]);
  const [liveTick, setLiveTick] = useState(0);
  const [hitCount, setHitCount] = useState(0);
  const [pending, setPending] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const box = useRef(null);
  const inputRef = useRef(null);
  const suggestRef = useRef(null);
  const listRef = useRef(null);
  const queryRef = useRef('');
  const pokemonScheduled = useRef(new Set());
  const meiliControllers = useRef([]);
  const [pointerHoverId, setPointerHoverId] = useState(null);
  const [hoverBox, setHoverBox] = useState(null);
  const [searchTab, setSearchTab] = useState('singles');
  const [sellerHits, setSellerHits] = useState([]);
  const [messagesUnread, setMessagesUnread] = useState(0);
  const messagesAriaLabel = messagesUnread > 0 ? 'Messages, unread messages' : 'Messages';
  useWindowScrollRestore();
  const searchTabRef = useRef(searchTab);
  searchTabRef.current = searchTab;
  const printLangRef = useRef(printLang);
  printLangRef.current = printLang;
  const suggestRequestId = useRef(0);
  const catalogTab = searchTab === 'users' ? 'singles' : searchTab;
  const visibleGroups = useMemo(() => {
    if (!isPokemonGame()) {
      return groups;
    }
    if (!suggestLiveReady(query) || searchTab === 'users') {
      return [];
    }
    return liveSuggestGroups(query, { printLang, searchLang: lang, kind: catalogTab }).groups;
  }, [groups, liveTick, printLang, lang, query, searchTab, catalogTab]);
  const flat = flattenPrintings(visibleGroups);
  const activeOption = activeIndex >= 0 ? flat[activeIndex] : null;
  const previewOptionId = pointerHoverId || activeOption?.optionId || '';
  const hoverRow = previewOptionId
    ? flat.find((row) => row.optionId === previewOptionId)
    : null;
  const hoverCard = hoverRow && !isLiveStub(hoverRow.card)
    ? cardFromAutocomplete(hoverRow.card)
    : null;
  const hoverHero = hoverCard ? imageSrc(hoverCard, 'hero') : '';
  const hoverSrc = pickSuggestHoverSrc(hoverHero, hoverCard ? imageSrc(hoverCard, 'suggest') : '');
  const suggestIds = open
    ? flat.map((row) => String(row.card?.id || '')).join('|')
    : '';
  const suggestVisible = open && suggestLiveReady(query) && (
    isPokemonGame()
    || visibleGroups.length > 0
    || pending
  );
  useSuggestFlip(listRef, suggestVisible ? suggestIds : '');

  useEffect(() => {
    if (!visibleGroups.length) {
      return;
    }
    preloadSuggestThumbs(collectPrintingThumbUrls(visibleGroups, suggestThumbSrc), { first: true });
  }, [visibleGroups]);

  useEffect(() => {
    warmupSuggestRankWorkers();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const q = params.get('q');
    if (location.pathname === '/marketplace/search' && q) {
      setQuery(q);
    }
    if (location.pathname === '/marketplace/search') {
      setSearchTab(normalizeSearchTab(params.get('tab')));
    }
  }, [location.pathname, location.search]);

  useEffect(() => {
    setActiveIndex(-1);
  }, [searchTab, query]);

  useEffect(() => {
    if (!open || searchTab !== 'users' || !suggestLiveReady(query)) {
      setSellerHits([]);
      return;
    }
    const handle = query.trim();
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchSellerByUsername(handle, { limit: 20 })
        .then((data) => {
          if (!cancelled) {
            setSellerHits(Array.isArray(data?.listings) ? data.listings : []);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSellerHits([]);
          }
        });
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, searchTab]);

  // "View all N" count: the search-page payload total for this exact query +
  // tab — the same request the footer's submit destination renders, so
  // popupCount(Q) === totalCount(search(Q)) whenever the payload carries a
  // total (Product/SQL universe). Where it does not yet (singles rides the
  // Meili candidates window), the suggest payload's relaxed estimate stays
  // as the baseline instead of zeroing the footer.
  useEffect(() => {
    if (!open || !isPokemonGame() || searchTab === 'users' || !suggestLiveReady(query)) {
      return undefined;
    }
    const text = typedMeiliQuery(query).trim();
    if (text.length < 2) {
      return undefined;
    }
    const tabUsed = searchTab;
    const printUsed = printLang;
    let cancelled = false;
    prefetchSearchPage(text, lang, {
      fetchSearchPage: fetchSearch,
      tab: tabUsed,
      printLang: printUsed,
    })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        if (
          queryRef.current !== query.trim()
          || searchTabRef.current !== tabUsed
          || printLangRef.current !== printUsed
        ) {
          return;
        }
        const total = Number(payload?.total);
        if (Number.isFinite(total) && total > 0) {
          setHitCount(total);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, query, searchTab, lang, printLang]);

  useEffect(() => {
    const term = query.trim();
    queryRef.current = term;
    // Print / query identity changed — drop in-flight work so stale All
    // responses cannot race past a newer Western paint.
    for (const running of meiliControllers.current) {
      running.abort();
    }
    meiliControllers.current = [];
    pokemonScheduled.current.clear();
    if (!term) {
      setPending(false);
      setGroups([]);
      setHitCount(0);
      setActiveIndex(-1);
      return undefined;
    }

    const ready = suggestLiveReady(term);

    function rememberAndPaint(data, requestMeta = {}) {
      const requestPrint = requestMeta.printLang || 'all';
      const requestSeq = Number(requestMeta.seq) || 0;
      // Stale All responses must not overwrite a newer Western (etc.) paint.
      if (requestSeq && requestSeq !== suggestRequestId.current) {
        return;
      }
      if (requestPrint !== printLangRef.current) {
        return;
      }
      const remembered = data?.hydrated || data?.groups;
      rememberSuggestGroups(remembered);
      preloadSuggestThumbs(collectPrintingThumbUrls(remembered, suggestThumbSrc));
      const current = String(queryRef.current || '').trim();
      if (!isPokemonGame() || !suggestLiveReady(current)) {
        return;
      }
      setLiveTick((tick) => tick + 1);
      if (current !== term) {
        return;
      }
      // Suggest's relaxed estimate is the footer baseline; the search-page
      // prefetch effect below overrides it whenever the payload carries an
      // exact total.
      setHitCount(Number(data?.count) || 0);
      // Warm the "View all" destination so Enter is hot.
      prefetchSearchPage(data?.resolvedQuery || term, lang, {
        fetchSearchPage: fetchSearch,
        tab: searchTabRef.current,
        printLang: requestPrint,
      });
    }

    function hydrateCatalog(nextTerm) {
      const targets = [];
      const resolved = resolveSuggestQuery(nextTerm);
      if (resolved?.best) {
        for (const entity of resolved.best.entities.artist) {
          if (entity.slug) {
            targets.push({ key: `artist:${entity.slug}`, kind: 'artist', slug: entity.slug });
          }
        }
        for (const entity of resolved.best.entities.set) {
          if (entity.slug) {
            targets.push({ key: `set:${entity.slug}`, kind: 'set', slug: entity.slug });
          }
        }
      }
      const intent = catalogIntent(nextTerm);
      const legacyKey = catalogCacheKey(intent);
      if (legacyKey && intent.slug) {
        targets.push({ key: legacyKey, kind: intent.kind, slug: intent.slug });
      }
      const seen = new Set();
      for (const target of targets) {
        if (seen.has(target.key) || cachedPrintings(target.key).length) {
          continue;
        }
        seen.add(target.key);
        const needsHydration = () => {
          if (cachedPrintings(target.key).length) {
            return;
          }
          if (target.kind === 'artist') {
            fetchArtist(target.slug, { limit: 80 })
              .then((data) => {
                rememberPrintings(target.key, data.cards);
                rememberSuggestGroups(groupsFromCards(data.cards));
                preloadSuggestThumbs(collectPrintingThumbUrls(
                  groupsFromCards(data.cards),
                  suggestThumbSrc,
                ));
                const current = String(queryRef.current || '').trim();
                if (suggestLiveReady(current)) {
                  setLiveTick((tick) => tick + 1);
                }
              })
              .catch(() => {});
            return;
          }
          fetchExpansion({ slug: target.slug, limit: 48 })
            .then((data) => {
              const cards = data?.cards || [];
              rememberPrintings(target.key, cards);
              rememberSuggestGroups(groupsFromCards(cards));
              preloadSuggestThumbs(collectPrintingThumbUrls(
                groupsFromCards(cards),
                suggestThumbSrc,
              ));
              const current = String(queryRef.current || '').trim();
              if (suggestLiveReady(current)) {
                setLiveTick((tick) => tick + 1);
              }
            })
            .catch(() => {});
        };
        needsHydration();
      }
    }

    if (isPokemonGame()) {
      if (ready) {
        setActiveIndex(-1);
        hydrateCatalog(term);
      } else {
        setGroups([]);
        setPending(false);
        setHitCount(0);
        setActiveIndex(-1);
      }
      const kickKey = `${term}\0${lang}\0${printLang}\0${catalogTab}`;
      if (pokemonScheduled.current.has(kickKey)) {
        return undefined;
      }
      const start = () => {
        if (pokemonScheduled.current.has(kickKey)) {
          return;
        }
        pokemonScheduled.current.add(kickKey);
        const controller = new AbortController();
        meiliControllers.current.push(controller);
        const seq = (suggestRequestId.current += 1);
        const requestPrint = printLang;
        if (queryRef.current === term) {
          setPending(true);
        }
        fetchSuggestRanked(term, {
          fetchSuggest,
          fetchSearch,
          limit: 20,
          signal: controller.signal,
          lang,
          printLang: requestPrint,
          concurrency: rankConcurrency(),
          mapChunk: rankChunkOnWorker,
          kind: searchTabRef.current,
          resolved: resolveSuggestQuery(term),
        }).catch((error) => {
          if (error?.name === 'AbortError') {
            throw error;
          }
          return fetchSuggest(term, {
            limit: 20,
            signal: controller.signal,
            lang,
            printLang: requestPrint,
          })
            .then((data) => ({
              groups: Array.isArray(data.groups) ? data.groups : [],
              hydrated: data.groups,
              count: Number(data.count) || 0,
              resolvedQuery: term,
            }));
        }).then((data) => {
          rememberAndPaint(data, { printLang: requestPrint, seq });
        }).catch((error) => {
          if (error.name !== 'AbortError') {
            setActiveIndex(-1);
          }
        }).finally(() => {
          meiliControllers.current = meiliControllers.current.filter((row) => row !== controller);
          if (queryRef.current === term && printLangRef.current === requestPrint) {
            setPending(false);
          }
        });
      };
      if (pokemonScheduled.current.size === 0) {
        start();
        return undefined;
      }
      const timer = setTimeout(start, 40);
      return () => clearTimeout(timer);
    }

    if (!ready) {
      setPending(false);
      setGroups([]);
      setHitCount(0);
      setActiveIndex(-1);
      return undefined;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPending(true);
      fetchSuggest(term, { limit: 20, signal: controller.signal, lang, printLang })
        .then((data) => ({
          groups: Array.isArray(data.groups) ? data.groups : [],
          count: Number(data.count) || 0,
          resolvedQuery: term,
        }))
        .then((data) => {
          if (controller.signal.aborted) {
            return;
          }
          setGroups(data.groups);
          setHitCount(data.count);
          setActiveIndex(-1);
          prefetchSearchPage(data.resolvedQuery, lang, {
            fetchSearchPage: fetchSearch,
            signal: controller.signal,
            tab: searchTabRef.current,
          });
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
  }, [query, lang, printLang]);

  useEffect(() => {
    function onDoc(event) {
      const target = event.target;
      if (box.current && box.current.contains(target)) {
        return;
      }
      if (typeof target?.closest === 'function' && target.closest('.lang-toggle')) {
        return;
      }
      setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    if (!open) {
      setPointerHoverId(null);
    }
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !previewOptionId || !hoverSrc) {
      setHoverBox(null);
      return undefined;
    }
    function place() {
      if (!suggestHoverAllowed(window.innerWidth, window.matchMedia('(hover: hover)').matches)) {
        setHoverBox(null);
        return;
      }
      const panel = suggestRef.current;
      const row = document.getElementById(previewOptionId);
      if (!panel || !row) {
        setHoverBox(null);
        return;
      }
      const panelRect = panel.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      setHoverBox(suggestHoverBox({
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        panelLeft: panelRect.left,
        panelRight: panelRect.right,
        rowTop: rowRect.top,
        rowHeight: rowRect.height,
      }));
    }
    place();
    const list = suggestRef.current?.querySelector('.suggest-list');
    window.addEventListener('resize', place);
    list?.addEventListener('scroll', place, { passive: true });
    return () => {
      window.removeEventListener('resize', place);
      list?.removeEventListener('scroll', place);
    };
  }, [open, previewOptionId, hoverSrc, visibleGroups]);

  useEffect(() => {
    setMenu(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!signedIn) {
      setMessagesUnread(0);
      return undefined;
    }
    let active = true;
    const refresh = async () => {
      try {
        const token = await getBearer();
        if (!token) return;
        const result = await listConversations(token);
        if (active) setMessagesUnread(unreadMessagesCount(result?.conversations || []));
      } catch {
        /* unread dot is best-effort; never break the nav */
      }
    };
    refresh();
    const timer = setInterval(refresh, MESSAGES_UNREAD_REFRESH_MS);
    const onUnread = (event) => {
      if (typeof event?.detail?.count === 'number') setMessagesUnread(event.detail.count);
    };
    window.addEventListener(MESSAGES_UNREAD_EVENT, onUnread);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(MESSAGES_UNREAD_EVENT, onUnread);
    };
  }, [signedIn, getBearer]);

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
    const resolved = isPokemonGame() ? resolveSuggestQuery(next) : null;
    const resolvedParam = resolved ? serializeResolution(resolved) : '';
    const resolvedQuery = isPokemonGame()
      ? resolveSearchQuery(next, rankNames(next))
      : next;
    const prefetchQuery = isPokemonGame() ? typedMeiliQuery(next) : resolved;
    setOpen(false);
    setMenu(false);
    if (prefetchQuery) {
      prefetchSearchPage(prefetchQuery, lang, {
        fetchSearchPage: fetchSearch,
        tab: searchTab,
      });
    }
    navigate(searchHref(resolvedQuery, searchTab, resolvedParam));
  }

  function pick(card, rank) {
    if (isLiveStub(card)) {
      return;
    }
    const mapped = cardFromAutocomplete(card);
    if (isLiveStub(mapped)) {
      return;
    }
    setOpen(false);
    setQuery(mapped.name || '');
    track(Action.clickSuggest, mapped, { query, resultRank: rank });
    // Existing prefetch: warm the card-page payload (visualTheme included)
    // so the desk paints themed on arrival instead of recoloring later.
    warmupCard(mapped, { lang });
    navigate(cardHref(mapped), { state: { card: mapped } });
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
      if (isLiveStub(activeOption.card)) {
        goSearch(event);
        return;
      }
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
  // The chip is the signed-in member's spendable Site PKN; anonymous visitors
  // with a connected wallet still see their on-chain balance.
  const pknAmount = signedIn && Number.isFinite(availablePkn)
    ? availablePkn
    : (Number.isFinite(balance) ? balance : 0);
  const pknLabel = `${formatPknNumber(pknAmount)} PKN`;
  const site = game();
  const homeHref = marketUrl(site.homeHref || '/');
  const onDashboard = isDashboardHost();

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
          <AppLink className="brand" to="/marketplace" aria-label={site.title}>
            <img src="/home/logo.png" alt="" width="40" height="40" />
            <span>{site.brand}</span>
          </AppLink>
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
                placeholder={extensionDesk ? 'Search cards' : 'Search cards, sets, products...'}
                autoComplete="off"
                aria-expanded={suggestVisible}
                aria-controls="market-suggest"
                aria-activedescendant={activeOption ? activeOption.optionId : undefined}
                aria-autocomplete="list"
                aria-busy={suggestVisible && pending}
              />
              {isPokemonGame() ? <PrintLangToggle /> : null}
              <button className="sr-only" type="submit">Search</button>
            </div>
            {suggestVisible ? (
              <div
                className="suggest"
                id="market-suggest"
                ref={suggestRef}
                onMouseLeave={() => setPointerHoverId(null)}
              >
                {isPokemonGame() ? (
                  <SearchTabs
                    value={searchTab}
                    onChange={setSearchTab}
                    ariaLabel="Search type"
                  />
                ) : null}
                {searchTab === 'users' ? (
                  <ul className="suggest-list" role="listbox" aria-label="Seller suggestions">
                    {sellerHits.length ? (
                      uniqueSellers(sellerHits, query.trim()).map((seller) => (
                        <li key={seller.id}>
                          <button
                            type="button"
                            className="suggest-user"
                            onClick={() => {
                              setOpen(false);
                              navigate(sellerHref({ sellerName: seller.username }));
                            }}
                          >
                            <span className="suggest-user-mark" aria-hidden="true">
                              {seller.name.slice(0, 1).toUpperCase()}
                            </span>
                            <span className="suggest-copy">
                              <strong>{seller.name}</strong>
                              {seller.count ? (
                                <em>{seller.count} listing{seller.count === 1 ? '' : 's'}</em>
                              ) : null}
                            </span>
                          </button>
                        </li>
                      ))
                    ) : (
                      <li className="suggest-empty">
                        No sellers match “{query.trim()}”.
                      </li>
                    )}
                  </ul>
                ) : (
                <ul className="suggest-list" role="listbox" aria-label="Card suggestions" ref={listRef}>
                  {visibleGroups.length ? visibleGroups.map((group) => (
                      <li key={`${group.name}:${group.printings?.[0]?.id || ''}`} className="suggest-group">
                        <ul>
                          {(group.printings || []).map((printing) => {
                            const card = cardFromAutocomplete(printing);
                            const identity = printingIdentity(card);
                            const englishName = suggestCardName(card, group.name);
                            const artLayout = isPokemonGame()
                              ? resolveArtLayout({ ...card, name: englishName })
                              : 'window';
                            const landscapePrint = artLayout === 'landscape';
                            const bleedPrint = artLayout === 'bleed' || artLayout === 'item';
                            const suggestNumber = clipSuggestCollector(identity.number);
                            const translation = suggestTranslatedLine(card, group.name, suggestNumber);
                            const optionId = `suggest-${card.id}`;
                            const active = activeOption?.optionId === optionId;
                            const thumb = imageSrc(card, 'suggest');
                              const bucket = rowPrintBucket(card);
                              const printFlag = printFlagFromNationality(
                                bucket === 'unknown' ? '' : bucket,
                              );
                            const live = isLiveStub(card) || isLiveStub(printing);
                            const rowIndex = flat.findIndex((row) => row.optionId === optionId);
                            const thumbLoading = rowIndex >= SUGGEST_THUMB_EAGER ? 'lazy' : undefined;
                            const thumbPriority = rowIndex < SUGGEST_THUMB_HIGH ? 'high' : 'low';
                            return (
                              <li
                                key={card.id}
                                data-suggest-id={card.id}
                                role="option"
                                id={optionId}
                                aria-selected={active}
                                aria-disabled={live || undefined}
                                onMouseEnter={() => {
                                  if (live) {
                                    return;
                                  }
                                  setPointerHoverId(optionId);
                                  const hero = imageSrc(card, 'hero');
                                  if (hero) {
                                    const preload = new Image();
                                    preload.src = hero;
                                  }
                                }}
                              >
                                  <div className={`suggest-row${active ? ' is-active' : ''}`}>
                                  <button
                                    type="button"
                                    className="suggest-main"
                                    onClick={() => {
                                      if (live) {
                                        return;
                                      }
                                      pick(card, flat.findIndex((row) => row.optionId === optionId));
                                    }}
                                  >
                                    <span className="suggest-set" aria-hidden="true">
                                      <span className="set-shortcut is-on">
                                        <ExpansionMark
                                          setName={identity.set}
                                          symbolUrl={card.expansionSymbolUrl}
                                        />
                                      </span>
                                    </span>
                                    {thumb ? (
                                      <CardArt src={thumb} alt="" loading={thumbLoading} fetchPriority={thumbPriority} />
                                    ) : <span className="suggest-ph" />}
                                    <span className="suggest-copy">
                                      <span className="suggest-number">{suggestNumber}</span>
                                      <span className="suggest-copy-text">
                                        <strong>
                                          {englishName}
                                          {suggestNumber ? (
                                            <span className="suggest-num-phone"> - {suggestNumber}</span>
                                          ) : null}
                                        </strong>
                                        {translation ? (
                                          <span className="suggest-translated">{translation}</span>
                                        ) : null}
                                        {identity.suggestExpansionShort ? (
                                          <em title={identity.suggestExpansion}>{identity.suggestExpansionShort}</em>
                                        ) : null}
                                      </span>
                                    </span>
                                  </button>
                                  {isPokemonGame() && (thumb || printFlag) ? (
                                    <div className="suggest-art-cluster">
                                      {printFlag ? (
                                        <span className="suggest-print-flag">
                                          <img src={flagSrc(printFlag.code)} alt="" width="40" height="40" />
                                          <span className="sr-only">{printFlag.label}</span>
                                        </span>
                                      ) : null}
                                      {thumb ? (
                                      <button
                                        type="button"
                                        className={[
                                          'suggest-art',
                                          landscapePrint ? 'is-landscape' : '',
                                          bleedPrint && !landscapePrint ? 'is-bleed' : '',
                                        ].filter(Boolean).join(' ')}
                                        tabIndex={-1}
                                        aria-hidden="true"
                                        onClick={() => {
                                          if (live) {
                                            return;
                                          }
                                          pick(card, flat.findIndex((row) => row.optionId === optionId));
                                        }}
                                      >
                                        <CardArt src={thumb} card={card} cut={artLayout === 'window' || artLayout === 'halfart'} loading={thumbLoading} fetchPriority={thumbPriority} />
                                      </button>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </li>
                  )) : (
                    <li className="suggest-empty">
                      {pending
                        ? 'Searching…'
                        : searchTab === 'product'
                          ? `No products match “${query.trim()}”.`
                          : `No singles match “${query.trim()}”.`}
                    </li>
                  )}
                </ul>
                )}
                {query.trim().length >= 2 && searchTab !== 'users' ? (
                  <button className="suggest-all" type="submit">
                    {hitCount > 0
                      ? `View all ${hitCount.toLocaleString('en-US')} results`
                      : `View all results for “${query.trim()}”`}
                  </button>
                ) : null}
              </div>
            ) : null}
          </form>
          <LangToggle />
          <nav className="nav icon-nav" aria-label="Marketplace">
            <AppLink to="/marketplace" title="Marketplace" aria-label="Marketplace">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d={ICO.storefront} /></svg>
            </AppLink>
            <AppLink className="messages-link" to={APP.messages} title="Messages" aria-label={messagesAriaLabel}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-5 4V6a2 2 0 0 1 2-2Zm2 5v2h12V9H6Zm0 4v2h8v-2H6Z" /></svg>
              {messagesUnread > 0 ? <span className="messages-unread-dot" aria-hidden="true" /> : null}
            </AppLink>
            <a href={onDashboard ? '/' : DASHBOARD_HOME} title="Dashboard" aria-label="Dashboard">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d={ICO.dashboard} /></svg>
            </a>
            {site.features.competitive ? (
              <AppLink className="trophy" to="/marketplace/competitive" title="Competitive" aria-label="Competitive">
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94A5.01 5.01 0 0 0 11 17.9V19H7v2h10v-2h-4v-1.1a5.01 5.01 0 0 0 3.61-4.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z" /></svg>
              </AppLink>
            ) : null}
            <AppLink className="pkn-chip" to="/wallet" title="Wallet">{pknLabel}</AppLink>
            <AppLink to={signedIn ? '/profile' : from} title={signedIn ? 'Profile' : 'Sign in'} aria-label={signedIn ? 'Profile' : 'Sign in'}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" /></svg>
            </AppLink>
            <AppLink className="cart-chip" to="/cart" title="Cart" aria-label={`Cart, ${count} items`}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1 1 0 0 0 20 4H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z" /></svg>
              <em>{count}</em>
            </AppLink>
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
        <MobileTile to={APP.messages} label="Messages" icon="forum" onClick={closeMenu} />
        <MobileTile href={onDashboard ? '/' : DASHBOARD_HOME} label="Dashboard" icon="dashboard" onClick={closeMenu} />
        {site.features.competitive ? (
          <MobileTile to="/marketplace/competitive" label="Competitive" icon="trophy" onClick={closeMenu} />
        ) : null}
        <MobileTile to="/marketplace/explore" label="Explore" icon="explore" onClick={closeMenu} />
        <MobileTile to="/marketplace/portfolio" label="Portfolio" icon="portfolio" onClick={closeMenu} />
        <MobileTile to="/marketplace/sets" label="Sets" icon="sets" onClick={closeMenu} />
        <MobileTile to={`/marketplace/${lang}/pokemon`} label="Pokémon" icon="sets" onClick={closeMenu} />
        <MobileTile to={`/marketplace/${lang}/artists`} label="Artists" icon="sets" onClick={closeMenu} />
        {isPokemonGame() ? <CatalogMenu lang={lang} variant="mobile" onNavigate={closeMenu} /> : null}
        <MobileTile to="/marketplace/watchlist" label="Watchlist" icon="watch" onClick={closeMenu} />
        <MobileTile to={APP.wallet} label="Wallet" icon="wallet" onClick={closeMenu} />
        <MobileTile to={APP.buy} label="Buy PKN" icon="buy" onClick={closeMenu} />
        <MobileTile to={APP.cart} label="Cart" icon="cart" onClick={closeMenu} />
        <MobileTile to="/checkout" label="Checkout" icon="checkout" onClick={closeMenu} />
        <MobileTile to="/orders" label="Orders" icon="orders" onClick={closeMenu} />
        <MobileTile to="/collection" label="Collection" icon="nft" onClick={closeMenu} />
        <MobileTile to={APP.profile} label="Profile" icon="profile" onClick={closeMenu} />
        {admin ? <MobileTile to={APP.admin} label="Admin" icon="admin" onClick={closeMenu} /> : null}
        {signedIn ? null : <MobileTile to={from} label="Sign in" icon="signin" onClick={closeMenu} />}
      </nav>
      <main>{children}</main>
      <footer className="foot">
        <div className="foot-grid">
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
            <AppLink to={`/marketplace/${lang}/pokemon`}>Pokémon</AppLink>
            <AppLink to={`/marketplace/${lang}/artists`}>Artists</AppLink>
            {isPokemonGame() ? <CatalogMenu lang={lang} /> : null}
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
            <AppLink to="/collection">Collection</AppLink>
            <AppLink to={APP.profile}>Profile</AppLink>
            {admin ? <AppLink to={APP.admin}>Admin</AppLink> : null}
            {signedIn ? null : <AppLink to={from}>Sign in</AppLink>}
          </div>
          <div>
            <h3>More</h3>
            <a href={marketUrl('/')}>Home</a>
            <AppLink to={APP.forum}>Forum</AppLink>
            <a href={onDashboard ? '/' : DASHBOARD_HOME}>Dashboard</a>
            <AppLink to={APP.docs}>Docs</AppLink>
            <AppLink to={APP.about}>About</AppLink>
            <AppLink to={APP.careers}>Careers</AppLink>
            <AppLink to={APP.privacy}>Privacy</AppLink>
            <AppLink to={APP.emailPreferences}>Email preferences</AppLink>
            <AppLink to={APP.protection}>Buyer protection</AppLink>
            <AppLink to={APP.scan}>Scan</AppLink>
          </div>
        </div>
      </footer>
      {open && hoverSrc && hoverBox
        ? createPortal(
          <div
            className="suggest-hover"
            style={{
              left: `${hoverBox.left}px`,
              top: `${hoverBox.top}px`,
              width: `${hoverBox.width}px`,
              height: `${hoverBox.height}px`,
            }}
            aria-hidden="true"
          >
            <CardArt src={hoverSrc} full={Boolean(hoverHero)} alt="" />
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}
