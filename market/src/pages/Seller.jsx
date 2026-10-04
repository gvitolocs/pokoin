import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { fetchSellerShop } from '../api.js';
import { rewriteCanonicalCardPath } from '../card-stub.js';
import { cartItemFromOffer, useCart } from '../cart.jsx';
import { getSearchLang } from '../locale.js';
import ShopList from '../components/ShopList.jsx';
import ShopListingRow from '../components/ShopListing.jsx';
import { listingSelectId, shopDragOffers } from '../shop-marquee.js';
import { Alert, EmptyDesk, Metric, MetricGrid } from '../components/Desk.jsx';
import {
  publicListingSellerName,
  sellerCountryFlag,
  sellerCountryShort,
  sellerHandle,
} from '../listing-meta.js';
import { rememberSellerIdentity, seedSellerListings, sellerIdentitySeed } from '../seller-seed.js';
import { game } from '../game.js';
import { associateRoleLabel } from '../associate-roles.js';
import Avatar from '../components/Avatar.jsx';
import { safeAvatarUrl } from '../avatar.js';
import { filterSellerBook } from '../seller-shop-filter.js';

const PAGE_SIZE = 100;

const CONDITION_FILTERS = [
  { value: '', label: 'Any condition' },
  { value: 'NM', label: 'Near Mint' },
  { value: 'SP', label: 'Slightly Played' },
  { value: 'MP', label: 'Moderately Played' },
  { value: 'PL', label: 'Played' },
  { value: 'Poor', label: 'Poor' },
];

const LANG_FILTERS = ['', 'EN', 'IT', 'JP', 'DE', 'FR', 'ES', 'KR', 'PT', 'NL', 'PL', 'RU', 'ZH'];

const RARITY_FILTERS = [
  { value: '', label: 'Any rarity' },
  { value: 'holo', label: 'Holo' },
  { value: 'common', label: 'Common' },
  { value: 'uncommon', label: 'Uncommon' },
  { value: 'rare', label: 'Rare' },
  { value: 'ultra', label: 'Ultra Rare' },
  { value: 'illustration', label: 'Illustration Rare' },
  { value: 'secret', label: 'Secret Rare' },
];

function ShopToggle({ label, pressed, onToggle }) {
  return (
    <button
      type="button"
      className={`shop-toggle${pressed ? ' on' : ''}`}
      aria-pressed={pressed}
      onClick={() => onToggle(!pressed)}
    >
      {label}
    </button>
  );
}
function isOneDayReady(offer) {
  return Boolean(
    offer?.oneDayReady ||
      offer?.one_day_ready ||
      offer?.shippingMode === 'one_day_ready',
  );
}

function sellerFromPayload(data, handle, sample, previous = null) {
  const row = data?.seller && typeof data.seller === 'object' ? data.seller : null;
  const username = String(row?.username || sellerHandle(sample) || previous?.username || handle || '')
    .trim()
    .replace(/^@/, '');
  const rawName = String(row?.displayName || publicListingSellerName(sample, username || handle) || '')
    .trim();
  const known = sellerIdentitySeed(handle);
  const apiName = rawName && !rawName.includes('@') && rawName.toLowerCase() !== username.toLowerCase()
    ? rawName
    : '';
  // Book/fresh paths often send sellerUid with an empty photo and the
  // username as displayName — keep whatever the first page or chat already painted.
  const displayName = apiName || known?.displayName || previous?.displayName || username || handle;
  const associateRow = row?.associate && typeof row.associate === 'object' ? row.associate : null;
  const associateRole = String(associateRow?.role || '').trim().toLowerCase();
  return {
    uid: row?.uid || sample?.sellerUid || known?.uid || previous?.uid || '',
    username,
    displayName,
    photoUrl: safeAvatarUrl(row?.photoUrl) || known?.photoUrl || previous?.photoUrl || '',
    associate: associateRole
      ? { role: associateRole, displayName: String(associateRow.displayName || '').trim() }
      : (previous?.associate || null),
  };
}

export default function Seller() {
  const { username = '', lang: routeLang } = useParams();
  const [searchParams] = useSearchParams();
  const { addItem } = useCart();
  const { user, profile } = useAuth();
  const lang = routeLang || getSearchLang();
  const handle = decodeURIComponent(String(username || '').trim());
  const hintedUid = String(searchParams.get('sellerUid') || '').trim();
  const selectedGame = game().apiGame;
  const seeded = seedSellerListings(handle, {
    pageSize: PAGE_SIZE,
    sort: 'price-asc',
    game: selectedGame,
  });
  const known = sellerIdentitySeed(handle);

  const [listings, setListings] = useState(() => seeded?.listings ?? null);
  const [total, setTotal] = useState(() => seeded?.total ?? null);
  const [unique, setUnique] = useState(() => seeded?.unique ?? null);
  const [seller, setSeller] = useState(() => seeded?.seller ?? known ?? {
    uid: hintedUid,
    username: handle,
    displayName: handle,
  });
  const sellerUidRef = useRef(hintedUid || seeded?.seller?.uid || known?.uid || '');
  const listingsRef = useRef(seeded?.listings ?? null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [condition, setCondition] = useState('');
  const [language, setLanguage] = useState('');
  const [rarity, setRarity] = useState('');
  const [reverse, setReverse] = useState(false);
  const [firstEdition, setFirstEdition] = useState(false);
  const [sort, setSort] = useState('price-asc');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(!seeded);
  const [book, setBook] = useState(null);
  const [bookPhase, setBookPhase] = useState('idle');
  const [pageSettled, setPageSettled] = useState(() => Boolean(seeded));
  listingsRef.current = listings;
  if (seller.uid) sellerUidRef.current = seller.uid;
  else if (hintedUid) sellerUidRef.current = hintedUid;

  useEffect(() => {
    if (!hintedUid) return;
    sellerUidRef.current = hintedUid;
    rememberSellerIdentity(handle, { uid: hintedUid, username: handle });
    setSeller((current) => (current.uid ? current : { ...current, uid: hintedUid }));
  }, [hintedUid, handle]);

  useEffect(() => {
    setPage(1);
  }, [query, condition, language, rarity, reverse, firstEdition, sort, handle, selectedGame]);

  useEffect(() => {
    document.title = `${seller.displayName || handle} · Pokoin`;
  }, [seller.displayName, handle]);

  useEffect(() => {
    if (!handle || !pageSettled) return undefined;
    let cancelled = false;
    setBook(null);
    setBookPhase('loading');
    fetchSellerShop(handle, { book: true, game: selectedGame, sellerUid: sellerUidRef.current })
      .then((data) => {
        if (cancelled) return;
        if (!data?.book || !Array.isArray(data.listings)) {
          setBookPhase('server');
          return;
        }
        setBook(data);
        setBookPhase('ready');
        setSeller((current) => sellerFromPayload(data, handle, data.listings[0], current));
      })
      .catch(() => {
        if (!cancelled) setBookPhase('server');
      });
    return () => {
      cancelled = true;
    };
  }, [handle, selectedGame, pageSettled]);

  useEffect(() => {
    if (!book?.seller?.uid) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchSellerShop(handle, { fresh: true, sellerUid: book.seller.uid, game: selectedGame })
        .then((stamp) => {
          const next = String(stamp?.maxUpdatedAt || '');
          const prev = String(book.maxUpdatedAt || '');
          if (cancelled || !next || next === prev) return null;
          return fetchSellerShop(handle, { book: true, game: selectedGame, sellerUid: book.seller.uid });
        })
        .then((data) => {
          if (cancelled || !data?.book || !Array.isArray(data.listings)) return;
          setBook(data);
          setSeller((current) => sellerFromPayload(data, handle, data.listings[0], current));
        })
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [book, handle, selectedGame, query, condition, language, rarity, reverse, firstEdition, sort]);

  useEffect(() => {
    const filtersNarrow = Boolean(
      query.trim()
      || condition
      || language
      || rarity
      || reverse
      || firstEdition
      || (sort && sort !== 'price-asc')
      || page > 1
    );
    // First page still comes from the small query. A filter click while the
    // full shop is downloading waits for that book instead of asking again.
    if (!handle || book || (bookPhase === 'loading' && filtersNarrow)) {
      if (handle) setPageSettled(true);
      return undefined;
    }
    let cancelled = false;
    const warm = !filtersNarrow && listingsRef.current != null;
    if (!warm) setLoading(true);
    const offset = (Math.max(1, page) - 1) * PAGE_SIZE;
    fetchSellerShop(handle, {
      limit: PAGE_SIZE,
      offset,
      q: query.trim(),
      condition,
      language,
      rarity,
      reverse,
      firstEdition,
      sort,
      game: selectedGame,
      sellerUid: sellerUidRef.current,
    })
      .then((data) => {
        if (cancelled) return;
        const rows = data.listings || data.items || [];
        setListings(rows);
        setSeller((current) => sellerFromPayload(data, handle, rows[0], current));
        setTotal(Number(data.total ?? rows.length) || 0);
        setUnique(
          Number(
            data.unique ??
              data.uniqueCards ??
              new Set(rows.map((r) => String(r.cardId || r.card_id || '')).filter(Boolean)).size,
          ) || 0,
        );
        setError('');
        setLoading(false);
        setPageSettled(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setPageSettled(true);
        if (warm) {
          setLoading(false);
          return;
        }
        setListings([]);
        setTotal(0);
        setUnique(0);
        setError(err.message || 'Seller not found.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [book, bookPhase, handle, page, query, condition, language, rarity, reverse, firstEdition, sort, selectedGame]);

  const filtersNarrow = Boolean(
    query.trim()
    || condition
    || language
    || rarity
    || reverse
    || firstEdition
    || (sort && sort !== 'price-asc')
    || page > 1
  );
  const bookView = useMemo(() => (
    book?.listings
      ? filterSellerBook(book.listings, {
        q: query.trim(),
        condition,
        language,
        rarity,
        reverse,
        firstEdition,
        sort,
      })
      : null
  ), [book, query, condition, language, rarity, reverse, firstEdition, sort]);
  const shownOffset = (Math.max(1, page) - 1) * PAGE_SIZE;
  const shown = bookView ? bookView.rows.slice(shownOffset, shownOffset + PAGE_SIZE) : listings;
  const shownTotal = bookView ? bookView.rows.length : total;
  const shownUnique = bookView ? bookView.unique : unique;
  const busy = bookView ? false : (loading || (bookPhase === 'loading' && filtersNarrow));

  const sample = shown?.[0];
  const display = seller.displayName || publicListingSellerName(sample, handle);
  const tag = seller.username || sellerHandle(sample) || handle;
  const showTag = tag && tag.toLowerCase() !== String(display || '').toLowerCase();
  const country = sellerCountryFlag(sample?.sellerCountry);
  const countryShort = sellerCountryShort(sample?.sellerCountry);
  const ready = useMemo(() => Boolean((shown || []).some(isOneDayReady)), [shown]);

  const totalItems = shownTotal ?? 0;
  const uniqueItems = shownUnique ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE) || 1);
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIdx = totalItems ? (safePage - 1) * PAGE_SIZE + 1 : 0;
  const endIdx = Math.min(safePage * PAGE_SIZE, totalItems);

  if (shown && !shown.length && error && totalItems === 0 && !busy) {
    return (
      <EmptyDesk title="Seller not found" lede={error}>
        <p className="status">Usernames match live native listings.</p>
      </EmptyDesk>
    );
  }

  // Your own shop is managed in MyPokoin, not bought from.
  const ownHandle = String(profile?.username || '').trim().toLowerCase();
  const isOwnShop = Boolean(
    (ownHandle && ownHandle === handle.replace(/^@/, '').toLowerCase())
    || (user?.uid && seller.uid && seller.uid === user.uid),
  );
  if (isOwnShop) return <Navigate to="/mypokoin" replace />;

  return (
    <div className="page desk seller-page seller-shop-ct">
      <header className="seller-hero seller-hero-ct">
        {seller.photoUrl ? (
          <Avatar
            className="seller-avatar"
            src={seller.photoUrl}
            seed={seller.uid}
            name={display}
            size={88}
          />
        ) : (
          <span className="seller-avatar" aria-hidden="true">
            {(display || '?').slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="seller-id">
          <p className="page-kicker">Seller</p>
          <h1 className="page-title">
            {display}
            {seller.associate?.role ? (
              <span className={`seller-associate-badge is-${seller.associate.role}`}>{associateRoleLabel(seller.associate.role)}</span>
            ) : null}
          </h1>
          {showTag ? <p className="seller-handle">@{tag}</p> : null}
          <div className="seller-hero-meta">
            {country && countryShort ? (
              <p className="seller-country">
                {country.emoji ? (
                  <span aria-hidden="true">{country.emoji}</span>
                ) : country.src ? (
                  <img src={country.src} alt="" width="22" height="22" />
                ) : null}
                <span>({countryShort})</span>
              </p>
            ) : null}
            {ready ? <span className="seller-badge seller-badge-ready">1-Day Ready</span> : null}
          </div>
        </div>
      </header>

      <MetricGrid>
        <Metric value={shown == null ? '…' : totalItems} label="Total items" />
        <Metric value={shown == null ? '…' : uniqueItems} label="Unique items" />
      </MetricGrid>

      <Alert>{error && shown?.length ? error : ''}</Alert>

      <section className="panel shop-panel shop-terminal seller-shop-panel">
        <header className="panel-head shop-head">
          <h2>Shop</h2>
        </header>

        <div className="shop-toolbar seller-shop-tools" role="search">
          <input
            className="shop-search"
            type="search"
            placeholder="Search listings…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search listings"
            disabled={shown == null}
          />
          <div className="shop-find">
            <select
              aria-label="Condition"
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
              disabled={shown == null}
            >
              {CONDITION_FILTERS.map((opt) => (
                <option key={opt.value || 'any'} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={shown == null}
            >
              {LANG_FILTERS.map((code) => (
                <option key={code || 'any'} value={code}>
                  {code || 'Any language'}
                </option>
              ))}
            </select>
            <select
              aria-label="Rarity"
              value={rarity}
              onChange={(e) => setRarity(e.target.value)}
              disabled={shown == null}
            >
              {RARITY_FILTERS.map((opt) => (
                <option key={opt.value || 'any-rarity'} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <ShopToggle label="Reverse" pressed={reverse} onToggle={setReverse} />
            <ShopToggle label="1st Ed." pressed={firstEdition} onToggle={setFirstEdition} />
            <select
              aria-label="Sort"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              disabled={shown == null}
            >
              <option value="price-asc">Price: low</option>
              <option value="price-desc">Price: high</option>
              <option value="name">Name</option>
              <option value="qty">Quantity</option>
            </select>
          </div>
        </div>

        <p className="seller-result-count">
          {shown == null || busy ? (
            'Loading…'
          ) : totalItems ? (
            <>
              Showing <strong>{startIdx}</strong>–<strong>{endIdx}</strong> of{' '}
              <strong>{totalItems}</strong>
            </>
          ) : (
            'No matching listings'
          )}
        </p>

        {shown == null ? (
          <div
            className="shop-list seller-shop-list"
            aria-busy="true"
            aria-label="Loading listings"
          >
            {Array.from({ length: 8 }, (_, index) => (
              <div className="shop-row is-profile shop-row-skel" key={index} aria-hidden="true">
                <span className="shop-card">
                  <span className="shop-art shop-skel-art" />
                  <span className="shop-skel-copy">
                    <span className="skeleton-line" />
                    <span className="skeleton-line short" />
                  </span>
                </span>
                <span className="shop-facets">
                  <span className="skeleton-line shop-skel-facet" />
                  <span className="skeleton-line shop-skel-price" />
                </span>
              </div>
            ))}
          </div>
        ) : shown.length ? (
          <ShopList className="seller-shop-list" offers={shown}>
            {(selected) => shown.map((offer, index) => {
              const cardId = String(offer.cardId || offer.card_id || '');
              const path = rewriteCanonicalCardPath(
                offer.canonicalPath || offer.canonical_path || '',
                cardId,
                lang,
              );
              const enriched = {
                ...offer,
                canonicalPath: path || offer.canonicalPath || '',
              };
              const cardStub = {
                id: cardId,
                name: offer.cardName || offer.name || 'Card',
                canonicalPath: path || `/marketplace/${lang || 'en'}/cards/${cardId}`,
                imageUrl: offer.cardImageUrl || offer.imageUrl || offer.image_url || '',
                homepageImageUrl: offer.homepageImageUrl || offer.homepage_image_url || '',
                gridImageUrl: offer.gridImageUrl || offer.grid_image_url || '',
              };
              return (
                <ShopListingRow
                  key={offer.id || `${cardId}-${index}`}
                  offer={enriched}
                  card={cardStub}
                  showCard
                  selected={selected.has(listingSelectId(enriched))}
                  dragOffers={shopDragOffers(shown, selected, enriched)}
                  onCart={(qty) => {
                    if (!cardId || !offer.id) return;
                    const item = cartItemFromOffer(cardStub, enriched);
                    addItem(qty ? { ...item, qty } : item);
                  }}
                />
              );
            })}
          </ShopList>
        ) : !busy ? (
          <EmptyDesk title="No listings" lede={`${display} has no live asks for these filters.`} />
        ) : null}

        {totalItems > PAGE_SIZE ? (
          <div className="seller-pager">
            <button
              type="button"
              className="btn ghost"
              disabled={safePage <= 1 || busy}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <span className="seller-pager-status">
              Page {safePage} / {totalPages}
            </span>
            <button
              type="button"
              className="btn ghost"
              disabled={safePage >= totalPages || busy}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
